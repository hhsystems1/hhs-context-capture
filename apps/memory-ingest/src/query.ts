import { createPool, readOnlyTransaction } from "./db.js";

export interface ApprovedKnowledgeMatch {
  approved_knowledge_id: string;
  knowledge_candidate_id: string;
  pipeline_version: string;
  approved_at: string;
  reviewer_id: string;
  rationale: string;
  review_status: string;
  capture_version_id: string;
  immutable_archive_locator: string;
  conversation_id: string;
  source_conversation_id: string;
  message_id: string;
  sequence: number;
  role: string;
  provenance_edge_id: string;
  representation_kind: string;
  representation_sha256: string;
  text_value: string;
}

export const APPROVED_KNOWLEDGE_QUERY_SQL = `
select distinct
  ak.approved_knowledge_id, ak.knowledge_candidate_id, ak.pipeline_version, ak.approved_at,
  hre.reviewer_id, hre.rationale, hre.to_status as review_status,
  cv.capture_version_id, cv.immutable_archive_locator,
  conv.conversation_id, conv.source_conversation_id,
  m.message_id, m.sequence, m.role,
  pe.provenance_edge_id, pe.representation_kind, pe.representation_sha256,
  rep->>'value' as text_value
from memory_v1.approved_knowledge ak
join memory_v1.human_review_events hre
  on hre.workspace_id=ak.workspace_id and hre.human_review_event_id=ak.approval_event_id
join memory_v1.candidate_evidence ce
  on ce.workspace_id=ak.workspace_id and ce.knowledge_candidate_id=ak.knowledge_candidate_id
join memory_v1.provenance_edges pe
  on pe.workspace_id=ce.workspace_id and pe.provenance_edge_id=ce.provenance_edge_id
join memory_v1.content_blocks b
  on b.workspace_id=pe.workspace_id and b.content_block_id=pe.content_block_id
join memory_v1.messages m
  on m.workspace_id=b.workspace_id and m.message_id=b.message_id
join memory_v1.conversations conv
  on conv.workspace_id=m.workspace_id and conv.conversation_id=m.conversation_id
join memory_v1.capture_versions cv
  on cv.workspace_id=m.workspace_id and cv.capture_version_id=m.capture_version_id
cross join lateral jsonb_array_elements(b.representations) as rep
where rep->>'representation_kind' = pe.representation_kind
  and rep->>'sha256' = pe.representation_sha256
  and ak.workspace_id = $1
  and to_tsvector('english', rep->>'value') @@ plainto_tsquery('english', $2)
order by ak.approved_at desc, m.sequence asc, pe.provenance_edge_id asc
limit $3`;

export interface ApprovedKnowledgeDetail {
  approved_knowledge: Record<string, unknown>;
  review: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
}

const APPROVED_KNOWLEDGE_DETAIL_SQL = `
select ak.approved_knowledge_id, ak.knowledge_candidate_id, ak.approval_event_id, ak.pipeline_version,
       ak.approved_value, ak.approved_value_sha256, ak.provenance_edge_ids, ak.approved_at
from memory_v1.approved_knowledge ak
where ak.workspace_id=$1 and ak.approved_knowledge_id=$2`;

const APPROVED_KNOWLEDGE_EVIDENCE_SQL = `
select pe.provenance_edge_id, pe.relation, pe.representation_kind, pe.representation_sha256,
       cv.capture_version_id, cv.immutable_archive_locator,
       conv.conversation_id, conv.source_conversation_id,
       m.message_id, m.sequence, m.role, b.content_block_id,
       (select rep->>'value' from jsonb_array_elements(b.representations) rep
         where rep->>'representation_kind' = pe.representation_kind
           and rep->>'sha256' = pe.representation_sha256 limit 1) as text_value
from memory_v1.approved_knowledge ak
join memory_v1.candidate_evidence ce
  on ce.workspace_id=ak.workspace_id and ce.knowledge_candidate_id=ak.knowledge_candidate_id
join memory_v1.provenance_edges pe
  on pe.workspace_id=ce.workspace_id and pe.provenance_edge_id=ce.provenance_edge_id
join memory_v1.content_blocks b
  on b.workspace_id=pe.workspace_id and b.content_block_id=pe.content_block_id
join memory_v1.messages m
  on m.workspace_id=b.workspace_id and m.message_id=b.message_id
join memory_v1.conversations conv
  on conv.workspace_id=m.workspace_id and conv.conversation_id=m.conversation_id
join memory_v1.capture_versions cv
  on cv.workspace_id=m.workspace_id and cv.capture_version_id=m.capture_version_id
where ak.workspace_id=$1 and ak.approved_knowledge_id=$2
order by m.sequence asc, pe.provenance_edge_id asc`;

export async function getApprovedKnowledge(workspaceId: string, approvedKnowledgeId: string): Promise<ApprovedKnowledgeDetail> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      const record = await client.query(APPROVED_KNOWLEDGE_DETAIL_SQL, [workspaceId, approvedKnowledgeId]);
      if (!record.rowCount) throw new Error(`Approved knowledge not found: ${approvedKnowledgeId}`);
      const review = await client.query(
        "select human_review_event_id, reviewer_id, from_status, to_status, rationale, occurred_at from memory_v1.human_review_events where workspace_id=$1 and human_review_event_id=$2",
        [workspaceId, String(record.rows[0].approval_event_id)]);
      const evidence = await client.query(APPROVED_KNOWLEDGE_EVIDENCE_SQL, [workspaceId, approvedKnowledgeId]);
      return { approved_knowledge: record.rows[0], review: review.rows[0] ?? {}, evidence: evidence.rows };
    });
  } finally { await pool.end(); }
}

export async function queryApprovedKnowledge(workspaceId: string, question: string, limit = 20): Promise<{ question: string; mode: string; trust_scope: string; matches: ApprovedKnowledgeMatch[] }> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("A query question is required.");
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      const result = await client.query(APPROVED_KNOWLEDGE_QUERY_SQL, [workspaceId, trimmed, bounded]);
      return {
        question: trimmed,
        mode: "deterministic_text_search",
        trust_scope: "approved_knowledge_only",
        matches: result.rows as ApprovedKnowledgeMatch[]
      };
    });
  } finally { await pool.end(); }
}
