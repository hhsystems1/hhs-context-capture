import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissionControlStore } from "../../mission-control/src/store.js";
import { assertLocalDatabaseUrl } from "./config.js";
import { loadReconstructionInventory } from "./reconstruction-inventory.js";

export const LOOPBACK_HOST = "127.0.0.1";
const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OPERATION = /^operation_[0-9a-f]{32}$/;
const hash = (value: string) => createHash("sha256").update(value).digest();
export interface OperationsConfig { port: number; clients: { name: string; digest: Buffer }[] }
export interface LaunchInput { limit: number; conversation?: string }
export interface Operation { operation_id: string; workspace: string; started_at: string; finished_at?: string; termination?: "exited" | "spawn_failed"; exit_code?: number | null }
export interface OperationsDeps {
  status(workspace: string): Promise<{ memory: unknown; reconstruction: unknown }>;
  receipts(workspace: string): Record<string, unknown>[];
  operations(workspace: string): Operation[];
  save(operation: Operation): void;
  acquire(operation: Operation): void;
  release(operation: Operation): void;
  launch(executable: string, args: string[], options: { cwd: string; shell: false; stdio: "ignore" }): ChildProcess;
}
class OperationsError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export function loadOperationsConfig(env: Record<string, string | undefined>): OperationsConfig {
  if (["MEMORY_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS", "MEMORY_PROVISIONING_SERVICE_TOKENS"].some(key => env[key]?.trim())) throw new Error("Context Operations requires a separate environment without admin, reviewer, query or provisioning credentials.");
  for (const [key, login] of [["MEMORY_REPORT_DATABASE_URL", "memory_v1_report_login"], ["MEMORY_INGEST_DATABASE_URL", "memory_v1_ingest_login"]]) {
    try {
      const url = assertLocalDatabaseUrl(env[key!] ?? "");
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.username !== login) throw new Error();
    } catch { throw new Error("Context Operations requires existing loopback report and ingest credentials; no admin fallback."); }
  }
  const port = Number(env.MEMORY_CONTEXT_OPERATIONS_PORT ?? 54433);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Context Operations port.");
  const clients = (env.MEMORY_CONTEXT_OPERATIONS_TOKENS ?? "").split(",").filter(Boolean).map(entry => {
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (separator < 1 || !/^[a-z0-9_-]{2,32}$/.test(name) || token.length < 32) throw new Error("Invalid Context Operations named token configuration.");
    return { name, digest: hash(token) };
  });
  if (!clients.length || new Set(clients.map(c => c.name)).size !== clients.length || new Set(clients.map(c => c.digest.toString("hex"))).size !== clients.length) throw new Error("Context Operations requires unique named tokens.");
  return { port, clients };
}
export function parseLaunchInput(value: unknown): LaunchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationsError(400, "invalid_body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["limit", "conversation"].includes(key))) throw new OperationsError(400, "invalid_body");
  const limit = body.limit === undefined ? 10 : body.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new OperationsError(400, "invalid_body");
  if (body.conversation !== undefined && (typeof body.conversation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.conversation))) throw new OperationsError(400, "invalid_body");
  return { limit, ...(typeof body.conversation === "string" ? { conversation: body.conversation } : {}) };
}
function latest<T>(values: T[], stamp: (value: T) => string, identity: (value: T) => string): T | undefined {
  return [...values].sort((a, b) => stamp(b).localeCompare(stamp(a)) || identity(b).localeCompare(identity(a)))[0];
}
function counts(value: unknown, keys: string[]): Record<string, number | null> {
  if (!value || typeof value !== "object") throw new Error("Unavailable summary");
  const row = value as Record<string, unknown>;
  return Object.fromEntries(keys.map(key => {
    const number = row[key];
    if (!(key === "next_batch" && number === null) && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)) throw new Error("Unavailable count");
    return [key, number];
  }));
}
const INVENTORY_KEYS = ["total_clean_conversations", "discovery_processed", "unprocessed", "awaiting_reconciliation", "observations_awaiting_reconciliation", "reconciled", "evidence_issues", "zero_evidence", "needs_review", "other_evidence_issues", "batches_total", "batches_complete", "batches_partial", "remaining_conversations", "next_batch"];
export function createContextOperationsService(config: OperationsConfig, deps: OperationsDeps): http.Server {
  const active = new Map<string, Operation>();
  const live = new Set<string>();
  async function status(workspace: string) {
    const summary = await deps.status(workspace);
    const memory = counts(summary.memory, ["messages", "blocks", "proposed", "approved"]);
    const reconstruction = counts(summary.reconstruction, INVENTORY_KEYS);
    const operation = active.get(workspace) ?? latest(deps.operations(workspace), o => o.started_at, o => o.operation_id);
    const receipts = deps.receipts(workspace);
    const receipt = operation ? receipts.find(r => r.operation_id === operation.operation_id) : latest(receipts, r => String(r.started_at), r => String(r.operation_id ?? r.receipt_identity));
    let state = "idle";
    if (active.has(workspace)) state = live.has(workspace) ? "running" : "unknown";
    else if (operation && !operation.termination) state = "interrupted";
    else if (operation?.termination === "spawn_failed") state = "failed";
    else if (operation?.termination === "exited" && !receipt && operation.exit_code !== 0 && operation.exit_code !== 2) state = "failed";
    else if (receipt && ["completed", "partial", "failed"].includes(String(receipt.status))) state = String(receipt.status);
    else if (operation || receipt) state = "interrupted";
    const fields: Record<string, unknown> = {};
    if (receipt) {
      if (receipt.schema_version !== "hhs-reconstruction-batch/0.1.0") throw new Error("Unsupported batch receipt");
      for (const key of ["requested", "selected"]) {
        if (!Number.isSafeInteger(receipt[key]) || Number(receipt[key]) < 0) throw new Error("Invalid batch receipt");
        fields[key] = receipt[key];
      }
      if (!Array.isArray(receipt.completed) || !Array.isArray(receipt.quarantined)) throw new Error("Invalid batch receipt");
      fields.completed_count = receipt.completed.length;
      fields.quarantined_count = receipt.quarantined.length;
      fields.prepared_artifact_review_required = receipt.quarantined.some(item => item && typeof item === "object" && typeof item.reason === "string" && (item.reason.includes("prepared_source_identity_mismatch") || item.reason.includes("Discovery exchange does not match current trusted database evidence")));
      for (const key of ["started_at", "finished_at"]) if (typeof receipt[key] === "string" && Number.isFinite(Date.parse(receipt[key]))) fields[key] = receipt[key];
    }
    return { workspace_id: workspace, state, available: true, ...fields,
      ...(operation ? { operation_id: operation.operation_id, started_at: operation.started_at, ...(operation.finished_at ? { process_finished_at: operation.finished_at } : {}), ...(operation.termination ? { process_termination: operation.termination, process_exit_code: operation.exit_code ?? null } : {}) } : {}), memory, reconstruction };
  }
  return http.createServer(async (request, response) => {
    const json = (code: number, body: unknown) => { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); };
    let workspace: string | undefined;
    try {
      const address = request.socket.remoteAddress;
      const port = (response.socket?.localPort ?? config.port);
      if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(address ?? "") || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) return json(403, { error: "loopback_only" });
      const auth = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
      if (!auth || !config.clients.some(c => timingSafeEqual(c.digest, hash(auth[1]!)))) return json(401, { error: "invalid_or_missing_token" });
      const route = /^\/memory\/workspaces\/(workspace_[0-9a-f]{32})\/reconstruction\/(status|start|resume)$/.exec(request.url ?? "");
      if (!route || (route[2] === "status" ? request.method !== "GET" : request.method !== "POST")) return json(404, { error: "unknown_route" });
      workspace = route[1]!;
      if (route[2] === "status") {
        if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) throw new OperationsError(400, "invalid_body");
        return json(200, await status(workspace));
      }
      if (request.headers["content-type"] !== "application/json") throw new OperationsError(400, "invalid_body");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new OperationsError(413, "body_too_large"); chunks.push(chunk); }
      let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new OperationsError(400, "invalid_body"); }
      const input = parseLaunchInput(body);
      if (active.has(workspace)) return json(409, { error: "operation_active", workspace_id: workspace, operation_id: active.get(workspace)!.operation_id });
      // Verify reporting is available before authorizing execution. Never infer zeros.
      const prior = await status(workspace);
      if (["running", "unknown", "interrupted"].includes(prior.state)) throw new OperationsError(409, "execution_active_or_unresolved");
      const operation: Operation = { workspace, operation_id: `operation_${randomUUID().replaceAll("-", "")}`, started_at: new Date().toISOString() };
      deps.acquire(operation); // atomic durable exclusion, including across service restarts
      deps.save(operation);
      active.set(workspace, operation);
      const finish = (termination: NonNullable<Operation["termination"]>, code: number | null) => {
        if (operation.termination) return;
        operation.termination = termination;
        operation.exit_code = code;
        operation.finished_at = new Date().toISOString();
        active.delete(operation.workspace);
        live.delete(operation.workspace);
        try {
          deps.save(operation);
          if (termination === "spawn_failed" || code === 0 || code === 2
            || !deps.receipts(operation.workspace).some(receipt => receipt.operation_id === operation.operation_id)) deps.release(operation);
        } catch { /* durable lock remains fail closed */ }
      };
      try {
        const args = ["scripts/run-reconstruction-batch.mjs", "--workspace", workspace, "--limit", String(input.limit), "--operation-id", operation.operation_id, ...(input.conversation ? ["--conversation", input.conversation] : [])];
        const child = deps.launch(process.execPath, args, { cwd: ROOT, shell: false, stdio: "ignore" });
        child.once("spawn", () => { if (!operation.termination) live.add(operation.workspace); });
        child.once("error", () => finish("spawn_failed", null));
        child.once("exit", () => live.delete(operation.workspace));
        // Unexpected termination with a correlated receipt retains durable exclusion.
        child.once("close", code => finish("exited", code));
      } catch { finish("spawn_failed", null); throw new OperationsError(503, "launch_unavailable"); }
      return json(202, { workspace_id: workspace, operation_id: operation.operation_id, intent: route[2], state: operation.termination ? "failed" : live.has(workspace) ? "running" : "unknown" });
    } catch (error) {
      if (error instanceof OperationsError) return json(error.status, { error: error.code });
      return json(503, { ...(workspace ? { workspace_id: workspace } : {}), state: "unavailable", available: false, error: "operations_unavailable" });
    }
  });
}

