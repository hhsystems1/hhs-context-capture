import { sha256, type CandidateStatus, type MemoryFoundationBundle, type WorkspaceScoped } from "./index.js";

export interface InvariantIssue { code: string; record_id?: string; message: string }

const transitions = new Set(["proposed:in_review", "in_review:approved", "in_review:rejected", "in_review:disputed", "in_review:superseded"]);

const collections = [
  "workspaces", "source_systems", "source_accounts", "ingestion_runs", "source_records", "capture_versions",
  "conversations", "messages", "content_blocks", "provenance_edges", "verification_results", "knowledge_candidates",
  "candidate_evidence", "human_review_events", "approved_knowledge", "entities", "relationships", "contradictions",
  "supersessions", "use_cases", "decisions", "tasks", "sops", "quarantine_items", "dead_letters"
] as const;

const idFields: Record<(typeof collections)[number], string> = {
  workspaces: "workspace_id", source_systems: "source_system_id", source_accounts: "source_account_id",
  ingestion_runs: "ingestion_run_id", source_records: "source_record_id", capture_versions: "capture_version_id",
  conversations: "conversation_id", messages: "message_id", content_blocks: "content_block_id",
  provenance_edges: "provenance_edge_id", verification_results: "verification_result_id",
  knowledge_candidates: "knowledge_candidate_id", candidate_evidence: "candidate_evidence_id",
  human_review_events: "human_review_event_id", approved_knowledge: "approved_knowledge_id", entities: "entity_id",
  relationships: "relationship_id", contradictions: "contradiction_id", supersessions: "supersession_id",
  use_cases: "use_case_id", decisions: "decision_id", tasks: "task_id", sops: "sop_id",
  quarantine_items: "quarantine_item_id", dead_letters: "dead_letter_id"
};

