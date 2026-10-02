import { readFile } from "node:fs/promises";
import http from "node:http";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { assertServiceEnvironment } from "./query-service.js";
import {
  LOOPBACK_HOST, PROVISIONING_LOGIN, assertProvisioningRole, createProvisioningService,
  ensureWorkspace, isLoopbackAddress, loadProvisioningConfig, parseEnsureRequest,
  workspaceRecord, type EnsureRequest, type WorkspaceRecord
} from "./provisioning-service.js";

const TOKEN = "provisioning-test-token-".repeat(3);
const WRITER_URL = "postgresql://memory_v1_ingest_login:test-only@127.0.0.1:55022/postgres";
const baseEnv = { MEMORY_INGEST_DATABASE_URL: WRITER_URL, MEMORY_PROVISIONING_SERVICE_TOKENS: `hhs-core:${TOKEN}` };
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const request: EnsureRequest = { external_key: `hhs-core:user:${UUID}`, name: "Personal brain" };
const invalidIdentityKeys = [
  `hhs-core:client:${UUID}`,
  `hhs-core:workspace:${UUID}`,
  `hhs-core:USER:${UUID}`,
  `hhs-core:Org:${UUID}`,
  `hhs-core:Project:${UUID}`,
  `HHS-core:user:${UUID}`,
  `hhs-core:user:${UUID.toUpperCase()}`,
  "hhs-core:user:not-a-uuid",
  `hhs-core:user:${UUID.replace("a", "g")}`,
  `hhs-core:user:${UUID.slice(0, -1)}`,
  `hhs-core:user:${UUID}0`,
  `hhs-core:user:${UUID.replaceAll("-", "")}`,
  `hhs-core:user:{${UUID}}`,
  `prefix:hhs-core:user:${UUID}`,
  `hhs-core:user:${UUID}:suffix`,
  `hhs-core:user:${UUID}:`,
  ` hhs-core:user:${UUID}`,
  `hhs-core:user:${UUID} `,
  `hhs-core: user:${UUID}`,
  `hhs-core:user: ${UUID}`,
  `hhs-core:user:${UUID}\n`
];
const source = await readFile(new URL("./provisioning-service.ts", import.meta.url), "utf8");

