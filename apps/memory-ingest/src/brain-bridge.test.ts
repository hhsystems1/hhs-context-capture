import { Readable } from "node:stream";
import type http from "node:http";
import { describe, it, expect } from "vitest";
import { parseClientTokens } from "./query-service.js";
import { createIntegrationService, loadIntegrationConfig, parseReconcileInput, reconcileAndPromoteFromClient } from "./brain-integration-service.js";
import { createReviewService, loadReviewConfig, assertPersonalReviewSnapshots } from "./brain-review-service.js";
import { parseBrainGrants, type BridgeConfig } from "./brain-bridge-http.js";
import type { DbClient } from "./db.js";
import { sha256 } from "@hhs/memory-schema";
const token = "a".repeat(48);
const grant = { sourceRef: "history", sourceWorkspaceId: "proof-workspace", destinationWorkspaceId: `workspace_${"a".repeat(32)}`, targetRef: "11111111-1111-4111-8111-111111111111" };
const config: BridgeConfig = { port: 54434, clients: parseClientTokens(`hhs-core:${token}`), grants: [grant] };
const input = { conversation: "conversation_1", observationIds: ["observation_1"], statement: "Historical Sidekick vision.", kind: "idea", temporalStatus: "historical" };
const saved = { reconciliation_id: "reconciliation_1", promotion_receipt_id: "receipt_1", knowledge_candidate_id: "candidate_1", replay: false, status: "proposed", authority: "user", temporal_status: "historical" as const };
async function request(server: http.Server, route: string, body: unknown, origin?: string, presented = token) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  Object.assign(req, { method: "POST", url: route, headers: { host: "127.0.0.1:54434", "content-type": "application/json", authorization: `Bearer ${presented}`, ...(origin ? { origin } : {}) }, socket: { remoteAddress: "127.0.0.1" } });
  return new Promise<{ status: number; body: unknown }>(resolve => {
    let status = 0;
    server.emit("request", req, { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } });
  });
}
describe("trusted brain integration and dedicated review bridges", () => {
  it("rejects malformed grants and shared credentials instead of gaining privilege", () => {
    expect(parseBrainGrants(JSON.stringify([grant]))).toEqual([grant]);
    for (const value of [[grant, grant], [{ ...grant, sourceWorkspaceId: "../archive" }], [{ ...grant, unexpected: true }]]) expect(() => parseBrainGrants(JSON.stringify(value))).toThrow();
    const ingest = "postgresql://memory_v1_ingest_login:synthetic@127.0.0.1:54322/postgres";
    const report = "postgresql://memory_v1_report_login:synthetic@127.0.0.1:54322/postgres";
    const review = "postgresql://memory_v1_review_login:synthetic@127.0.0.1:54322/postgres";
    expect(loadIntegrationConfig({ MEMORY_INGEST_DATABASE_URL: ingest, MEMORY_CONTEXT_INTEGRATION_TOKENS: `hhs-core:${token}` }).port).toBe(54434);
    expect(() => loadIntegrationConfig({ MEMORY_INGEST_DATABASE_URL: ingest, MEMORY_REVIEW_DATABASE_URL: review })).toThrow();
    expect(loadReviewConfig({ MEMORY_REPORT_DATABASE_URL: report, MEMORY_REVIEW_DATABASE_URL: review, MEMORY_CONTEXT_REVIEW_TOKENS: `hhs-core:${token}` }).port).toBe(54435);
    expect(() => loadReviewConfig({ MEMORY_REPORT_DATABASE_URL: report, MEMORY_REVIEW_DATABASE_URL: review, MEMORY_INGEST_DATABASE_URL: ingest })).toThrow();
  });
  it("forwards only the operator-authorized source/destination pair and bounded selected observations", async () => {
    const calls: unknown[] = [];
    const server = createIntegrationService(config, async (...args) => { calls.push(args); return saved; });
    expect((await request(server, "/memory/integration/reconcile", { ...grant, ...input, sourceWorkspaceId: undefined })).status).toBe(200);
    expect(calls).toEqual([[grant, input]]);
    server.close();
  });
  it("denies forged destination, direct browser calls, missing tokens, arbitrary source workspace and oversized bodies", async () => {
    let calls = 0;
    const server = createIntegrationService(config, async () => { calls++; return saved; });
    const body = { sourceRef: grant.sourceRef, destinationWorkspaceId: grant.destinationWorkspaceId, targetRef: grant.targetRef, ...input };
    for (const [value, origin, presented, status] of [
      [{ ...body, destinationWorkspaceId: `workspace_${"b".repeat(32)}` }, undefined, token, 403],
      [body, "http://localhost:3000", token, 403], [body, undefined, "bad", 401],
      [{ ...body, sourceWorkspaceId: grant.sourceWorkspaceId }, undefined, token, 400],
      [{ ...body, statement: "x".repeat(40000) }, undefined, token, 413],
    ] as const) expect((await request(server, "/memory/integration/reconcile", value, origin, presented)).status).toBe(status);
    expect(calls).toBe(0); server.close();
  });
  it("checks observation membership before reading or persisting reconciliation", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rowCount: 0, rows: [] }; } } as unknown as DbClient;
    await expect(reconcileAndPromoteFromClient(client, grant, parseReconcileInput(input))).rejects.toMatchObject({ status: 404 });
    expect(calls.some(sql => sql.includes("insert"))).toBe(false);
  });
  it("does not let an unsupported user finding borrow authority from another supported finding", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("c.source_conversation_id")) return { rowCount: 2, rows: [{ observation_id: "observation_1" }, { observation_id: "observation_2" }] };
      if (sql.includes("array_agg")) return { rowCount: 2, rows: ["observation_1", "observation_2"].map(observation_id => ({ observation_id, pipeline_version: "discovery/1", observation_kind: "claim", payload: { statement: "A supported Sidekick requirement", attribution: { subject: "user", claim_type: "claim" } }, created_at: "2026-10-11T00:00:00Z", evidence_roles: ["user"], record_sha256: "a".repeat(64) })) };
      if (sql.includes("order by p.provenance_edge_id")) { const text = values?.[1] === "observation_1" ? "A supported Sidekick requirement" : "Something unrelated about a holiday"; return { rowCount: 1, rows: [{ relation: "quotes", role: "user", text_value: text, representation_sha256: sha256(text) }] }; }
      return { rowCount: 0, rows: [] };
    } } as unknown as DbClient;
    await expect(reconcileAndPromoteFromClient(client, grant, parseReconcileInput({ ...input, observationIds: ["observation_1", "observation_2"] }))).rejects.toMatchObject({ status: 422 });
    expect(calls.some(sql => sql.includes("insert"))).toBe(false);
  });
  it("uses trusted reviewer identity and rejects impersonation keys or mixed service routes", async () => {
    const calls: unknown[] = [];
    const server = createReviewService(config, async () => { throw new Error("Unexpected inspect"); }, async (...args) => { calls.push(args); return { knowledge_candidate_id: "candidate_1", to_status: "approved", replay: false }; });
    const body = { sourceRef: grant.sourceRef, destinationWorkspaceId: grant.destinationWorkspaceId, targetRef: grant.targetRef, candidateId: "candidate_1", decision: "approved", rationale: "Original evidence checked." };
    expect((await request(server, "/memory/review/decide", body)).status).toBe(200);
    expect(calls).toEqual([[grant, "candidate_1", "approved", body.rationale]]);
    expect((await request(server, "/memory/review/decide", { ...body, reviewerId: "another-user" })).status).toBe(400);
    expect((await request(server, "/memory/integration/reconcile", body)).status).toBe(404);
    server.close();
  });
});

it('Personal message review uses verified receipt snapshots, not the metadata-free resolution DTO',()=>{
 const resolved={observation_id:'obs',provenance_edge_id:'edge',representation_sha256:'a'.repeat(64),text_value:'Original user declaration'};
 const snapshot={provenance_edge_id:resolved.provenance_edge_id,role:'user',source_metadata:{source_family:'rivryn_chat'}};
 expect(()=>assertPersonalReviewSnapshots(grant,grant.destinationWorkspaceId,[snapshot])).not.toThrow();
 expect(()=>assertPersonalReviewSnapshots(grant,grant.destinationWorkspaceId,[resolved])).toThrow();
 expect(()=>assertPersonalReviewSnapshots(grant,grant.destinationWorkspaceId,[{...snapshot,role:'assistant'}])).toThrow();
 expect(()=>assertPersonalReviewSnapshots(grant,grant.destinationWorkspaceId,[{...snapshot,source_metadata:{source_family:'other'}}])).toThrow();
});
