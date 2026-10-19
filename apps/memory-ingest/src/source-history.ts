import { sha256 } from "@hhs/memory-schema";
import { createPool, readOnlyTransaction, type DbClient } from "./db.js";
import { prepareReconciliationInputFromClient, hasSupportingUserEvidence } from "./reconciliation.js";

// Read models over existing immutable observations/provenance. No new queue,
// ontology, evidence store, reconciliation or approval authority.
export interface HistoryInput { conversation?: string; observation?: string; cursor?: string; focus?: string }
export class SourceHistoryNotFound extends Error {}
const PAGE_SIZE = 50;
const EXCERPT_LIMIT = 2400;

export const HISTORY_CONVERSATIONS_SQL = `select c.source_conversation_id,
  c.title_representation->>'value' title, count(o.observation_id)::int observations_count
  from memory_v1.conversations c
  join memory_v1.observations o on o.workspace_id=c.workspace_id and o.conversation_id=c.conversation_id
  where c.workspace_id=$1 and ($2::text is null or c.source_conversation_id > $2)
  group by c.source_conversation_id,c.title_representation
  having ($4::text is null or bool_or(position($4 in regexp_replace(lower(
    coalesce(c.title_representation->>'value','') || ' ' || coalesce(o.payload->>'statement','')), '[^a-z0-9]', '', 'g')) > 0))
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
    const result = await client.query(HISTORY_CONVERSATIONS_SQL, [workspace, input.cursor ?? null, PAGE_SIZE + 1, input.focus ?? null]);
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
    const context = evidence.length ? await client.query(HISTORY_CONTEXT_SQL,
      [workspace, row.conversation_id, [...new Set(evidence.map(item => item.message_id))], PAGE_SIZE + 1]) : { rows: [] };
    const conversation_context = context.rows.slice(0, PAGE_SIZE).map(sourceConversationContext);
    for (const item of conversation_context) {
      const anchor = evidence.find(source => source.message_id === item.anchor_message_id);
      if (!anchor || item.source_conversation_id !== conversation.source_conversation_id
        || item.source_version_id !== anchor.source_version_id || item.capture_version_id !== anchor.capture_version_id
        || (item.position === "before" ? item.sequence >= anchor.sequence : item.sequence <= anchor.sequence)) throw new Error("Source context scope mismatch.");
    }
    return { view: "evidence" as const, conversation, observation_id: input.observation, evidence, conversation_context, conversation_context_truncated: context.rows.length > PAGE_SIZE,
      next_cursor: result.rows.length > PAGE_SIZE ? evidence.at(-1)!.provenance_edge_id : null };
  }
  const result = await client.query(`select observation_id,status,payload from memory_v1.observations
    where workspace_id=$1 and conversation_id=$2 and ($3::text is null or observation_id > $3)
    order by observation_id limit $4`, [workspace, row.conversation_id, input.cursor ?? null, PAGE_SIZE + 1]);
  const rows = result.rows.slice(0, PAGE_SIZE);
  const trusted = rows.length ? await prepareReconciliationInputFromClient(client, workspace, rows.map(item => String(item.observation_id))) : null;
  const links = rows.length ? await client.query(HISTORY_LINKS_SQL, [workspace, rows.map(row=>String(row.observation_id))]) : {rows:[]};
  const observations = (trusted?.observations ?? []).map((observation, index) => ({
    observation_id: observation.observation_id, pipeline_version: observation.pipeline_version,
    observation_kind: observation.observation_kind, statement: observation.statement,
    ...sourceObservationLinks(links.rows, observation.observation_id),
    attribution: observation.attribution, evidence_roles: observation.evidence_roles,
    user_evidence_supported: hasSupportingUserEvidence([{ observation_id: observation.observation_id, relation: "supports" }], [observation]),
    created_at: observation.created_at, record_sha256: observation.record_sha256,
    status: String(rows[index]!.status),
    confidence: typeof rows[index]!.payload.confidence === "number" ? rows[index]!.payload.confidence : null
  }));
  return { view: "observations" as const, conversation, observations,
    next_cursor: result.rows.length > PAGE_SIZE ? observations.at(-1)!.observation_id : null };
}

function sourceDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sourceExcerpt(row: Record<string, unknown>) {
  const text = row.text_value;
  if (typeof text !== "string" || sha256(text) !== row.representation_sha256 || row.verification_status !== "complete") {
    throw new Error("Source evidence verification failed.");
  }
  return {
    source_conversation_id: String(row.source_conversation_id),
    source_created_at: sourceDate(row.source_created_at), source_updated_at: sourceDate(row.source_updated_at),
    message_id: String(row.message_id), sequence: Number(row.sequence), role: String(row.role), active_path: row.active_path === true,
    source_version_id: row.source_version_id === null ? null : String(row.source_version_id),
    capture_version_id: row.capture_version_id === null ? null : String(row.capture_version_id),
    representation_kind: String(row.representation_kind), representation_sha256: String(row.representation_sha256),
    excerpt: text.slice(0, EXCERPT_LIMIT), full_length: text.length, truncated: text.length > EXCERPT_LIMIT,
    verification: "hash_matched" as const
  };
}

export function sourceEvidence(row: Record<string, unknown>) {
  return { ...sourceExcerpt(row), provenance_edge_id: String(row.provenance_edge_id), relation: String(row.relation) };
}

export function sourceConversationContext(row: Record<string, unknown>) {
  if (row.role !== "user" || !["before", "after"].includes(String(row.position))) throw new Error("Invalid source context.");
  return { ...sourceExcerpt(row), role: "user" as const, anchor_message_id: String(row.anchor_message_id), position: row.position as "before" | "after" };
}

// Original user turns in source order, scoped by already verified immutable anchors.
// They are original message evidence, not new blocks, findings or provenance edges.
export const HISTORY_CONTEXT_SQL = `with anchors as (
  select m.* from memory_v1.messages m
  where m.workspace_id=$1 and m.conversation_id=$2 and m.active_path and m.message_id=any($3::text[])
)
select a.message_id anchor_message_id,
  case when m.sequence<a.sequence then 'before' else 'after' end position,
  c.source_conversation_id,m.message_id,m.sequence,m.role,m.active_path,m.source_version_id,m.capture_version_id,
  m.source_created_at,m.source_updated_at,
  coalesce(sv.verification_status,cv.verification_status) verification_status,
  rep->>'representation_kind' representation_kind,rep->>'sha256' representation_sha256,rep->>'value' text_value