// These records establish execution identity only; batch receipts and inventory remain authoritative.
export function localExecutionDeps(root: string): Pick<OperationsDeps, "receipts" | "operations" | "save" | "acquire" | "release"> {
  const directory = path.join(root, ".runtime/reconstruction/context-operations");
  // Global exclusion also protects the existing shared prepared-artifact paths.
  const lock = path.join(directory, "execution.lock");
  function readAll(folder: string): Record<string, unknown>[] {
    let names: string[];
    try { names = fs.readdirSync(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter(name => name.endsWith(".json")).sort().map(name => ({ ...JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")), receipt_identity: name }));
  }
  return {
    receipts: workspace => readAll(path.join(root, ".runtime/reconstruction/batch-receipts")).filter(r => r.workspace === workspace),
    operations: workspace => {
      const records = readAll(directory).filter(r => r.workspace === workspace).map(r => {
        if (!OPERATION.test(String(r.operation_id)) || !Number.isFinite(Date.parse(String(r.started_at)))
          || (r.finished_at !== undefined && !Number.isFinite(Date.parse(String(r.finished_at))))
          || (r.termination !== undefined && !["exited", "spawn_failed"].includes(String(r.termination)))
          || (r.exit_code !== undefined && r.exit_code !== null && !Number.isInteger(r.exit_code))) throw new Error("Invalid liveness receipt");
        return r as unknown as Operation;
      });
      try {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (!OPERATION.test(String(owner.operation_id)) || !/^workspace_[0-9a-f]{32}$/.test(String(owner.workspace))) throw new Error("Invalid execution lock");
        if (owner.workspace === workspace && !records.some(r => r.operation_id === owner.operation_id)) throw new Error("Missing liveness receipt");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return records;
    },
    acquire: operation => {
      fs.mkdirSync(directory, { recursive: true });
      try { fs.writeFileSync(lock, JSON.stringify({ workspace: operation.workspace, operation_id: operation.operation_id }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new OperationsError(409, "execution_active_or_unresolved"); throw error; }
    },
    save: operation => {
      fs.mkdirSync(directory, { recursive: true });
      const destination = path.join(directory, `${operation.operation_id}.json`);
      const temporary = `${destination}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(operation), { mode: 0o600 }); fs.renameSync(temporary, destination);
    },
    release: operation => {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (owner.operation_id !== operation.operation_id) throw new Error("Execution lock identity mismatch");
      fs.unlinkSync(lock); // only execution exclusion; never a reconstruction artifact
    }
  };
}
export function createOperationsStatusReader(connectionString: string): { status: OperationsDeps["status"]; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000, application_name: "hhs-context-operations-reader" });
  return {
    status: async workspace => {
      const store = new MissionControlStore(workspace, connectionString, pool);
      const summary = await store.statusSummary();
      const inventory = await loadReconstructionInventory(workspace, [], undefined, undefined, pool, true);
      return { memory: summary.memory, reconstruction: inventory.summary };
    },
    close: () => pool.end()
  };
}
export async function startFromEnvironment(): Promise<http.Server> {
  const config = loadOperationsConfig(process.env);
  const reader = createOperationsStatusReader(process.env.MEMORY_REPORT_DATABASE_URL!);
  const server = createContextOperationsService(config, {
    ...localExecutionDeps(ROOT), status: reader.status,
    launch: (executable, args, options) => {
      const env = { ...process.env };
      delete env.MEMORY_CONTEXT_OPERATIONS_TOKENS;
      return spawn(executable, args, { ...options, env });
    }
  });
  server.once("close", () => { void reader.close(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, LOOPBACK_HOST, resolve); });
    return server;
  } catch (error) { await reader.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startFromEnvironment();
    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());
  } catch { console.error("context-operations-service: startup_unavailable"); process.exitCode = 1; }
}
