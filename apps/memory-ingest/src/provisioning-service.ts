import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { deterministicId, idempotencyKey, sha256, type Workspace } from "@hhs/memory-schema";
import { assertLocalDatabaseUrl } from "./config.js";
import { createPool } from "./db.js";

// Run with tsx apps/memory-ingest/src/provisioning-service.ts in a dedicated
// environment containing only MEMORY_INGEST_DATABASE_URL and named tokens in
// MEMORY_PROVISIONING_SERVICE_TOKENS (<client>:<32+ character token>, comma-separated).
// MEMORY_PROVISIONING_SERVICE_PORT defaults to 54432. No env files are loaded here.
export const LOOPBACK_HOST = "127.0.0.1";
export const PROVISIONING_LOGIN = "memory_v1_ingest_login";
const ID_NAMESPACE = "hhs-core-provisioning-v1";
const FORBIDDEN_ENV_VARS = ["MEMORY_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "MEMORY_REPORT_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS"] as const;

interface ProvisioningClient { name: string; tokenSha256: string }
export interface ProvisioningConfig { port: number; clients: ProvisioningClient[] }
export interface EnsureRequest { external_key: string; name: string }
export interface BindingData { workspace_id: string; name: string; status: Workspace["status"]; created: boolean }
export interface ProvisioningDeps { ensure(request: EnsureRequest): Promise<BindingData> }
export type WorkspaceRecord = Workspace & { record_sha256: string };

export class ProvisioningError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export function loadProvisioningConfig(env: Record<string, string | undefined>): ProvisioningConfig {
  if (FORBIDDEN_ENV_VARS.some((name) => env[name]?.trim())) {
    throw new Error("Provisioning requires a dedicated environment without admin, reviewer, or query-service credentials.");
  }
  const writerUrl = env.MEMORY_INGEST_DATABASE_URL?.trim();
  if (!writerUrl) throw new Error("MEMORY_INGEST_DATABASE_URL is required.");
  let url: URL;
  try { url = assertLocalDatabaseUrl(writerUrl); }
  catch { throw new Error("Provisioning requires a valid loopback PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.username !== PROVISIONING_LOGIN) {
    throw new Error("Provisioning requires the existing memory_v1_ingest_login PostgreSQL credential.");
  }
  const port = Number(env.MEMORY_PROVISIONING_SERVICE_PORT || 54432);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MEMORY_PROVISIONING_SERVICE_PORT must be an unprivileged TCP port.");
  const clients = (env.MEMORY_PROVISIONING_SERVICE_TOKENS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(":");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const token = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!/^[a-z0-9_-]{2,32}$/.test(name) || token.length < 32) throw new Error("Provisioning tokens require a short lowercase client name and at least 32 token characters.");
    return { name, tokenSha256: sha256(token) };
  });
  if (!clients.length) throw new Error("MEMORY_PROVISIONING_SERVICE_TOKENS must define at least one client.");
  if (new Set(clients.map((client) => client.name)).size !== clients.length || new Set(clients.map((client) => client.tokenSha256)).size !== clients.length) {
    throw new Error("Provisioning client names and tokens must be unique.");
  }
  return { port, clients };
}

export function parseEnsureRequest(value: unknown): EnsureRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProvisioningError(400, "invalid_body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.external_key !== "string" || typeof body.name !== "string") throw new ProvisioningError(400, "invalid_body");
  // Accept only exact HHS identities with canonical lowercase UUID text.
  // Case, whitespace, and alternative UUID spellings must never be repaired.
  if (!/^hhs-core:(user|org|project):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.external_key)) throw new ProvisioningError(400, "invalid_body");
  // Reject ambiguous identities rather than silently normalizing a logical key.
  for (const [text, limit] of [[body.external_key, 512], [body.name, 256]] as const) {
    const invalidCharacter = Array.from(text).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    });
    if (!text || text.trim() !== text || text.length > limit || invalidCharacter) throw new ProvisioningError(400, "invalid_body");
  }
  return { external_key: body.external_key, name: body.name };
}

export function workspaceRecord(input: EnsureRequest): WorkspaceRecord {
  const request = parseEnsureRequest(input);
  const workspaceId = deterministicId("workspace", ID_NAMESPACE, request.external_key);
  const body: Workspace = {
    workspace_id: workspaceId,
    name: request.name,
    isolation_key: idempotencyKey("workspace_isolation", ID_NAMESPACE, request.external_key),
    status: "active",
    idempotency_key: idempotencyKey("workspace", workspaceId, request.external_key)
  };
  // Match ingest.ts's immutable pattern: hash the entire canonical row body,
  // including idempotency_key, before adding record_sha256; exclude created_at.
  return { ...body, record_sha256: sha256(body) };
}

export async function assertProvisioningRole(pool: pg.Pool): Promise<void> {
  const result = await pool.query(`select current_user as login, r.rolsuper, r.rolbypassrls,
    pg_has_role(current_user, 'memory_v1_ingest_writer', 'member') as writer,
    pg_has_role(current_user, 'memory_v1_maintenance', 'member') as maintenance,
    has_schema_privilege(current_user, 'memory_v1', 'USAGE') as schema_usage,
    has_table_privilege(current_user, 'memory_v1.workspaces', 'SELECT') as can_select,
    has_table_privilege(current_user, 'memory_v1.workspaces', 'INSERT') as can_insert
    from pg_roles r where r.rolname = current_user`);
  const role = result.rows[0];
  if (!role || role.login !== PROVISIONING_LOGIN || role.rolsuper !== false || role.rolbypassrls !== false || role.maintenance !== false || role.writer !== true || role.schema_usage !== true || role.can_select !== true || role.can_insert !== true) {
    throw new Error("Existing ingest role is not suitable for workspace provisioning; refusing to start without an admin fallback.");
  }
}

