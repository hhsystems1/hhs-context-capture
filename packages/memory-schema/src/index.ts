import { createHash } from "node:crypto";

export const MEMORY_SCHEMA_VERSION = "0.1.0" as const;

export type Sha256 = string;
export type RecordId = string;
export type CandidateStatus = "proposed" | "in_review" | "approved" | "rejected" | "disputed" | "superseded";
export type RelationshipKind = "contradicts" | "supersedes" | "refines" | "supports" | "duplicates" | "applies_to_different_context";
export type RepresentationKind = "inner_text" | "text_content" | "sanitized_html" | "canonical_text" | (string & {});

export interface WorkspaceScoped { workspace_id: string }
export interface DeterministicRecord extends WorkspaceScoped { idempotency_key: string }

export interface Workspace extends DeterministicRecord {
  workspace_id: string;
  name: string;
  isolation_key: string;
  status: "active" | "suspended";
}

export interface SourceSystem extends DeterministicRecord {
  source_system_id: RecordId;
  kind: string;
  adapter_contract: string;
}

export interface SourceAccount extends DeterministicRecord {
  source_account_id: RecordId;
  source_system_id: RecordId;
  opaque_account_reference: string;
}

export interface IngestionRun extends DeterministicRecord {
  ingestion_run_id: RecordId;
  source_system_id: RecordId;
  source_account_id: RecordId;
  status: "pending" | "running" | "completed" | "partial" | "failed" | "quarantined";
  started_at: string;
  completed_at?: string;
  input_manifest_sha256: Sha256;
  checkpoint_key?: string;
}

export interface SourceRecord extends DeterministicRecord {
  source_record_id: RecordId;
  ingestion_run_id: RecordId;
  source_system_id: RecordId;
  source_account_id: RecordId;
  source_native_id: string;
  record_kind: "conversation" | "message" | "content_block" | "attachment" | "artifact" | "other";
  immutable_evidence_locator: string;
  source_sha256: Sha256;
  observed_at: string;
}

export interface CaptureVersion extends DeterministicRecord {
  capture_version_id: RecordId;
  source_record_id: RecordId;
  conversation_id: RecordId;
  immutable_archive_locator: string;
  manifest_sha256: Sha256;
  verification_status: "complete" | "partial" | "failed" | "needs_review";
  captured_at: string;
}

export interface PreservedRepresentation {
  representation_kind: RepresentationKind;
  value: string;
  sha256: Sha256;
  evidence_locator: string;
}

export interface Conversation extends DeterministicRecord {
  conversation_id: RecordId;
  source_record_id: RecordId;
  capture_version_id: RecordId;
  source_conversation_id: string;
  title_representation?: PreservedRepresentation;
}

export interface Message extends DeterministicRecord {
  message_id: RecordId;
  conversation_id: RecordId;
  capture_version_id: RecordId;
  source_message_id: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system_visible" | "unknown";
  parent_message_id?: RecordId;
  active_path: boolean;
  representations: PreservedRepresentation[];
}

export interface ContentBlock extends DeterministicRecord {
  content_block_id: RecordId;
  message_id: RecordId;
  capture_version_id: RecordId;
  sequence: number;
  block_kind: string;
  representations: PreservedRepresentation[];
}

export interface ExactEvidenceReference extends WorkspaceScoped {
  source_record_id: RecordId;
  capture_version_id: RecordId;
  conversation_id: RecordId;
  message_id: RecordId;
  content_block_id: RecordId;
  representation_kind: RepresentationKind;
  representation_sha256: Sha256;
}

export interface ProvenanceEdge extends DeterministicRecord {
  provenance_edge_id: RecordId;
  target_record_type: string;
  target_record_id: RecordId;
  relation: "derived_from" | "quotes" | "supports" | "contradicts";
  evidence: ExactEvidenceReference;
  created_at: string;
}

export interface VerificationResult extends DeterministicRecord {
  verification_result_id: RecordId;
  capture_version_id: RecordId;
  ruleset_version: string;
  status: "complete" | "partial" | "failed" | "needs_review";
  checks: Array<{ check_id: string; status: "pass" | "fail" | "warning" | "not_observed"; evidence_sha256?: Sha256 }>;
}

export type KnowledgeCandidateKind = "claim" | "idea" | "entity" | "relationship" | "use_case" | "decision" | "task" | "sop";

export interface KnowledgeCandidate extends DeterministicRecord {
  knowledge_candidate_id: RecordId;
  kind: KnowledgeCandidateKind;
  status: CandidateStatus;
  proposed_value: unknown;
  proposed_value_sha256: Sha256;
  created_at: string;
}