export function validateMemoryFoundation(bundle: MemoryFoundationBundle): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  const workspaces = new Set(bundle.workspaces.map((record) => record.workspace_id));
  const allIds = new Map<string, string>();
  const idempotencyKeys = new Map<string, string>();

  for (const collection of collections) {
    for (const raw of bundle[collection] as Array<WorkspaceScoped & { idempotency_key: string }>) {
      const record = raw as unknown as Record<string, unknown>;
      const id = String(record[idFields[collection]]);
      if (!workspaces.has(raw.workspace_id)) issue(issues, "workspace_unresolved", id, `Unknown workspace ${raw.workspace_id}`);
      if (allIds.has(id)) issue(issues, "duplicate_id", id, `Also used by ${allIds.get(id)}`); else allIds.set(id, collection);
      const scopedKey = `${raw.workspace_id}:${raw.idempotency_key}`;
      if (idempotencyKeys.has(scopedKey)) issue(issues, "duplicate_idempotency_key", id, `Also used by ${idempotencyKeys.get(scopedKey)}`); else idempotencyKeys.set(scopedKey, id);
    }
  }

  const systems = index(bundle.source_systems, "source_system_id");
  const accounts = index(bundle.source_accounts, "source_account_id");
  const runs = index(bundle.ingestion_runs, "ingestion_run_id");
  const sources = index(bundle.source_records, "source_record_id");
  const captures = index(bundle.capture_versions, "capture_version_id");
  const conversations = index(bundle.conversations, "conversation_id");
  const messages = index(bundle.messages, "message_id");
  const blocks = index(bundle.content_blocks, "content_block_id");
  const edges = index(bundle.provenance_edges, "provenance_edge_id");
  const candidates = index(bundle.knowledge_candidates, "knowledge_candidate_id");
  const events = index(bundle.human_review_events, "human_review_event_id");
  const approved = index(bundle.approved_knowledge, "approved_knowledge_id");

  for (const account of bundle.source_accounts) references(issues, account, account.source_account_id, [[systems, account.source_system_id, "source_system"]]);
  for (const run of bundle.ingestion_runs) references(issues, run, run.ingestion_run_id, [[systems, run.source_system_id, "source_system"], [accounts, run.source_account_id, "source_account"]]);
  for (const record of bundle.source_records) references(issues, record, record.source_record_id, [[runs, record.ingestion_run_id, "ingestion_run"], [systems, record.source_system_id, "source_system"], [accounts, record.source_account_id, "source_account"]]);
  for (const capture of bundle.capture_versions) references(issues, capture, capture.capture_version_id, [[sources, capture.source_record_id, "source_record"], [conversations, capture.conversation_id, "conversation"]]);
  for (const conversation of bundle.conversations) references(issues, conversation, conversation.conversation_id, [[sources, conversation.source_record_id, "source_record"], [captures, conversation.capture_version_id, "capture_version"]]);
  for (const message of bundle.messages) {
    references(issues, message, message.message_id, [[conversations, message.conversation_id, "conversation"], [captures, message.capture_version_id, "capture_version"]]);
    if (message.parent_message_id) references(issues, message, message.message_id, [[messages, message.parent_message_id, "parent_message"]]);
  }
  for (const block of bundle.content_blocks) references(issues, block, block.content_block_id, [[messages, block.message_id, "message"], [captures, block.capture_version_id, "capture_version"]]);
  for (const message of bundle.messages) for (const representation of message.representations) if (representation.sha256 !== sha256(representation.value)) issue(issues, "representation_hash_mismatch", message.message_id, `Message ${representation.representation_kind} SHA-256 does not match its value`);
  for (const block of bundle.content_blocks) for (const representation of block.representations) if (representation.sha256 !== sha256(representation.value)) issue(issues, "representation_hash_mismatch", block.content_block_id, `Content block ${representation.representation_kind} SHA-256 does not match its value`);
  for (const result of bundle.verification_results) references(issues, result, result.verification_result_id, [[captures, result.capture_version_id, "capture_version"]]);

  for (const edge of bundle.provenance_edges) {
    const e = edge.evidence;
    references(issues, edge, edge.provenance_edge_id, [[sources, e.source_record_id, "evidence source_record"], [captures, e.capture_version_id, "evidence capture_version"], [conversations, e.conversation_id, "evidence conversation"], [messages, e.message_id, "evidence message"], [blocks, e.content_block_id, "evidence content_block"]]);
    if (edge.workspace_id !== e.workspace_id) issue(issues, "cross_workspace_provenance", edge.provenance_edge_id, "Evidence workspace differs from edge workspace");
    const block = blocks.get(e.content_block_id);
    if (block && !block.representations.some((representation) => representation.representation_kind === e.representation_kind && representation.sha256 === e.representation_sha256)) {
      issue(issues, "representation_unresolved", edge.provenance_edge_id, "Evidence representation kind and SHA-256 do not resolve to the content block");
    }
    const message = messages.get(e.message_id);
    const capture = captures.get(e.capture_version_id);
    if (block && (block.message_id !== e.message_id || block.capture_version_id !== e.capture_version_id)) issue(issues, "provenance_chain_mismatch", edge.provenance_edge_id, "Content block does not belong to the cited message and capture");
    if (message && (message.conversation_id !== e.conversation_id || message.capture_version_id !== e.capture_version_id)) issue(issues, "provenance_chain_mismatch", edge.provenance_edge_id, "Message does not belong to the cited conversation and capture");
    if (capture && capture.source_record_id !== e.source_record_id) issue(issues, "provenance_chain_mismatch", edge.provenance_edge_id, "Capture does not belong to the cited source record");
  }

  for (const item of bundle.candidate_evidence) references(issues, item, item.candidate_evidence_id, [[candidates, item.knowledge_candidate_id, "candidate"], [edges, item.provenance_edge_id, "provenance_edge"]]);

  const eventGroups = new Map<string, typeof bundle.human_review_events>();
  for (const event of bundle.human_review_events) {
    references(issues, event, event.human_review_event_id, [[candidates, event.knowledge_candidate_id, "candidate"]]);
    if (event.actor_kind !== "human") issue(issues, "approval_not_human", event.human_review_event_id, "Review events must be human-authored");
    const key = `${event.from_status}:${event.to_status}`;
    if (!transitions.has(key)) issue(issues, "invalid_candidate_transition", event.human_review_event_id, `Transition ${key} is not allowed`);
    const group = eventGroups.get(event.knowledge_candidate_id) ?? [];
    group.push(event);
    eventGroups.set(event.knowledge_candidate_id, group);
  }
  for (const candidate of bundle.knowledge_candidates) {
    if (candidate.proposed_value_sha256 !== sha256(candidate.proposed_value)) issue(issues, "candidate_value_hash_mismatch", candidate.knowledge_candidate_id, "Proposed value SHA-256 does not match its canonical value");
    const ordered = [...(eventGroups.get(candidate.knowledge_candidate_id) ?? [])].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    let state: CandidateStatus = "proposed";
    for (const event of ordered) {
      if (event.from_status !== state) issue(issues, "candidate_event_chain_broken", event.human_review_event_id, `Expected from_status ${state}`);
      state = event.to_status;
    }
    if (state !== candidate.status) issue(issues, "candidate_status_mismatch", candidate.knowledge_candidate_id, `Events resolve to ${state}, record says ${candidate.status}`);
  }
  for (const record of bundle.approved_knowledge) {
    references(issues, record, record.approved_knowledge_id, [[candidates, record.knowledge_candidate_id, "candidate"], [events, record.approval_event_id, "approval_event"]]);
    const event = events.get(record.approval_event_id);
    if (!event || event.knowledge_candidate_id !== record.knowledge_candidate_id || event.to_status !== "approved") issue(issues, "approval_event_invalid", record.approved_knowledge_id, "Approved knowledge must reference its candidate's human approval event");
    if (record.approved_value_sha256 !== sha256(record.approved_value)) issue(issues, "approved_value_hash_mismatch", record.approved_knowledge_id, "Approved value SHA-256 does not match its canonical value");
    for (const edgeId of record.provenance_edge_ids) references(issues, record, record.approved_knowledge_id, [[edges, edgeId, "provenance_edge"]]);
  }

  const entities = index(bundle.entities, "entity_id");
  for (const entity of bundle.entities) references(issues, entity, entity.entity_id, [[approved, entity.approved_knowledge_id, "approved_knowledge"]]);
  for (const relation of bundle.relationships) references(issues, relation, relation.relationship_id, [[approved, relation.approved_knowledge_id, "approved_knowledge"], [entities, relation.subject_id, "subject_entity"], [entities, relation.object_id, "object_entity"]]);
  for (const record of [...bundle.use_cases, ...bundle.decisions, ...bundle.tasks, ...bundle.sops]) {
    const id = Object.entries(record).find(([key]) => key.endsWith("_id") && key !== "workspace_id" && key !== "approved_knowledge_id")?.[1] as string;
    references(issues, record, id, [[approved, record.approved_knowledge_id, "approved_knowledge"]]);
    for (const edgeId of record.provenance_edge_ids) references(issues, record, id, [[edges, edgeId, "provenance_edge"]]);
  }
  for (const record of bundle.contradictions) {
    references(issues, record, record.contradiction_id, [[approved, record.left_record_id, "left approved knowledge"], [approved, record.right_record_id, "right approved knowledge"]]);
    for (const edgeId of record.provenance_edge_ids) references(issues, record, record.contradiction_id, [[edges, edgeId, "provenance_edge"]]);
  }
  for (const record of bundle.supersessions) {
    references(issues, record, record.supersession_id, [[approved, record.prior_approved_knowledge_id, "prior approved knowledge"], [approved, record.successor_approved_knowledge_id, "successor approved knowledge"], [events, record.human_review_event_id, "human review event"]]);
    for (const edgeId of record.provenance_edge_ids) references(issues, record, record.supersession_id, [[edges, edgeId, "provenance_edge"]]);
  }
  for (const item of bundle.quarantine_items) references(issues, item, item.quarantine_item_id, [[runs, item.ingestion_run_id, "ingestion_run"]]);
  for (const item of bundle.dead_letters) references(issues, item, item.dead_letter_id, [[runs, item.ingestion_run_id, "ingestion_run"]]);
  return issues;
}

