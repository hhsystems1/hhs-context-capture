import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, afterEach } from "vitest";
import {
  LOOPBACK_HOST, assertServiceEnvironment, authenticate, createQueryService,
  loadServiceConfig, parseClientTokens, type QueryServiceDeps
} from "./query-service.js";

const serviceSource = await readFile(path.resolve("apps/memory-ingest/src/query-service.ts"), "utf8");
const REPORT_URL = "postgresql://memory_v1_report_login:secret@127.0.0.1:55022/postgres";
const TOKEN = "a".repeat(48);
const baseEnv = {
  MEMORY_REPORT_DATABASE_URL: REPORT_URL,
  MEMORY_WORKSPACE_ID: "workspace_test",
  MEMORY_QUERY_SERVICE_TOKENS: `hermes:${TOKEN}`
};

const fakeMatch = {
  approved_knowledge_id: "approved_knowledge_x", knowledge_candidate_id: "knowledge_candidate_x",
  pipeline_version: "p", approved_at: "2026-08-10T00:00:00.000Z", reviewer_id: "stephen",
  rationale: "r", review_status: "approved", capture_version_id: "capture_version_x",
  immutable_archive_locator: "hhs-archive://capture/abc", conversation_id: "conversation_x",
  source_conversation_id: "src-conv", message_id: "message_x", sequence: 1, role: "assistant",
  provenance_edge_id: "provenance_edge_x", representation_kind: "canonical_text",
  representation_sha256: "c".repeat(64), text_value: "approved text"
};
const deps: QueryServiceDeps = {
  query: async (_w, question) => ({ question, mode: "deterministic_text_search", trust_scope: "approved_knowledge_only", matches: [fakeMatch] }),
  getKnowledge: async (_w, id) => {
    if (id !== "approved_knowledge_x") throw new Error(`Approved knowledge not found: ${id}`);
    return { approved_knowledge: { approved_knowledge_id: id }, review: { reviewer_id: "stephen", to_status: "approved" }, evidence: [fakeMatch] };
  }
};

let activeServer: ReturnType<typeof createQueryService> | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!activeServer) {
    resolve();
    return;
  }
  activeServer.close(() => {
    activeServer = undefined;
    resolve();
  });
}));

async function startTestServer() {
  const config = loadServiceConfig(baseEnv);
  activeServer = createQueryService(config, deps);
  await new Promise<void>((resolve) => activeServer!.listen(0, LOOPBACK_HOST, resolve));
  const address = activeServer!.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return { base: `http://127.0.0.1:${address.port}`, address };
}