export interface CandidateEvidence extends DeterministicRecord {
  candidate_evidence_id: RecordId;
  knowledge_candidate_id: RecordId;
  provenance_edge_id: RecordId;
  role: "supporting" | "contradicting" | "context";
}

export interface HumanReviewEvent extends DeterministicRecord {
  human_review_event_id: RecordId;
  knowledge_candidate_id: RecordId;
  actor_kind: "human";
  reviewer_id: string;
  from_status: CandidateStatus;
  to_status: CandidateStatus;
  rationale: string;
  occurred_at: string;
  event_sha256: Sha256;
}

export interface ApprovedKnowledge extends DeterministicRecord {
  approved_knowledge_id: RecordId;
  knowledge_candidate_id: RecordId;
  approval_event_id: RecordId;
  approved_value: unknown;
  approved_value_sha256: Sha256;
  provenance_edge_ids: RecordId[];
  approved_at: string;
}

export interface Entity extends DeterministicRecord {
  entity_id: RecordId;
  approved_knowledge_id: RecordId;
  entity_type: string;
  canonical_name: string;
}

export interface KnowledgeRelationship extends DeterministicRecord {
  relationship_id: RecordId;
  approved_knowledge_id: RecordId;
  subject_id: RecordId;
  object_id: RecordId;
  relationship_kind: RelationshipKind;
}

export interface Contradiction extends DeterministicRecord {
  contradiction_id: RecordId;
  left_record_id: RecordId;
  right_record_id: RecordId;
  status: "proposed" | "confirmed" | "resolved";
  provenance_edge_ids: RecordId[];
}

export interface Supersession extends DeterministicRecord {
  supersession_id: RecordId;
  prior_approved_knowledge_id: RecordId;
  successor_approved_knowledge_id: RecordId;
  human_review_event_id: RecordId;
  provenance_edge_ids: RecordId[];
}

interface ApprovedDomainRecord extends DeterministicRecord {
  approved_knowledge_id: RecordId;
  provenance_edge_ids: RecordId[];
}
export interface UseCase extends ApprovedDomainRecord { use_case_id: RecordId; name: string; outcome: string }
export interface Decision extends ApprovedDomainRecord { decision_id: RecordId; statement: string; decision_status: "active" | "superseded" | "reversed" }
export interface Task extends ApprovedDomainRecord { task_id: RecordId; title: string; task_status: "open" | "blocked" | "done" | "cancelled" }
export interface Sop extends ApprovedDomainRecord { sop_id: RecordId; title: string; ordered_steps: string[] }

export interface QuarantineItem extends DeterministicRecord {
  quarantine_item_id: RecordId;
  ingestion_run_id: RecordId;
  source_record_id?: RecordId;
  reason_code: string;
  payload_sha256: Sha256;
  status: "open" | "released" | "discarded";
}

export interface DeadLetter extends DeterministicRecord {
  dead_letter_id: RecordId;
  ingestion_run_id: RecordId;
  operation: string;
  payload_sha256: Sha256;
  failure_code: string;
  attempt_count: number;
  next_retry_at?: string;
}

export interface MemoryFoundationBundle {
  schema_version: typeof MEMORY_SCHEMA_VERSION;
  workspaces: Workspace[];
  source_systems: SourceSystem[];
  source_accounts: SourceAccount[];
  ingestion_runs: IngestionRun[];
  source_records: SourceRecord[];
  capture_versions: CaptureVersion[];
  conversations: Conversation[];
  messages: Message[];
  content_blocks: ContentBlock[];
  provenance_edges: ProvenanceEdge[];
  verification_results: VerificationResult[];
  knowledge_candidates: KnowledgeCandidate[];
  candidate_evidence: CandidateEvidence[];
  human_review_events: HumanReviewEvent[];
  approved_knowledge: ApprovedKnowledge[];
  entities: Entity[];
  relationships: KnowledgeRelationship[];
  contradictions: Contradiction[];
  supersessions: Supersession[];
  use_cases: UseCase[];
  decisions: Decision[];
  tasks: Task[];
  sops: Sop[];
  quarantine_items: QuarantineItem[];
  dead_letters: DeadLetter[];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}

export function sha256(value: unknown): Sha256 {
  const input = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function deterministicId(kind: string, workspaceId: string, naturalKey: unknown): string {
  return `${kind}_${sha256({ workspace_id: workspaceId, natural_key: naturalKey }).slice(0, 32)}`;
}

export function idempotencyKey(kind: string, workspaceId: string, naturalKey: unknown): string {
  return sha256({ kind, workspace_id: workspaceId, natural_key: naturalKey });
}
