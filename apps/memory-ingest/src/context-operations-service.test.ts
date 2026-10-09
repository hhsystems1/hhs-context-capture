import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { CANONICAL_INVENTORY_SQL, EXPECTED_CLEAN_CORPUS_SIZE } from "./reconstruction-inventory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextOperationsService, createOperationsStatusReader, startFromEnvironment, loadOperationsConfig, localExecutionDeps, parseLaunchInput, type Operation, type OperationsDeps } from "./context-operations-service.js";
const TOKEN = "test-only-operations-token-".repeat(3);
const W = `workspace_${"a".repeat(32)}`;
const env = { MEMORY_REPORT_DATABASE_URL: "postgresql://memory_v1_report_login:test@127.0.0.1:55022/postgres", MEMORY_INGEST_DATABASE_URL: "postgresql://memory_v1_ingest_login:test@127.0.0.1:55022/postgres", MEMORY_CONTEXT_OPERATIONS_TOKENS: `hhs-core:${TOKEN}` };
const config = loadOperationsConfig(env);
const summary = { memory: { messages: 7, blocks: 8, proposed: 2, approved: 1, secret: TOKEN }, reconstruction: Object.fromEntries(["total_clean_conversations", "discovery_processed", "unprocessed", "awaiting_reconciliation", "observations_awaiting_reconciliation", "reconciled", "evidence_issues", "zero_evidence", "needs_review", "other_evidence_issues", "batches_total", "batches_complete", "batches_partial", "remaining_conversations", "next_batch"].map(key => [key, key === "next_batch" ? null : 1])) };
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-operations-test-")); roots.push(root);
  const child = new EventEmitter() as ChildProcess;
  const deps: OperationsDeps = { ...localExecutionDeps(root), status: vi.fn(async () => summary), launch: vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; }) };
  return { root, child, deps, server: createContextOperationsService(config, deps) };
}
async function request(server: ReturnType<typeof createContextOperationsService>, intent = "status", init: { workspace?: string; method?: string; headers?: Record<string, string>; body?: string; peer?: string; suffix?: string } = {}) {
  const incoming = Object.assign(Readable.from([Buffer.from(init.body ?? (intent === "status" ? "" : "{}"))]), { method: init.method ?? (intent === "status" ? "GET" : "POST"), url: `/memory/workspaces/${init.workspace ?? W}/reconstruction/${intent}${init.suffix ?? ""}`, headers: { host: "127.0.0.1:54433", authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers }, socket: { remoteAddress: init.peer ?? "127.0.0.1" } });
  return new Promise<{ code: number; body: any }>(resolve => {
    let code = 0;
    server.emit("request", incoming, { writeHead: (value: number) => { code = value; }, end: (bytes: string) => resolve({ code, body: JSON.parse(bytes) }) });
  });
}
function putReceipt(root: string, op: string | undefined, state: string, extra = {}) {
  const directory = path.join(root, ".runtime/reconstruction/batch-receipts"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `batch-${op ?? "cli"}.json`), JSON.stringify({ schema_version: "hhs-reconstruction-batch/0.1.0", workspace: W, operation_id: op, started_at: "2026-01-01T00:00:00.000Z", status: state, requested: 10, selected: 2, completed: [{}], quarantined: state === "completed" ? [] : [{ reason: "prepared_source_identity_mismatch secret" }], provider: TOKEN, ...extra }));
}
describe("Context Operations boundary", () => {
  it("requires separate hashed named tokens and existing non-admin loopback roles", () => {
    expect(config.port).toBe(54433); expect(JSON.stringify(config)).not.toContain(TOKEN);
    for (const key of ["MEMORY_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS", "MEMORY_PROVISIONING_SERVICE_TOKENS"]) expect(() => loadOperationsConfig({ ...env, [key]: "secret" })).toThrow();
    for (const tokens of ["", "core:short", `core:${TOKEN},core:${TOKEN}`, `core:${TOKEN},other:${TOKEN}`]) expect(() => loadOperationsConfig({ ...env, MEMORY_CONTEXT_OPERATIONS_TOKENS: tokens })).toThrow();
    for (const url of ["not-url", "postgresql://postgres:test@127.0.0.1/db", "postgresql://memory_v1_ingest_login:test@host/db"]) expect(() => loadOperationsConfig({ ...env, MEMORY_INGEST_DATABASE_URL: url })).toThrow();
    for (const port of ["0", "1023", "65536", "nan"]) expect(() => loadOperationsConfig({ ...env, MEMORY_CONTEXT_OPERATIONS_PORT: port })).toThrow();
  });
  it("rejects peers, Origins (including empty), nonfixed Hosts and missing/invalid tokens before reads", async () => {
    const { server, deps } = setup();
    for (const peer of ["0.0.0.0", "192.168.1.2", "::1", ""]) expect((await request(server, "status", { peer })).code).toBe(403);
    for (const headers of [{ origin: "https://browser" }, { origin: "" }, { host: "evil.example" }, { host: "localhost:54433" }, { host: "127.0.0.1:9999" }]) expect((await request(server, "status", { headers })).code).toBe(403);
    for (const authorization of ["", "Bearer wrong", `Bearer ${TOKEN} extra`]) expect((await request(server, "status", { headers: { authorization } })).code).toBe(401);
    expect(deps.status).not.toHaveBeenCalled();
    const source = fs.readFileSync("apps/memory-ingest/src/context-operations-service.ts", "utf8"); expect(source).toContain("server.listen(config.port, LOOPBACK_HOST");
  });
  it("strictly parses routes and bounded JSON, refusing commands, paths, env and provider overrides", async () => {
    const { server, deps } = setup();
    for (const workspace of ["workspace_bad", W.toUpperCase(), `${W}%2f..`]) expect((await request(server, "start", { workspace })).code).toBe(404);
    expect((await request(server, "status", { suffix: "?x=1" })).code).toBe(404);
    for (const value of [null, [], 1, { limit: 0 }, { limit: 11 }, { limit: 1.5 }, { limit: "1" }, { conversation: "--command" }, { conversation: "../../file" }, { conversation: "x;ls" }, { command: "node" }, { env: {} }, { path: "file" }, { model: "other" }]) {
      expect(() => parseLaunchInput(value)).toThrow(); expect((await request(server, "start", { body: JSON.stringify(value) })).code).toBe(400);
    }
    expect((await request(server, "start", { body: "{" })).code).toBe(400);
    expect((await request(server, "start", { body: "x".repeat(4097) })).code).toBe(413);
    expect((await request(server, "start", { headers: { "content-type": "text/plain" } })).code).toBe(400);
    expect((await request(server, "status", { headers: { "content-length": "2" }, body: "{}" })).code).toBe(400);
    expect(deps.launch).not.toHaveBeenCalled();
  });
});
describe("truthful processing reads", () => {
  it("forwards the exact workspace to the existing read dependency and only allows supported fields", async () => {
    const { server, deps } = setup(); const response = await request(server);
    expect(deps.status).toHaveBeenCalledWith(W); expect(response).toMatchObject({ code: 200, body: { state: "idle", available: true, workspace_id: W, memory: { messages: 7 } } });
    expect(JSON.stringify(response)).not.toContain(TOKEN); expect(response.body.memory.secret).toBeUndefined();
  });
  it("never substitutes zeros for failed, missing or malformed counts/receipts", async () => {
    const { server, deps, root } = setup();
    deps.status = async () => { throw new Error(TOKEN); };
    expect(await request(server)).toEqual({ code: 503, body: { workspace_id: W, state: "unavailable", available: false, error: "operations_unavailable" } });
    deps.status = async () => ({ memory: {}, reconstruction: {} }); expect((await request(server)).body.state).toBe("unavailable");
    deps.status = async () => summary;
    putReceipt(root, undefined, "running", { completed: "invalid" }); expect((await request(server)).body.state).toBe("unavailable");
  });
  it("uses an operation ID tiebreaker and never treats durable running JSON as live after restart", async () => {
    const { server, deps, root } = setup();
    const a: Operation = { workspace: W, operation_id: `operation_${"a".repeat(32)}`, started_at: "2026-01-01T00:00:00.000Z", termination: "exited", exit_code: 0 };
    const b: Operation = { ...a, operation_id: `operation_${"b".repeat(32)}` }; delete b.termination;
    deps.save(b); deps.save(a); putReceipt(root, b.operation_id, "running");
    expect((await request(server)).body).toMatchObject({ state: "interrupted", operation_id: b.operation_id });
    deps.acquire(b);
    expect((await request(createContextOperationsService(config, deps), "resume")).body.error).toBe("execution_active_or_unresolved");
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it.each(["completed", "partial", "failed"])("preserves %s receipt truth for direct CLI receipts", async state => {
    const { server, root } = setup(); putReceipt(root, undefined, state);
    const response = await request(server); expect(response.body.state).toBe(state); expect(response.body.completed_count).toBe(1); expect(JSON.stringify(response)).not.toContain(TOKEN);
  });
});
describe("one existing runner for both intents", () => {
  it.each(["start", "resume"])("%s forwards safe argv with correlation, prevents duplicates, and releases only liveness exclusion", async intent => {
    const { server, deps, root, child } = setup();
    const response = await request(server, intent, { body: JSON.stringify({ limit: 2, conversation: "synthetic-source" }) }); expect(response.code).toBe(202);
    const id = response.body.operation_id;
    expect(deps.launch).toHaveBeenCalledWith(process.execPath, ["scripts/run-reconstruction-batch.mjs", "--workspace", W, "--limit", "2", "--operation-id", id, "--conversation", "synthetic-source"], { cwd: process.cwd(), shell: false, stdio: "ignore" });
    expect((await request(server, "resume")).code).toBe(409); expect(deps.launch).toHaveBeenCalledTimes(1);
    expect((await request(server)).body.state).toBe("running");
    putReceipt(root, id, "partial"); child.emit("close", 2);
    const final = (await request(server)).body; expect(final).toMatchObject({ state: "partial", process_exit_code: 2, prepared_artifact_review_required: true });
    expect(fs.existsSync(path.join(root, ".runtime/reconstruction/batch-receipts", `batch-${id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, ".runtime/reconstruction/context-operations", `${id}.json`))).toBe(true);
    expect((await request(server, "resume")).code).toBe(202);
  });
  it.each([0, 2, 9, null])("exit %s without a final receipt remains interrupted", async code => {
    const { server, root, child } = setup(); const response = await request(server, "start"); putReceipt(root, response.body.operation_id, "running"); child.emit("close", code);
    expect((await request(server)).body).toMatchObject({ state: "interrupted", process_termination: "exited", process_exit_code: code });
  });
  it("exit 0 does not overwrite a failed receipt", async () => {
    const { server, root, child } = setup(); const response = await request(server, "start"); putReceipt(root, response.body.operation_id, "failed"); child.emit("close", 0);
    expect((await request(server)).body.state).toBe("failed");
  });
  it("synchronous and asynchronous spawn failures are sanitized and cannot remain live", async () => {
    const { server, deps, child } = setup(); deps.launch = () => { throw new Error(TOKEN); };
    expect(await request(server, "start")).toEqual({ code: 503, body: { error: "launch_unavailable" } }); expect((await request(server)).body.state).toBe("failed");
    deps.launch = () => child; await request(server, "resume"); child.emit("error", new Error(TOKEN)); expect((await request(server)).body.state).toBe("failed");
  });
  it("atomic durable exclusion protects separate service instances and different workspaces", async () => {
    const { server, deps } = setup(); await request(server, "start");
    const other = createContextOperationsService(config, deps);
    expect((await request(other, "resume")).code).toBe(409);
    expect((await request(other, "start", { workspace: `workspace_${"b".repeat(32)}` })).code).toBe(409);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });
});

describe("fail-closed liveness edge cases", () => {
  it("does not call a not-yet-spawned process live", async () => {
    const { deps, child, server, root } = setup(); deps.launch = () => child;
    const accepted = await request(server, "start");
    expect(accepted.body.state).toBe("unknown");
    putReceipt(root, accepted.body.operation_id, "running");
    expect((await request(server)).body.state).toBe("unknown");
    child.emit("spawn"); expect((await request(server)).body.state).toBe("running");
    child.emit("exit", null, "SIGKILL"); expect((await request(server)).body.state).toBe("unknown");
    child.emit("close", null, "SIGKILL"); expect((await request(server)).body.state).toBe("interrupted");
    expect((await request(server, "resume")).code).toBe(409);
  });
  it("an unresolved direct CLI running artifact also blocks a service launch", async () => {
    const { server, deps, root } = setup(); putReceipt(root, undefined, "running");
    expect((await request(server)).body.state).toBe("interrupted");
    expect((await request(server, "start")).code).toBe(409); expect(deps.launch).not.toHaveBeenCalled();
  });
  it("breaks timestamp ties for legacy batch receipts by stable receipt filename", async () => {
    const { server, root } = setup(); putReceipt(root, undefined, "failed");
    const file = path.join(root, ".runtime/reconstruction/batch-receipts/batch-cli.json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(path.join(path.dirname(file), "batch-z.json"), JSON.stringify({ ...receipt, status: "partial" }));
    expect((await request(server)).body.state).toBe("partial");
  });
  it("a durable lock without its operation record is unavailable rather than idle", async () => {
    const { server, deps } = setup(); deps.acquire({ workspace: W, operation_id: `operation_${"a".repeat(32)}`, started_at: new Date().toISOString() });
    expect((await request(server)).body.state).toBe("unavailable");
    expect((await request(server, "start")).code).toBe(503);
  });
});

describe("Finding 1: terminal execution lock release", () => {
  const lockPath = (root: string) => path.join(root, ".runtime/reconstruction/context-operations/execution.lock");
  it("exit 1 without a correlated receipt releases global exclusion and permits another start", async () => {
    const { server, child, root } = setup();
    // An unrelated receipt must not count as this operation's receipt.
    putReceipt(root, `operation_${"c".repeat(32)}`, "completed");
    expect((await request(server, "start")).code).toBe(202);
    child.emit("close", 1);
    expect(fs.existsSync(lockPath(root))).toBe(false);
    expect((await request(server)).body).toMatchObject({ state: "failed", process_exit_code: 1 });
    expect((await request(server, "start")).code).toBe(202);
  });
  it("exit 9 with a correlated running receipt retains the lock and next start returns 409", async () => {
    const { server, child, root } = setup();
    const accepted = await request(server, "start"); putReceipt(root, accepted.body.operation_id, "running");
    child.emit("close", 9);
    expect(fs.existsSync(lockPath(root))).toBe(true);
    expect((await request(server)).body.state).toBe("interrupted");
    expect((await request(server, "start")).code).toBe(409);
  });
  it("spawn_failed still releases exclusion and permits retry", async () => {
    const { server, child, root } = setup();
    await request(server, "start"); child.emit("error", new Error(TOKEN));
    expect(fs.existsSync(lockPath(root))).toBe(false);
    expect((await request(server, "start")).code).toBe(202);
  });
  it("receipt-read failure retains exclusion rather than assuming no receipt", async () => {
    const { server, deps, child, root } = setup(); await request(server, "start");
    deps.receipts = () => { throw new Error(TOKEN); }; child.emit("close", 1);
    expect(fs.existsSync(lockPath(root))).toBe(true);
    expect((await request(server, "start")).code).toBe(503);
  });
});

function mockStatusDatabase(timeout = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "select current_user") return { rows: [{ current_user: "memory_v1_report_login" }] };
    if (sql === CANONICAL_INVENTORY_SQL) {
      if (timeout) throw new Error("statement timeout " + TOKEN);
      return { rows: Array.from({ length: EXPECTED_CLEAN_CORPUS_SIZE }, (_, index) => ({
        source_conversation_id: `synthetic-${index}`, conversation_id: `conversation-${index}`,
        source_family: "native_export", source_version_id: `version-${index}`, capture_version_id: null,
        verification_status: "complete", source_observed_at: "2026-01-01T00:00:00.000Z",
        message_count: 2, user_message_count: 1, assistant_message_count: 1, evidence_block_count: 2,
        canonical_text_representation_count: 2, nonempty_canonical_text_count: 2, empty_canonical_text_count: 0,
        persisted_observations_count: 0, reconciled_observations_count: 0, persisted_links_count: 0
      })) };
    }
    if (sql.includes("operation_issues")) return { rows: [{ operation_issues: 0, quarantine: 0, contradictions: 0 }] };
    if (sql.includes("count(*) from memory_v1.messages")) return { rows: [summary.memory] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as any);
  const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue();
  const Pool = pg.Pool;
  const construct = vi.spyOn(pg, "Pool").mockImplementation(function (options) { return new Pool(options); });
  return { query, release, connect, end, construct };
}
function expectBoundedInventory(query: ReturnType<typeof mockStatusDatabase>["query"], workspace: string) {
  const calls = query.mock.calls;
  const inventoryIndexes = calls.flatMap(([sql], index) => sql === CANONICAL_INVENTORY_SQL ? [index] : []);
  expect(inventoryIndexes.length).toBeGreaterThan(0);
  for (const index of inventoryIndexes) {
    expect(calls.slice(index - 4, index + 1)).toEqual([
      ["begin read only"],
      ["select set_config('memory_v1.workspace_id',$1,true)", [workspace]],
      ["set local statement_timeout = '5000ms'"],
      ["set local lock_timeout = '2000ms'"],
      [CANONICAL_INVENTORY_SQL, [workspace, expect.any(String)]]
    ]);
  }
}
describe("Finding 2: one bounded report-reader pool", () => {
  it("successive status calls reuse one pool for both read models, with inventory timeouts before SQL", async () => {
    const database = mockStatusDatabase(); const reader = createOperationsStatusReader(env.MEMORY_REPORT_DATABASE_URL);
    const { deps } = setup(); deps.status = reader.status;
    const server = createContextOperationsService(config, deps);
    try {
      expect((await request(server)).code).toBe(200); expect((await request(server)).code).toBe(200);
      expect(database.construct).toHaveBeenCalledTimes(1);
      expect(database.construct).toHaveBeenCalledWith(expect.objectContaining({ connectionString: env.MEMORY_REPORT_DATABASE_URL, connectionTimeoutMillis: 3000 }));
      expect(database.connect).toHaveBeenCalledTimes(4);
      expect(new Set(database.connect.mock.contexts).size).toBe(1);
      expectBoundedInventory(database.query, W);
      expect(database.end).not.toHaveBeenCalled(); expect(database.release).toHaveBeenCalledTimes(4);
    } finally { await reader.close(); }
    expect(database.end).toHaveBeenCalledTimes(1);
  });
  it.each(["start", "resume"])("%s preflight uses the same bounded inventory path", async intent => {
    const database = mockStatusDatabase(); const reader = createOperationsStatusReader(env.MEMORY_REPORT_DATABASE_URL);
    const { deps, child } = setup(); deps.status = reader.status;
    try {
      expect((await request(createContextOperationsService(config, deps), intent)).code).toBe(202);
      expectBoundedInventory(database.query, W); expect(database.construct).toHaveBeenCalledTimes(1);
      child.emit("close", 1);
    } finally { await reader.close(); }
  });
  it.each(["status", "start", "resume"])("inventory timeout in %s rolls back and returns unavailable without zeros or launch", async intent => {
    const database = mockStatusDatabase(true); const reader = createOperationsStatusReader(env.MEMORY_REPORT_DATABASE_URL);
    const { deps } = setup(); deps.status = reader.status;
    try {
      expect(await request(createContextOperationsService(config, deps), intent)).toEqual({ code: 503, body: { workspace_id: W, state: "unavailable", available: false, error: "operations_unavailable" } });
      expectBoundedInventory(database.query, W);
      expect(database.query).toHaveBeenLastCalledWith("rollback"); expect(database.release).toHaveBeenCalledTimes(2);
      expect(deps.launch).not.toHaveBeenCalled(); expect(database.end).not.toHaveBeenCalled();
    } finally { await reader.close(); }
  });
  it("shutdown closes the one startup-owned pool without binding a socket", async () => {
    const database = mockStatusDatabase();
    vi.stubEnv("MEMORY_REPORT_DATABASE_URL", env.MEMORY_REPORT_DATABASE_URL);
    vi.stubEnv("MEMORY_INGEST_DATABASE_URL", env.MEMORY_INGEST_DATABASE_URL);
    vi.stubEnv("MEMORY_CONTEXT_OPERATIONS_TOKENS", env.MEMORY_CONTEXT_OPERATIONS_TOKENS);
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server, ...args: any[]) { (args.at(-1) as () => void)(); return this; });
    try {
      const server = await startFromEnvironment();
      expect(database.construct).toHaveBeenCalledTimes(1); expect(database.end).not.toHaveBeenCalled();
      server.emit("close"); expect(database.end).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it("startup listen failure closes the reader pool", async () => {
    const database = mockStatusDatabase();
    vi.stubEnv("MEMORY_REPORT_DATABASE_URL", env.MEMORY_REPORT_DATABASE_URL);
    vi.stubEnv("MEMORY_INGEST_DATABASE_URL", env.MEMORY_INGEST_DATABASE_URL);
    vi.stubEnv("MEMORY_CONTEXT_OPERATIONS_TOKENS", env.MEMORY_CONTEXT_OPERATIONS_TOKENS);
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server) { this.emit("error", new Error("test-only listen failure")); return this; });
    try {
      await expect(startFromEnvironment()).rejects.toThrow("test-only listen failure");
      expect(database.end).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