// All DB access is simulated; these tests never load env files or connect to PostgreSQL.
function fakePool(initial?: WorkspaceRecord, raceWinner?: WorkspaceRecord, hiddenCollision = false) {
  let row = initial;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("select workspace_id")) return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    if (sql.startsWith("insert into")) {
      if (raceWinner) { row = raceWinner; return { rows: [], rowCount: 0 }; }
      if (hiddenCollision) return { rows: [], rowCount: 0 };
      row = { workspace_id: params![0] as string, name: params![1] as string, isolation_key: params![2] as string, status: params![3] as "active", idempotency_key: params![4] as string, record_sha256: params![5] as string };
      return { rows: [{ ...row }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool;
  return { pool, query, release, stored: () => row };
}

let activeServer: http.Server | undefined;
afterEach(async () => {
  if (activeServer) {
    const server = activeServer;
    activeServer = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
});

async function startServer(fake = fakePool()) {
  activeServer = createProvisioningService(loadProvisioningConfig(baseEnv), { ensure: (input) => ensureWorkspace(fake.pool, input) });
  await new Promise<void>((resolve, reject) => {
    activeServer!.once("error", reject);
    activeServer!.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = activeServer.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address.");
  return { base: `http://127.0.0.1:${address.port}`, address, fake };
}

function post(base: string, body: unknown = request, token: string | null = TOKEN, headers = {}) {
  return fetch(`${base}/memory/workspaces/ensure`, {
    method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: JSON.stringify(body)
  });
}

describe("dedicated provisioning credentials", () => {
  it("accepts only the existing loopback ingest login, with separate tokens", () => {
    const config = loadProvisioningConfig(baseEnv);
    expect(config.port).toBe(54432);
    expect(config.clients).toEqual([{ name: "hhs-core", tokenSha256: sha256(TOKEN) }]);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(() => loadProvisioningConfig({ MEMORY_PROVISIONING_SERVICE_TOKENS: baseEnv.MEMORY_PROVISIONING_SERVICE_TOKENS })).toThrow(/MEMORY_INGEST_DATABASE_URL/);
    for (const login of ["postgres", "memory_v1_report_login", "memory_v1_review_login"]) {
      expect(() => loadProvisioningConfig({ ...baseEnv, MEMORY_INGEST_DATABASE_URL: WRITER_URL.replace(PROVISIONING_LOGIN, login) })).toThrow(/existing memory_v1_ingest_login/);
    }
    expect(() => loadProvisioningConfig({ ...baseEnv, MEMORY_INGEST_DATABASE_URL: WRITER_URL.replace("127.0.0.1", "db.example.invalid") })).toThrow(/loopback/);
    expect(() => loadProvisioningConfig({ ...baseEnv, MEMORY_INGEST_DATABASE_URL: "not a URL" })).toThrow(/loopback/);
  });
  it("refuses query-service, admin, and reviewer credentials rather than falling back", () => {
    for (const key of ["MEMORY_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "MEMORY_REPORT_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS"]) {
      expect(() => loadProvisioningConfig({ ...baseEnv, [key]: "test-only" })).toThrow(/dedicated environment/);
    }
    expect(() => loadProvisioningConfig({ MEMORY_INGEST_DATABASE_URL: WRITER_URL, MEMORY_QUERY_SERVICE_TOKENS: `query:${TOKEN}` })).toThrow();
    expect(() => loadProvisioningConfig({ MEMORY_INGEST_DATABASE_URL: WRITER_URL })).toThrow(/MEMORY_PROVISIONING_SERVICE_TOKENS/);
    expect(source).toMatch(/createPool\("writer"\)/);
    expect(source).not.toMatch(/createPool\("(?:admin|reader|reviewer)"\)|\btransaction\(/);
  });
  it("rejects short/duplicate tokens and invalid ports without echoing tokens", () => {
    for (const tokens of ["", "bad:short", `client:${TOKEN},client:${"b".repeat(40)}`, `client:${TOKEN},other:${TOKEN}`]) {
      expect(() => loadProvisioningConfig({ ...baseEnv, MEMORY_PROVISIONING_SERVICE_TOKENS: tokens })).toThrow();
    }
    for (const port of ["0", "1023", "65536", "no-port"]) expect(() => loadProvisioningConfig({ ...baseEnv, MEMORY_PROVISIONING_SERVICE_PORT: port })).toThrow(/port/);
  });
  it("fails closed when effective writer privileges are missing or elevated", async () => {
    const suitable = { login: PROVISIONING_LOGIN, rolsuper: false, rolbypassrls: false, writer: true, maintenance: false, schema_usage: true, can_select: true, can_insert: true };
    const query = vi.fn(async () => ({ rows: [suitable] }));
    const pool = { query } as unknown as pg.Pool;
    await expect(assertProvisioningRole(pool)).resolves.toBeUndefined();
    for (const overrides of [{ login: "postgres" }, { rolsuper: true }, { rolbypassrls: true }, { maintenance: true }, { writer: false }, { schema_usage: false }, { can_select: false }, { can_insert: false }]) {
      query.mockResolvedValueOnce({ rows: [{ ...suitable, ...overrides }] });
      await expect(assertProvisioningRole(pool)).rejects.toThrow(/refusing to start/);
    }
  });
});

describe("HHS Core identity contract", () => {
  it.each(["user", "org", "project"])("accepts an exact %s identity without rewriting it", (scope) => {
    const input = { ...request, external_key: `hhs-core:${scope}:${UUID}` };
    expect(parseEnsureRequest(input)).toEqual(input);
    const row = workspaceRecord(input);
    expect(row.workspace_id).toBe(deterministicId("workspace", "hhs-core-provisioning-v1", input.external_key));
    expect(row.isolation_key).toBe(idempotencyKey("workspace_isolation", "hhs-core-provisioning-v1", input.external_key));
    expect(row.idempotency_key).toBe(idempotencyKey("workspace", row.workspace_id, input.external_key));
    expect(workspaceRecord(input)).toEqual(row);
  });
  it.each(invalidIdentityKeys)("rejects invalid identity %j rather than repairing it", (external_key) => {
    const input = { ...request, external_key };
    expect(() => parseEnsureRequest(input)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_body" }));
    expect(() => workspaceRecord(input)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_body" }));
    expect(input.external_key).toBe(external_key);
  });
  it("derives distinct identities for the same UUID across user/org/project scopes", () => {
    const rows = ["user", "org", "project"].map((scope) => workspaceRecord({ ...request, external_key: `hhs-core:${scope}:${UUID}` }));
    for (const field of ["workspace_id", "isolation_key", "idempotency_key"] as const) {
      expect(new Set(rows.map((row) => row[field])).size).toBe(3);
    }
  });
  it("returns invalid_body before any DB work for every rejected identity", async () => {
    const { base, fake } = await startServer();
    for (const external_key of invalidIdentityKeys) {
      const response = await post(base, { ...request, external_key });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_body" });
      await expect(ensureWorkspace(fake.pool, { ...request, external_key })).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    }
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
});

describe("workspace identity and immutable ensure", () => {
  it("uses canonical independent derivations and the existing immutable row hash pattern", () => {
    const row = workspaceRecord(request);
    expect(row.workspace_id).toBe(deterministicId("workspace", "hhs-core-provisioning-v1", request.external_key));
    expect(row.isolation_key).toBe(idempotencyKey("workspace_isolation", "hhs-core-provisioning-v1", request.external_key));
    expect(row.isolation_key).not.toBe(row.workspace_id);
    expect(row.idempotency_key).toBe(idempotencyKey("workspace", row.workspace_id, request.external_key));
    const { record_sha256, ...body } = row;
    expect(record_sha256).toBe(sha256(body));
    expect(workspaceRecord(request)).toEqual(row);
    const renamed = workspaceRecord({ ...request, name: "Renamed" });
    expect(renamed.workspace_id).toBe(row.workspace_id);
    expect(renamed.isolation_key).toBe(row.isolation_key);
    expect(renamed.idempotency_key).toBe(row.idempotency_key);
    expect(renamed.record_sha256).not.toBe(row.record_sha256);
    const other = workspaceRecord({ ...request, external_key: `hhs-core:org:${UUID}` });
    expect(other.workspace_id).not.toBe(row.workspace_id);
    expect(other.isolation_key).not.toBe(row.isolation_key);
  });
  it("creates once and returns exactly the same binding on repeat", async () => {
    const fake = fakePool();
    const first = await ensureWorkspace(fake.pool, request);
    expect(first).toEqual({ workspace_id: workspaceRecord(request).workspace_id, name: request.name, status: "active", created: true });
    expect(await ensureWorkspace(fake.pool, request)).toEqual({ ...first, created: false });
    expect(fake.query.mock.calls.filter(([sql]) => sql.startsWith("insert into"))).toHaveLength(1);
    expect(fake.query.mock.calls[0]).toEqual(["begin isolation level read committed"]);
    expect(fake.query.mock.calls[1]).toEqual(["select set_config('memory_v1.workspace_id',$1,true)", [first.workspace_id]]);
    expect(fake.query.mock.calls.filter(([sql]) => sql === "commit")).toHaveLength(2);
    expect(fake.release).toHaveBeenCalledTimes(2);
  });
  it("rejects tampered immutable rows but accepts a later display-name change without mutation", async () => {
    const row = workspaceRecord(request);
    for (const change of [{ name: "Renamed" }, { isolation_key: "other" }, { idempotency_key: "a".repeat(64) }, { record_sha256: "b".repeat(64) }, { workspace_id: "other" }]) {
      const fake = fakePool({ ...row, ...change });
      await expect(ensureWorkspace(fake.pool, request)).rejects.toMatchObject({ status: 409, code: "immutable_workspace_conflict" });
      expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
      expect(fake.query).toHaveBeenCalledWith("rollback");
      expect(fake.release).toHaveBeenCalledOnce();
    }

    const fake = fakePool(row);
    await expect(ensureWorkspace(fake.pool, { ...request, name: "New name" })).resolves.toEqual({
      workspace_id: row.workspace_id,
      name: row.name,
      status: "active",
      created: false,
    });
    expect(fake.stored()).toEqual(row);
    expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
  });
  it("returns a suspended row without reactivating it", async () => {
    const fake = fakePool({ ...workspaceRecord(request), status: "suspended" });
    expect(await ensureWorkspace(fake.pool, request)).toMatchObject({ status: "suspended", created: false });
    expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
  });
  it("handles a concurrent insert winner and fails closed on an RLS-hidden unique collision", async () => {
    const winner = fakePool(undefined, workspaceRecord(request));
    expect(await ensureWorkspace(winner.pool, request)).toMatchObject({ created: false });
    const conflictRow = workspaceRecord({ ...request, name: "Concurrent different name" });
    const conflict = fakePool(undefined, conflictRow);
    await expect(ensureWorkspace(conflict.pool, request)).resolves.toEqual({
      workspace_id: conflictRow.workspace_id,
      name: conflictRow.name,
      status: "active",
      created: false,
    });
    const hidden = fakePool(undefined, undefined, true);
    await expect(ensureWorkspace(hidden.pool, request)).rejects.toMatchObject({ status: 409 });
    expect(hidden.query).toHaveBeenCalledWith("rollback");
  });
  it("maps permission failures without admin escalation or leaking SQL errors", async () => {
    const fake = fakePool();
    fake.query.mockRejectedValueOnce({ code: "42501", message: "test-only private database detail" });
    await expect(ensureWorkspace(fake.pool, request)).rejects.toMatchObject({ status: 503, code: "provisioning_permission_denied" });
    expect(fake.release).toHaveBeenCalledOnce();
  });
});

describe("loopback token-authenticated HTTP service", () => {
  it("binds only to loopback and rejects non-loopback peers before any other work", async () => {
    const { address } = await startServer();
    expect(address.address).toBe("127.0.0.1");
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(peer)).toBe(true);
    for (const peer of ["", "0.0.0.0", "192.168.1.5", "127.0.0.1.example", "::"]) {
      expect(isLoopbackAddress(peer)).toBe(false);
      const response = { writeHead: vi.fn(), end: vi.fn() };
      const handler = activeServer!.listeners("request")[0]!;
      await handler({ socket: { remoteAddress: peer } } as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
      expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    }
    expect(source).toMatch(/listen\(config\.port, LOOPBACK_HOST/);
  });
  it("requires valid provisioning authentication before touching the DB", async () => {
    const { base, fake } = await startServer();
    for (const token of [null, "wrong-token", `${TOKEN}wrong`]) expect((await post(base, request, token)).status).toBe(401);
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
  it("rejects hostile Host and browser Origin headers", async () => {
    const { base, fake } = await startServer();
    // Node fetch replaces Host; use the HTTP client to exercise the real header.
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = http.request(`${base}/memory/workspaces/ensure`, {
        method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` }
      }, (incoming) => { incoming.resume(); resolve(incoming.statusCode ?? 0); });
      outgoing.once("error", reject);
      outgoing.end(JSON.stringify(request));
    });
    expect(hostileHostStatus).toBe(403);
    expect((await post(base, request, TOKEN, { origin: "http://evil.example" })).status).toBe(403);
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
  it("returns only safe data on create and repeat, and 409 on a conflicting immutable request", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const { base } = await startServer();
    const first = await post(base);
    expect(first.status).toBe(200);
    const data = await first.json();
    expect(data).toEqual({ workspace_id: workspaceRecord(request).workspace_id, name: request.name, status: "active", created: true });
    const repeat = await post(base);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ...data, created: false });
    const renamed = await post(base, { ...request, name: "New name" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ ...data, created: false });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(WRITER_URL);
  });
  it("rejects malformed bodies, unknown routes, and oversized payloads", async () => {
    const { base, fake } = await startServer();
    for (const body of [null, [], "string", {}, { external_key: "key" }, { external_key: 1, name: "name" }, { ...request, extra: true }, { ...request, name: "" }, { ...request, external_key: " leading" }, { ...request, name: "bad\u0000name" }]) {
      expect(() => parseEnsureRequest(body)).toThrow();
      expect((await post(base, body)).status).toBe(400);
    }
    const malformed = await fetch(`${base}/memory/workspaces/ensure`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await post(base, { ...request, name: "x".repeat(5000) })).status).toBe(413);
    expect((await fetch(`${base}/memory/workspaces/ensure`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
  it("never exposes raw dependency errors in logs or responses", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    activeServer = createProvisioningService(loadProvisioningConfig(baseEnv), { ensure: async () => { throw new Error(WRITER_URL + TOKEN); } });
    await new Promise<void>((resolve, reject) => {
      activeServer!.once("error", reject);
      activeServer!.listen(0, LOOPBACK_HOST, resolve);
    });
    const address = activeServer.address() as { port: number };
    const response = await post(`http://127.0.0.1:${address.port}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(logs).toHaveBeenCalledWith("memory-provisioning-service: internal_error");
  });
});

describe("query service separation", () => {
  it("preserves query-service.ts exactly and continues rejecting the writer credential", async () => {
    const querySource = await readFile(new URL("./query-service.ts", import.meta.url), "utf8");
    expect(sha256(querySource)).toBe("afb78f2a2c79a92958a4aaf0b8e003c02d05ae4d8fc3a80fb877b82bf61f99fb");
    expect(() => assertServiceEnvironment({ MEMORY_INGEST_DATABASE_URL: WRITER_URL })).toThrow(/write-capable credentials/);
    expect(source).not.toMatch(/from "\.\/query-service/);
  });
});
