import { sha256 } from "@hhs/memory-schema";
import { createPool, readOnlyTransaction, type DbClient } from "./db.js";
import { prepareReconciliationInputFromClient, hasSupportingUserEvidence } from "./reconciliation.js";

// Read models over existing immutable observations/provenance. No new queue,
// ontology, evidence store, reconciliation or approval authority.
export interface HistoryInput { conversation?: string; observation?: string; cursor?: string }
export class SourceHistoryNotFound extends Error {}
const PAGE_SIZE = 50;
const EXCERPT_LIMIT = 2400;

export const HISTORY_CONVERSATIONS_SQL = `select c.source_conversation_id,
  c.title_representation->>'value' title, count(o.observation_id)::int observations_count
  from memory_v1.conversations c
  join memory_v1.observations o on o.workspace_id=c.workspace_id and o.conversation_id=c.conversation_id
  where c.workspace_id=$1 and ($2::text is null or c.source_conversation_id > $2)
  group by c.source_conversation_id,c.title_representation
  order by c.source_conversation_id limit $3`;

export async function readSourceHistory(workspace: string, input: HistoryInput) {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspace, client => readSourceHistoryFromClient(client, workspace, input));
  } finally { await pool.end(); }
}

export async function readSourceHistoryFromClient(client: DbClient, workspace: string, input: HistoryInput) {
  await client.query("set local statement_timeout = 5000");
  await client.query("set local lock_timeout = 2000");
  if (!input.conversation) {
    const result = await client.query(HISTORY_CONVERSATIONS_SQL, [workspace, input.cursor ?? null, PAGE_SIZE + 1]);
    const conversations = result.rows.slice(0, PAGE_SIZE).map(row => ({
      source_conversation_id: String(row.source_conversation_id),
      title: row.title === null ? null : String(row.title), observations_count: Number(row.observations_count)
    }));
    return { view: "conversations" as const, conversations,
      next_cursor: result.rows.length > PAGE_SIZE ? conversations.at(-1)!.source_conversation_id : null };
  }
  const found = await client.query(`select c.conversation_id,c.source_conversation_id,
    c.title_representation->>'value' title,count(o.observation_id)::int observations_count
    from memory_v1.conversations c
    join memory_v1.observations o on o.workspace_id=c.workspace_id and o.conversation_id=c.conversation_id
    where c.workspace_id=$1 and c.source_conversation_id=$2
    group by c.conversation_id,c.source_conversation_id,c.title_representation`, [workspace, input.conversation]);
  if (found.rowCount !== 1) throw new SourceHistoryNotFound();
  const row = found.rows[0];
  const conversation = { source_conversation_id: String(row.source_conversation_id),
    title: row.title === null ? null : String(row.title), observations_count: Number(row.observations_count) };
  if (input.observation) {
    // Conversation membership is verified before resolving any observation evidence.
    const selected = await client.query(`select observation_id,pipeline_version from memory_v1.observations
      where workspace_id=$1 and conversation_id=$2 and observation_id=$3`, [workspace, row.conversation_id, input.observation]);
    if (selected.rowCount !== 1) throw new SourceHistoryNotFound();
    const result = await client.query(HISTORY_EVIDENCE_SQL,
      [workspace, input.observation, selected.rows[0].pipeline_version, input.cursor ?? null, PAGE_SIZE + 1]);
    const evidence = result.rows.slice(0, PAGE_SIZE).map(sourceEvidence);
    return { view: "evidence" as const, conversation, observation_id: input.observation, evidence,
      next_cursor: result.rows.length > PAGE_SIZE ? evidence.at(-1)!.provenance_edge_id : null };
  }
  const result = await client.query(`select observation_id,status,payload from memory_v1.observations
    where workspace_id=$1 and conversation_id=$2 and ($3::text is null or observation_id > $3)
    order by observation_id limit $4`, [workspace, row.conversation_id, input.cursor ?? null, PAGE_SIZE + 1]);
  const rows = result.rows.slice(0, PAGE_SIZE);
  const trusted = rows.length ? await prepareReconciliationInputFromClient(client, workspace, rows.map(item => String(item.observation_id))) : null;
  const observations = (trusted?.observations ?? []).map((observation, index) => ({
    observation_id: observation.observation_id, pipeline_version: observation.pipeline_version,
    observation_kind: observation.observation_kind, statement: observation.statement,
    attribution: observation.attribution, evidence_roles: observation.evidence_roles,
    user_evidence_supported: hasSupportingUserEvidence([{ observation_id: observation.observation_id, relation: "supports" }], [observation]),
    created_at: observation.created_at, record_sha256: observation.record_sha256,
    status: String(rows[index]!.status),
    confidence: typeof rows[index]!.payload.confidence === "number" ? rows[index]!.payload.confidence : null
  }));
  return { view: "observations" as const, conversation, observations,
    next_cursor: result.rows.length > PAGE_SIZE ? observations.at(-1)!.observation_id : null };
}