from memory_v1.messages m
join memory_v1.conversations c on c.workspace_id=m.workspace_id and c.conversation_id=m.conversation_id
join lateral (
  select a.message_id,a.sequence from anchors a
  where m.source_version_id is not distinct from a.source_version_id
    and m.capture_version_id is not distinct from a.capture_version_id
    and m.message_id<>a.message_id and m.sequence<>a.sequence
    and not(m.message_id=any($3::text[]))
  order by abs(m.sequence-a.sequence),a.message_id limit 1
) a on true
cross join lateral (
  select value rep from jsonb_array_elements(m.representations)
  where value->>'representation_kind' in ('canonical_text','plain_text','rendered_text')
  order by case value->>'representation_kind' when 'canonical_text' then 0 when 'plain_text' then 1 else 2 end limit 1
) r
left join memory_v1.source_versions sv on sv.workspace_id=m.workspace_id and sv.source_version_id=m.source_version_id
left join memory_v1.capture_versions cv on cv.workspace_id=m.workspace_id and cv.capture_version_id=m.capture_version_id
where m.workspace_id=$1 and m.conversation_id=$2 and m.role='user' and m.active_path
order by m.sequence,m.message_id limit $4`;

// Reuses the exact workspace/version/message/representation linkage employed by
// prepareReconciliationInputFromClient. Only verified excerpts leave this read boundary.
export const HISTORY_EVIDENCE_SQL = `select p.provenance_edge_id,p.relation,p.representation_kind,p.representation_sha256,
  p.source_version_id,p.capture_version_id,c.source_conversation_id,m.message_id,m.sequence,m.role,m.active_path,
  m.source_created_at,m.source_updated_at,
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

// Existing relationship records remain proposed links, not approved conclusions.
export const HISTORY_LINKS_SQL = `select l.observation_link_id,l.from_observation_id,l.to_observation_id,l.link_kind
  from memory_v1.observation_links l
  join memory_v1.observations a on a.workspace_id=l.workspace_id and a.observation_id=l.from_observation_id
  join memory_v1.observations b on b.workspace_id=l.workspace_id and b.observation_id=l.to_observation_id
  where l.workspace_id=$1 and (l.from_observation_id=any($2::text[]) or l.to_observation_id=any($2::text[]))
  order by l.observation_link_id limit 2001`;
export function sourceObservationLinks(rows:Record<string,unknown>[],observation:string){
  const relevant=rows.slice(0,2000).filter(row=>row.from_observation_id===observation||row.to_observation_id===observation);
  return {links:relevant.slice(0,40).map(row=>({id:String(row.observation_link_id),from:String(row.from_observation_id),to:String(row.to_observation_id),kind:String(row.link_kind)})),links_truncated:relevant.length>40,links_page_truncated:rows.length>2000};
}
