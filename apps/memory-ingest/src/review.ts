import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert, readOnlyTransaction, transaction, type DbClient } from "./db.js";

export interface ProposedCandidateSummary {
  knowledge_candidate_id: string;
  pipeline_version: string;
  kind: string;
  created_at: string;
  chunk_id: string | null;
  promotion_receipt_id: string | null;
  evidence_count: number;
  promoted_at: string | null;
}

export interface CandidateEvidenceLine {
  provenance_edge_id: string;
  relation: string;
  representation_kind: string;
  representation_sha256: string;
  capture_version_id: string;
  immutable_archive_locator: string;
  conversation_id: string;
  source_conversation_id: string;
  message_id: string;
  sequence: number;
  role: string;
  text_value: string | null;
}

export interface CandidateDetail {
  candidate: Record<string, unknown>;
  review_events: Array<Record<string, unknown>>;
  evidence: CandidateEvidenceLine[];
  promotion_receipt?: Record<string, unknown>;
}

export interface ReviewDecisionInput {
  workspaceId: string;
  candidateId: string;
  reviewerId: string;
  rationale: string;
}

export interface ReviewDecisionResult {
  knowledge_candidate_id: string;
  pipeline_version: string;
  human_review_event_id: string;
  to_status: "approved" | "rejected";
  reviewer_id: string;
  occurred_at: string;
  approved_knowledge_id?: string;
  provenance_edge_count?: number;
}

const EVIDENCE_SQL = `
select pe.provenance_edge_id, pe.relation, pe.representation_kind, pe.representation_sha256,
       cv.capture_version_id, cv.immutable_archive_locator,
       conv.conversation_id, conv.source_conversation_id,
       m.message_id, m.sequence, m.role,
       (select rep->>'value' from jsonb_array_elements(b.representations) rep
         where rep->>'representation_kind' = pe.representation_kind
           and rep->>'sha256' = pe.representation_sha256 limit 1) as text_value
from memory_v1.candidate_evidence ce
join memory_v1.provenance_edges pe on pe.workspace_id=ce.workspace_id and pe.provenance_edge_id=ce.provenance_edge_id
join memory_v1.content_blocks b on b.workspace_id=pe.workspace_id and b.content_block_id=pe.content_block_id
join memory_v1.messages m on m.workspace_id=b.workspace_id and m.message_id=b.message_id
join memory_v1.conversations conv on conv.workspace_id=m.workspace_id and conv.conversation_id=m.conversation_id
join memory_v1.capture_versions cv on cv.workspace_id=m.workspace_id and cv.capture_version_id=m.capture_version_id
where ce.workspace_id=$1 and ce.knowledge_candidate_id=$2
order by m.sequence asc, pe.provenance_edge_id asc`;

export async function listProposedCandidates(workspaceId: string): Promise<ProposedCandidateSummary[]> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      return listProposedCandidatesFromClient(client, workspaceId);
    });
  } finally { await pool.end(); }
}

export async function showCandidate(workspaceId: string, candidateId: string): Promise<CandidateDetail> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      return showCandidateFromClient(client, workspaceId, candidateId);
    });
  } finally { await pool.end(); }
}

export async function approveCandidate(input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
  return recordDecision(input, "approved");
}

export async function rejectCandidate(input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
  return recordDecision(input, "rejected");
}

async function recordDecision(input: ReviewDecisionInput, toStatus: "approved" | "rejected"): Promise<ReviewDecisionResult> {
  const { workspaceId } = input;
  if (!input.reviewerId.trim()) throw new Error("A reviewer identity is required.");
  if (!input.rationale.trim()) throw new Error("A review rationale is required.");
  const pool = createPool("reviewer");
  try {
    return await transaction(pool, workspaceId, async (client) => {
      return recordDecisionFromClient(client, input, toStatus);
    });
  } finally { await pool.end(); }
}