const WORKSPACE_COLUMNS = "workspace_id,name,isolation_key,status,idempotency_key,record_sha256";

function bindingData(row: WorkspaceRecord, expected: WorkspaceRecord, created: boolean): BindingData {
  // A workspace display name is metadata, not identity. Existing rows keep
  // their original stored name even when a later ensure request uses a new
  // display name. Verify the stored row's own immutable hash instead.
  //
  // status may legitimately transition to suspended without changing the
  // original hash, which was created with status=active.
  const storedHash = sha256({
    workspace_id: row.workspace_id,
    name: row.name,
    isolation_key: row.isolation_key,
    status: "active",
    idempotency_key: row.idempotency_key,
  });

  if (
    row.workspace_id !== expected.workspace_id ||
    row.isolation_key !== expected.isolation_key ||
    row.idempotency_key !== expected.idempotency_key ||
    row.record_sha256 !== storedHash ||
    !["active", "suspended"].includes(row.status)
  ) {
    throw new ProvisioningError(409, "immutable_workspace_conflict");
  }

  return { workspace_id: row.workspace_id, name: row.name, status: row.status, created };
}

export async function ensureWorkspace(pool: pg.Pool, input: EnsureRequest): Promise<BindingData> {
  const row = workspaceRecord(input);
  const client = await pool.connect();
  try {
    // Bootstrap explicitly: no existing workspace or ingestion context is
    // required. The prospective ID satisfies the workspace table's RLS check.
    await client.query("begin isolation level read committed");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [row.workspace_id]);
    const prior = await client.query<WorkspaceRecord>(`select ${WORKSPACE_COLUMNS} from memory_v1.workspaces where workspace_id=$1`, [row.workspace_id]);
    let result: BindingData;
    if (prior.rows[0]) {
      result = bindingData(prior.rows[0], row, false);
    } else {
      // All unique constraints participate; never update an immutable row.
      const inserted = await client.query<WorkspaceRecord>(`insert into memory_v1.workspaces
        (workspace_id,name,isolation_key,status,idempotency_key,record_sha256)
        values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning ${WORKSPACE_COLUMNS}`,
      [row.workspace_id, row.name, row.isolation_key, row.status, row.idempotency_key, row.record_sha256]);
      if (inserted.rows[0]) {
        result = bindingData(inserted.rows[0], row, true);
      } else {
        // READ COMMITTED sees the committed winner of a concurrent insert.
        // A conflict hidden by workspace RLS also fails closed here.
        const existing = await client.query<WorkspaceRecord>(`select ${WORKSPACE_COLUMNS} from memory_v1.workspaces where workspace_id=$1`, [row.workspace_id]);
        if (!existing.rows[0]) throw new ProvisioningError(409, "immutable_workspace_conflict");
        result = bindingData(existing.rows[0], row, false);
      }
    }
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "23505") throw new ProvisioningError(409, "immutable_workspace_conflict");
      if (error.code === "42501") throw new ProvisioningError(503, "provisioning_permission_denied");
    }
    throw error;
  } finally { client.release(); }
}

export function isLoopbackAddress(address: string): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

export function createProvisioningService(config: ProvisioningConfig, deps: ProvisioningDeps): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) return json(response, 403, { error: "loopback_only" });
      // Reject browser-origin requests and non-loopback Host headers as well.
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(request.headers.host ?? "") || request.headers.origin) return json(response, 403, { error: "loopback_only" });
      const authorization = request.headers.authorization;
      const presented = authorization?.toLowerCase().startsWith("bearer ") ? sha256(authorization.slice(7).trim()) : null;
      const client = presented && config.clients.find((entry) => timingSafeEqual(Buffer.from(entry.tokenSha256, "hex"), Buffer.from(presented, "hex")));
      if (!client) return json(response, 401, { error: "invalid_or_missing_token" });
      if (request.method !== "POST" || request.url !== "/memory/workspaces/ensure") return json(response, 404, { error: "unknown_route" });
      const input = parseEnsureRequest(await readBody(request));
      const result = await deps.ensure(input);
      console.log(JSON.stringify({ service: "memory-provisioning-service", client: client.name, operation: "ensure_workspace", created: result.created }));
      // Explicit allowlist; even an injected implementation cannot leak secrets.
      return json(response, 200, { workspace_id: result.workspace_id, name: result.name, status: result.status, created: result.created });
    } catch (error) {
      if (error instanceof ProvisioningError) return json(response, error.status, { error: error.code });
      // Database errors and connection failures can contain credential material.
      console.error("memory-provisioning-service: internal_error");
      return json(response, 500, { error: "internal_error" });
    }
  });
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > 4096) throw new ProvisioningError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProvisioningError(400, "invalid_body"); }
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store" });
  response.end(bytes);
}

export async function startFromEnvironment(): Promise<http.Server> {
  const config = loadProvisioningConfig(process.env);
  const pool = createPool("writer");
  try {
    await assertProvisioningRole(pool);
    const server = createProvisioningService(config, { ensure: (input) => ensureWorkspace(pool, input) });
    server.once("close", () => { void pool.end(); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, LOOPBACK_HOST, resolve);
    });
    console.log(JSON.stringify({ service: "memory-provisioning-service", host: LOOPBACK_HOST, port: config.port, database_role: PROVISIONING_LOGIN }));
    return server;
  } catch {
    await pool.end();
    throw new Error("Provisioning startup failed; verify the existing ingest role and local configuration. No admin fallback is available.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startFromEnvironment();