export function sourceEvidence(row: Record<string, unknown>) {
  const text = row.text_value;
  if (typeof text !== "string" || sha256(text) !== row.representation_sha256 || row.verification_status !== "complete") {
    throw new Error("Source evidence verification failed.");
  }
  return {
    provenance_edge_id: String(row.provenance_edge_id), source_conversation_id: String(row.source_conversation_id),
    message_id: String(row.message_id), sequence: Number(row.sequence), role: String(row.role), relation: String(row.relation),
    source_version_id: row.source_version_id === null ? null : String(row.source_version_id),
    capture_version_id: row.capture_version_id === null ? null : String(row.capture_version_id),
    representation_kind: String(row.representation_kind), representation_sha256: String(row.representation_sha256),
    excerpt: text.slice(0, EXCERPT_LIMIT), full_length: text.length, truncated: text.length > EXCERPT_LIMIT,
    verification: "hash_matched" as const
  };
}

// Reuses the exact workspace/version/message/representation linkage employed by
// prepareReconciliationInputFromClient. Only verified excerpts leave this read boundary.
export const HISTORY_EVIDENCE_SQL = `select p.provenance_edge_id,p.relation,p.representation_kind,p.representation_sha256,
  p.source_version_id,p.capture_version_id,c.source_conversation_id,m.message_id,m.sequence,m.role,
  coalesce(sv.verification_status,cv.verification_status) verification_status,
  (select rep->>'value' from jsonb_array_elements(b.representations) rep
    where rep->>'representation_kind'=p.representation_kind and rep->>'sha256'=p.representation_sha256 limit 1) text_value
  from memory_v1.provenance_edges p
  join memory_v1.content_blocks b on b.workspace_id=p.workspace_id and b.content_block_id=p.content_block_id
    and b.message_id=p.message_id and b.source_record_id=p.source_record_id
    and b.capture_version_id is not distinct from p.capture_version_id and b.source_version_id is not distinct from p.source_version_id
  join memory_v1.messages m on m.workspace_id=p.workspace_id and m.message_id=p.message_id and m.conversation_id=p.conversation_id
    and m.capture_version_id is not distinct from p.capture_version_id and m.source_version_id is not distinct from p.source_version_id
  join memory_v1.conversations c on c.workspace_id=m.workspace_id and c.conversation_id=m.conversation_id
  left join memory_v1.source_versions sv on sv.workspace_id=p.workspace_id and sv.source_version_id=p.source_version_id
  left join memory_v1.capture_versions cv on cv.workspace_id=p.workspace_id and cv.capture_version_id=p.capture_version_id
  where p.workspace_id=$1 and p.target_record_id=$2 and p.pipeline_version=$3 and p.target_record_type='observation'
    and ($4::text is null or p.provenance_edge_id > $4)
  order by p.provenance_edge_id limit $5`;
