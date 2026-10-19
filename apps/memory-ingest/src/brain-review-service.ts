import { pathToFileURL } from "node:url";
import { sha256 } from "@hhs/memory-schema";
import { createPool, readOnlyTransaction, transaction } from "./db.js";
import { assertLocalDatabaseUrl } from "./config.js";
import { showCandidateFromClient, listProposedCandidatesFromClient, recordDecisionFromClient } from "./review.js";
import { resolvePromotionEvidenceFromClient } from "./promotion.js";
import { bridgeConfig, bridgeServer, BridgeError, grantFor, exactKeys, safeRef, type BrainGrant, type BridgeConfig } from "./brain-bridge-http.js";

export function loadReviewConfig(env: Record<string, string | undefined>) {
  if (["MEMORY_DATABASE_URL", "MEMORY_INGEST_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS", "MEMORY_CONTEXT_INTEGRATION_TOKENS"].some(key => env[key]?.trim())) throw new Error("Review requires separate report/reviewer credentials.");
  if (assertLocalDatabaseUrl(env.MEMORY_REPORT_DATABASE_URL ?? "").username !== "memory_v1_report_login" ||
    assertLocalDatabaseUrl(env.MEMORY_REVIEW_DATABASE_URL ?? "").username !== "memory_v1_review_login") throw new Error("Review requires existing report/reviewer logins.");
  return bridgeConfig(env, "MEMORY_CONTEXT_REVIEW", 54435);
}
// resolvePromotionEvidence returns only identities/text. Role/family live in the
// receipt snapshots it has just hash-verified; never read them from its DTO.
export function assertPersonalReviewSnapshots(grant:BrainGrant,sourceWorkspace:string,snapshots:Array<Record<string,unknown>>) {
  if(sourceWorkspace===grant.destinationWorkspaceId && (!snapshots.length||snapshots.some(item=>(item.source_metadata as Record<string,unknown>)?.source_family!=='rivryn_chat'||item.role!=='user')))throw new BridgeError(403,'scope_denied');
}
export async function inspectCandidate(grant: BrainGrant, candidateId?: string) {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, grant.destinationWorkspaceId, async client => {
      await client.query("set local statement_timeout=5000");
      if (!candidateId) {
        const candidates = await listProposedCandidatesFromClient(client, grant.destinationWorkspaceId);
        return { view: "candidates", candidates: candidates.slice(0, 50).map(row => ({ knowledge_candidate_id: row.knowledge_candidate_id,
          kind: row.kind, created_at: new Date(row.created_at).toISOString(), promoted_at: row.promoted_at ? new Date(row.promoted_at).toISOString() : null })),
          more_available: candidates.length > 50 };
      }
      const detail = await showCandidateFromClient(client, grant.destinationWorkspaceId, candidateId);
      if (!detail.promotion_receipt) throw new BridgeError(404, "candidate_not_found");
      const destination=(detail.promotion_receipt.promoted_value as Record<string,unknown>)?.destination as Record<string,unknown>;
      if(destination?.brain_type!=='personal'||destination.workspace_id!==grant.destinationWorkspaceId||destination.target_ref!==grant.targetRef)throw new BridgeError(403,'scope_denied');
      const receiptSources=detail.promotion_receipt.source_lineage as Array<Record<string,unknown>>;
      const sourceWorkspace=receiptSources[0]?.source_workspace_id;
      if(receiptSources.length!==1 || ![grant.sourceWorkspaceId,grant.destinationWorkspaceId].includes(String(sourceWorkspace)))throw new BridgeError(403,'scope_denied');
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [sourceWorkspace]);
      const resolved = await resolvePromotionEvidenceFromClient(client, String(sourceWorkspace), detail.promotion_receipt);
      const lineage = detail.promotion_receipt.source_lineage as Array<Record<string, unknown>>;
      const snapshots = lineage.flatMap(source => (source.observations as Array<Record<string, unknown>>)
        .flatMap(observation => observation.evidence as Array<Record<string, unknown>>));
      assertPersonalReviewSnapshots(grant,String(sourceWorkspace),snapshots);
      const value = detail.candidate.proposed_value as Record<string, unknown>;
      return { view: "candidate", knowledge_candidate_id: candidateId, kind: detail.candidate.kind,
        statement: value.statement, authority: value.authority, temporal_status: value.temporal_status,
        status: detail.review_events[0]?.to_status ?? "proposed", promotion_receipt_id: detail.candidate.promotion_receipt_id,
        review_events: detail.review_events.map(event => ({ to_status: event.to_status, rationale: event.rationale, occurred_at: new Date(String(event.occurred_at)).toISOString() })),
        evidence: resolved.slice(0, 50).map(item => {
          const snapshot = snapshots.find(edge => edge.provenance_edge_id === item.provenance_edge_id)!;
          const text = String(item.text_value);
          return { observation_id: item.observation_id, provenance_edge_id: item.provenance_edge_id,
            source_conversation_id: (snapshot.source_metadata as Record<string, unknown>).source_conversation_id, message_id: snapshot.message_id,
            role: snapshot.role, sequence: snapshot.sequence, representation_sha256: item.representation_sha256,
            ...((snapshot.source_metadata as Record<string,unknown>).source_family==='rivryn_chat' ? {source_message_id:snapshot.source_message_id,source_created_at:(snapshot.source_metadata as Record<string,unknown>).source_observed_at} : {}),
            excerpt: text.slice(0, 2400), full_length: text.length, truncated: text.length > 2400, verification: "hash_matched" };
        }), evidence_truncated: resolved.length > 50 };
    });
  } finally { await pool.end(); }
}
export async function decideCandidate(grant: BrainGrant, candidateId: string, decision: "approved" | "rejected", rationale: string) {
  // Revalidate the source receipt before accepting a human decision. Reader and
  // reviewer use separate transactions/credentials; no source contents are copied.
  await inspectCandidate(grant, candidateId);
  const pool = createPool("reviewer");
  try {
    return await transaction(pool, grant.destinationWorkspaceId, async client => {
      await client.query("set local statement_timeout=10000");
      await client.query("set local lock_timeout=5000");
      await client.query("select pg_advisory_xact_lock($1::bigint)", [BigInt.asIntN(64, BigInt(`0x${sha256([grant.destinationWorkspaceId, candidateId]).slice(0, 16)}`)).toString()]);
      const prior = await client.query("select to_status,reviewer_id,rationale from memory_v1.human_review_events where workspace_id=$1 and knowledge_candidate_id=$2", [grant.destinationWorkspaceId, candidateId]);
      if (prior.rowCount) {
        if (prior.rows[0].to_status !== decision || prior.rows[0].reviewer_id !== grant.targetRef || prior.rows[0].rationale !== rationale) throw new BridgeError(409, "already_reviewed");
        return { knowledge_candidate_id: candidateId, to_status: decision, replay: true };
      }
      const result = await recordDecisionFromClient(client, { workspaceId: grant.destinationWorkspaceId, candidateId, reviewerId: grant.targetRef, rationale }, decision);
      return { knowledge_candidate_id: candidateId, to_status: result.to_status, replay: false };
    });
  } finally { await pool.end(); }
}
export function createReviewService(config: BridgeConfig, inspect = inspectCandidate, decide = decideCandidate) {
  return bridgeServer(config, async (method, route, body) => {
    if (method !== "POST" || !["/memory/review/inspect", "/memory/review/decide"].includes(route)) throw new BridgeError(404, "unknown_route");
    exactKeys(body, ["sourceRef", "destinationWorkspaceId", "targetRef", "candidateId", ...(route.endsWith("decide") ? ["decision", "rationale"] : [])]);
    if (body.candidateId !== undefined && !safeRef(body.candidateId)) throw new BridgeError(400, "invalid_request");
    const grant = grantFor(config, body);
    if (route.endsWith("inspect")) return inspect(grant, body.candidateId as string | undefined);
    if (!safeRef(body.candidateId) || !["approved", "rejected"].includes(String(body.decision)) || typeof body.rationale !== "string" ||
      !body.rationale.trim() || body.rationale.length > 2000) throw new BridgeError(400, "invalid_request");
    return decide(grant, body.candidateId, body.decision as "approved" | "rejected", body.rationale.trim());
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadReviewConfig(process.env);
  createReviewService(config).listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ service: "brain-review", port: config.port, database_role: "report/reviewer", status: "ready" })));
}