/** Exercise the real HTTP handler without needing permission to bind a socket. */
function requestInProcess(server: ReturnType<typeof createQueryService>, url: string, init: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<Response> {
  return new Promise((resolve) => {
    const request = Object.assign(Readable.from([Buffer.from(init.body ?? "")]), {
      method: init.method ?? "GET", url, headers: init.headers ?? {}, socket: { remoteAddress: "127.0.0.1" }
    });
    let status = 200;
    const response = {
      writeHead: (code: number) => { status = code; },
      end: (bytes: Buffer) => resolve(new Response(bytes.toString("utf8"), { status }))
    };
    server.emit("request", request, response);
  });
}

describe("service environment guard", () => {
  it("refuses admin, ingest, and reviewer credentials", () => {
    for (const name of ["MEMORY_DATABASE_URL", "MEMORY_INGEST_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL"]) {
      expect(() => assertServiceEnvironment({ ...baseEnv, [name]: "postgresql://x:y@127.0.0.1/postgres" })).toThrow(/write-capable credentials/);
    }
  });
  it("requires the report-reader login specifically, on loopback only", () => {
    expect(() => assertServiceEnvironment({ ...baseEnv, MEMORY_REPORT_DATABASE_URL: "postgresql://memory_v1_ingest_login:x@127.0.0.1:55022/postgres" })).toThrow(/report-reader/);
    expect(() => assertServiceEnvironment({ ...baseEnv, MEMORY_REPORT_DATABASE_URL: "postgresql://memory_v1_report_login:x@db.example.invalid/postgres" })).toThrow(/Hosted database/);
    expect(() => assertServiceEnvironment(baseEnv)).not.toThrow();
  });
});

describe("client tokens", () => {
  it("requires named tokens of sufficient length and rejects duplicates", () => {
    expect(() => parseClientTokens("")).toThrow(/at least one client/);
    expect(() => parseClientTokens("hermes:short")).toThrow(/at least 32/);
    expect(() => parseClientTokens(`hermes:${TOKEN},hermes:${TOKEN}`)).toThrow(/unique/);
    expect(parseClientTokens(`hermes:${TOKEN},claude:${"b".repeat(40)}`).map((client) => client.name)).toEqual(["hermes", "claude"]);
  });
  it("authenticates only exact bearer tokens", () => {
    const clients = parseClientTokens(`hermes:${TOKEN}`);
    expect(authenticate(clients, `Bearer ${TOKEN}`)?.name).toBe("hermes");
    expect(authenticate(clients, `Bearer ${"a".repeat(47)}b`)).toBeNull();
    expect(authenticate(clients, undefined)).toBeNull();
    expect(authenticate(clients, TOKEN)).toBeNull();
  });
});

describe("service behavior", () => {
  it("binds to loopback only", async () => {
    const { address } = await startTestServer();
    expect((address as { address: string }).address).toBe("127.0.0.1");
    expect(serviceSource).toMatch(/LOOPBACK_HOST = "127\.0\.0\.1"/);
    expect(serviceSource).toMatch(/listen\(config\.port, LOOPBACK_HOST/);
  });
  it("rejects unauthenticated and wrongly-authenticated requests", async () => {
    const { base } = await startTestServer();
    const missing = await fetch(`${base}/memory/query`, { method: "POST", body: JSON.stringify({ question: "x" }) });
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${base}/memory/query`, { method: "POST", headers: { authorization: `Bearer ${"z".repeat(48)}` }, body: JSON.stringify({ question: "x" }) });
    expect(wrong.status).toBe(401);
  });
  it("returns approved knowledge with exact provenance for valid queries", async () => {
    const { base } = await startTestServer();
    const response = await fetch(`${base}/memory/query`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ question: "approved text" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client).toBe("hermes");
    expect(body.trust_scope).toBe("approved_knowledge_only");
    const match = body.matches[0];
    for (const field of ["approved_knowledge_id", "provenance_edge_id", "message_id", "conversation_id", "capture_version_id", "immutable_archive_locator", "representation_sha256", "reviewer_id", "review_status", "text_value"]) {
      expect(match[field], field).toBeTruthy();
    }
  });
  it("serves knowledge detail and 404s unknown ids", async () => {
    const { base } = await startTestServer();
    const ok = await fetch(`${base}/memory/knowledge/approved_knowledge_x`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const detail = await ok.json();
    expect(detail.review.reviewer_id).toBe("stephen");
    expect(detail.evidence[0].immutable_archive_locator).toMatch(/^hhs-archive:\/\//);
    const missing = await fetch(`${base}/memory/knowledge/approved_knowledge_absent`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(404);
  });
});

describe("credential surface", () => {
  it("uses only read paths from query.ts and never references write-capable roles", () => {
    expect(serviceSource).not.toMatch(/createPool\("(admin|writer|reviewer)"\)/);
    expect(serviceSource).not.toMatch(/MEMORY_INGEST_DATABASE_URL(?!.*Refusing|.*must not)/s);
    expect(serviceSource).toMatch(/FORBIDDEN_ENV_VARS = \["MEMORY_DATABASE_URL", "MEMORY_INGEST_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL"\]/);
    expect(serviceSource).not.toMatch(/\b(insert|update|delete)\s+(into|from)?\s*memory_v1/i);
  });
});

describe("workspace-aware trusted Core queries", () => {
  it("routes only authenticated hhs-core workspace selections and preserves fixed-workspace calls and promotion lineage", async () => {
    const coreToken = "c".repeat(48);
    const hermesToken = "h".repeat(48);
    const requestedWorkspace = "workspace_9e2ecc9d7533c6524dd51b9866031b6e";
    const seenWorkspaces: string[] = [];
    const seenDetails: string[] = [];
    const promotedMatch = { ...fakeMatch, capture_version_id: null, immutable_archive_locator: null,
      conversation_id: null, source_conversation_id: null, message_id: null, sequence: null, role: null,
      provenance_edge_id: null, representation_kind: null, representation_sha256: null,
      promotion_receipt_id: "receipt", source_lineage: [{ source_workspace_id: "source-workspace", reconciliation_id: "reconciliation" }],
      source_lineage_sha256: "d".repeat(64), promoted_value_sha256: "e".repeat(64) };

    const config = {
      workspaceId: "workspace_legacy",
      port: 54431,
      clients: parseClientTokens(`hhs-core:${coreToken},hermes:${hermesToken}`),
    };

    activeServer = createQueryService(config, {
      ...deps,
      query: async (workspace, question) => {
        seenWorkspaces.push(workspace);
        return {
          question,
          mode: "deterministic_text_search",
          trust_scope: "approved_knowledge_only",
          matches: workspace === requestedWorkspace ? [promotedMatch] : [fakeMatch],
        };
      },
      getKnowledge: async (workspace, id) => {
        seenDetails.push(workspace);
        return deps.getKnowledge(workspace, id);
      },
    });

    const core = await requestInProcess(activeServer, `/memory/workspaces/${requestedWorkspace}/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${coreToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "project context", workspace_id: "workspace_untrusted_body" }),
    });

    expect(core.status).toBe(200);
    expect(seenWorkspaces).toEqual([requestedWorkspace]);
    expect(await core.json()).toMatchObject({ workspace_id: requestedWorkspace,
      trust_scope: "approved_knowledge_only", matches: [promotedMatch] });

    const hermes = await requestInProcess(activeServer, `/memory/workspaces/${requestedWorkspace}/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hermesToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "project context" }),
    });

    expect(hermes.status).toBe(403);
    expect(seenWorkspaces).toEqual([requestedWorkspace]);

    const unauthenticated = await requestInProcess(activeServer, `/memory/workspaces/${requestedWorkspace}/query`, {
      method: "POST", body: JSON.stringify({ question: "x" })
    });
    expect(unauthenticated.status).toBe(401);
    const malformed = await requestInProcess(activeServer, "/memory/workspaces/workspace_arbitrary/query", {
      method: "POST", headers: { authorization: `Bearer ${coreToken}` }, body: JSON.stringify({ question: "x" })
    });
    expect(malformed.status).toBe(404);
    expect(seenWorkspaces).toEqual([requestedWorkspace]);

    for (const token of [hermesToken, coreToken]) {
      const legacy = await requestInProcess(activeServer, "/memory/query", {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ question: "legacy", workspace_id: requestedWorkspace })
      });
      expect(legacy.status).toBe(200);
      expect((await legacy.json()).matches).toEqual([fakeMatch]);
    }
    expect(seenWorkspaces).toEqual([requestedWorkspace, config.workspaceId, config.workspaceId]);
    const detail = await requestInProcess(activeServer, `/memory/knowledge/approved_knowledge_x?workspace_id=${requestedWorkspace}`, {
      headers: { authorization: `Bearer ${hermesToken}` }
    });
    expect(detail.status).toBe(404);
    const fixedDetail = await requestInProcess(activeServer, "/memory/knowledge/approved_knowledge_x", {
      headers: { authorization: `Bearer ${hermesToken}` }
    });
    expect(fixedDetail.status).toBe(200);
    expect(seenDetails).toEqual([config.workspaceId]);
  });
});