export function immutableRow(kind: string, workspaceId: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> {
  const body = { ...fields, idempotency_key: idempotencyKey(kind, workspaceId, natural) };
  return { ...body, record_sha256: sha256(body) };
}

/** Transaction-scoped decision worker; caller owns commit/rollback. */
export async function recordDecisionFromClient(client: DbClient, input: ReviewDecisionInput, toStatus: "approved" | "rejected"): Promise<ReviewDecisionResult> {
  const { workspaceId, candidateId } = input;
  if (!input.reviewerId.trim()) throw new Error("A reviewer identity is required.");
  if (!input.rationale.trim()) throw new Error("A review rationale is required.");
  const candidate = await client.query(
    "select knowledge_candidate_id, pipeline_version, kind, status, promotion_receipt_id, proposed_value, proposed_value_sha256 from memory_v1.knowledge_candidates where workspace_id=$1 and knowledge_candidate_id=$2",
    [workspaceId, candidateId]);
  if (!candidate.rowCount) throw new Error(`Knowledge candidate not found: ${candidateId}`);
  const row = candidate.rows[0];
  if (row.status !== "proposed") throw new Error(`Candidate status is '${row.status}', not 'proposed'.`);
  const prior = await client.query(
    "select human_review_event_id, to_status, reviewer_id, occurred_at from memory_v1.human_review_events where workspace_id=$1 and knowledge_candidate_id=$2",
    [workspaceId, candidateId]);
  if (prior.rowCount) {
    const decided = prior.rows[0];
    throw new Error(`Candidate already reviewed: ${decided.to_status} by ${decided.reviewer_id} at ${decided.occurred_at instanceof Date ? decided.occurred_at.toISOString() : decided.occurred_at}. Review history is append-only and is never overwritten.`);
  }
  const occurredAt = new Date().toISOString();
  const eventNatural = [candidateId];
  const eventId = deterministicId("human_review_event", workspaceId, eventNatural);
  const eventCore = {
    workspace_id: workspaceId, human_review_event_id: eventId, knowledge_candidate_id: candidateId,
    pipeline_version: row.pipeline_version, actor_kind: "human", reviewer_id: input.reviewerId.trim(),
    from_status: "proposed", to_status: toStatus, rationale: input.rationale.trim(), occurred_at: occurredAt
  };
  await immutableInsert(client, "human_review_events", "human_review_event_id",
    immutableRow("human_review_event", workspaceId, eventNatural, { ...eventCore, event_sha256: sha256(eventCore) }));

  const result: ReviewDecisionResult = {
    knowledge_candidate_id: candidateId, pipeline_version: row.pipeline_version,
    human_review_event_id: eventId, to_status: toStatus, reviewer_id: eventCore.reviewer_id, occurred_at: occurredAt
  };
  if (toStatus !== "approved") return result;

  const edges = await client.query(
    "select provenance_edge_id from memory_v1.candidate_evidence where workspace_id=$1 and knowledge_candidate_id=$2 order by provenance_edge_id asc",
    [workspaceId, candidateId]);
  const receipt = await loadCandidatePromotionReceipt(client, workspaceId, row);
  if (!receipt && !edges.rowCount) throw new Error("Approval requires at least one provenance edge; candidate has no evidence.");
  const edgeIds = receipt ? [] : edges.rows.map((edge) => String(edge.provenance_edge_id));
  const approvedNatural = [candidateId];
  const approvedId = deterministicId("approved_knowledge", workspaceId, approvedNatural);
  await immutableInsert(client, "approved_knowledge", "approved_knowledge_id",
    immutableRow("approved_knowledge", workspaceId, approvedNatural, {
      workspace_id: workspaceId, approved_knowledge_id: approvedId, knowledge_candidate_id: candidateId,
      approval_event_id: eventId, pipeline_version: row.pipeline_version,
      approved_value: row.proposed_value, approved_value_sha256: row.proposed_value_sha256,
      provenance_edge_ids: edgeIds, approved_at: occurredAt
    }));
  return { ...result, approved_knowledge_id: approvedId, provenance_edge_count: edgeIds.length };
}

export async function loadCandidatePromotionReceipt(client: DbClient, workspaceId: string, candidate: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (!candidate.promotion_receipt_id) return undefined;
  const result = await client.query("select * from memory_v1.promotion_receipts where workspace_id=$1 and promotion_receipt_id=$2 and pipeline_version=$3", [workspaceId, candidate.promotion_receipt_id, candidate.pipeline_version]);
  if (result.rowCount !== 1) throw new Error("Candidate promotion receipt not found in destination workspace.");
  const receipt = result.rows[0];
  if (receipt.kind !== candidate.kind || sha256(receipt.promoted_value) !== candidate.proposed_value_sha256 ||
      receipt.promoted_value_sha256 !== candidate.proposed_value_sha256 || sha256(candidate.proposed_value) !== candidate.proposed_value_sha256 ||
      sha256(receipt.source_lineage) !== receipt.source_lineage_sha256) {
    throw new Error("Candidate promotion receipt integrity mismatch.");
  }
  const { record_sha256: hash, ...body } = receipt;
  delete body.promoted_at; // Issuance time is outside the deterministic hash.
  if (body.created_at instanceof Date) body.created_at = body.created_at.toISOString();
  if (sha256(body) !== hash) throw new Error("Candidate promotion receipt immutable hash mismatch.");
  return receipt;
}

export async function listProposedCandidatesFromClient(client: DbClient, workspaceId: string): Promise<ProposedCandidateSummary[]> {
  const result = await client.query(`
    select k.knowledge_candidate_id, k.pipeline_version, k.kind, k.created_at, k.chunk_id, k.promotion_receipt_id, p.promoted_at,
           (select count(*) from memory_v1.candidate_evidence ce
             where ce.workspace_id=k.workspace_id and ce.knowledge_candidate_id=k.knowledge_candidate_id)::int as evidence_count
    from memory_v1.knowledge_candidates k
    left join memory_v1.promotion_receipts p
      on (p.workspace_id,p.promotion_receipt_id,p.pipeline_version)=(k.workspace_id,k.promotion_receipt_id,k.pipeline_version)
    where k.workspace_id=$1
      and not exists (select 1 from memory_v1.human_review_events e
        where e.workspace_id=k.workspace_id and e.knowledge_candidate_id=k.knowledge_candidate_id)
    order by coalesce(p.promoted_at,k.created_at) asc, k.knowledge_candidate_id asc`, [workspaceId]);
  return result.rows as ProposedCandidateSummary[];
}

export async function showCandidateFromClient(client: DbClient, workspaceId: string, candidateId: string): Promise<CandidateDetail> {
  const candidate = await client.query(
    "select * from memory_v1.knowledge_candidates where workspace_id=$1 and knowledge_candidate_id=$2",
    [workspaceId, candidateId]);
  if (!candidate.rowCount) throw new Error(`Knowledge candidate not found: ${candidateId}`);
  const events = await client.query(
    "select human_review_event_id, reviewer_id, from_status, to_status, rationale, occurred_at from memory_v1.human_review_events where workspace_id=$1 and knowledge_candidate_id=$2 order by occurred_at asc",
    [workspaceId, candidateId]);
  const evidence = await client.query(EVIDENCE_SQL, [workspaceId, candidateId]);
  const receipt = await loadCandidatePromotionReceipt(client, workspaceId, candidate.rows[0]);
  return { candidate: candidate.rows[0], review_events: events.rows, evidence: evidence.rows as CandidateEvidenceLine[], ...(receipt ? { promotion_receipt: receipt } : {}) };
}