export function mergeMemoryFoundation(existing: MemoryFoundationBundle, replay: MemoryFoundationBundle): MemoryFoundationBundle {
  if (existing.schema_version !== replay.schema_version) throw new Error("Schema versions differ");
  const merged = structuredClone(existing);
  for (const collection of collections) {
    const idField = idFields[collection];
    const target = merged[collection] as unknown as Array<Record<string, unknown>>;
    const seen = new Map(target.map((record) => [String(record[idField]), JSON.stringify(record)]));
    for (const record of replay[collection] as unknown as Array<Record<string, unknown>>) {
      const id = String(record[idField]);
      const prior = seen.get(id);
      if (prior === undefined) target.push(structuredClone(record));
      else if (prior !== JSON.stringify(record)) throw new Error(`Idempotency collision for ${id}`);
    }
  }
  return merged;
}

function index<T extends WorkspaceScoped>(records: T[], idField: keyof T): Map<string, T> {
  return new Map(records.map((record) => [String(record[idField]), record]));
}

function references(issues: InvariantIssue[], owner: WorkspaceScoped, ownerId: string, refs: Array<[Map<string, WorkspaceScoped>, string, string]>): void {
  for (const [map, id, label] of refs) {
    const target = map.get(id);
    if (!target) issue(issues, "reference_unresolved", ownerId, `${label} ${id} is unresolved`);
    else if (target.workspace_id !== owner.workspace_id) issue(issues, "cross_workspace_reference", ownerId, `${label} belongs to another workspace`);
  }
}

function issue(issues: InvariantIssue[], code: string, record_id: string | undefined, message: string): void {
  issues.push({ code, ...(record_id === undefined ? {} : { record_id }), message });
}
