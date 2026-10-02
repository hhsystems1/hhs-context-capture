import {
  MEMORY_SCHEMA_VERSION,
  deterministicId,
  idempotencyKey,
  sha256,
  type CandidateStatus,
  type KnowledgeCandidateKind,
  type MemoryFoundationBundle
} from "../../src/index.js";

const W = "workspace_synthetic_hhs";
const T0 = "2026-01-01T00:00:00.000Z";

function identity(kind: string, natural: unknown) {
  return { workspace_id: W, idempotency_key: idempotencyKey(kind, W, natural) };
}

export function buildSyntheticMemoryFixture(): MemoryFoundationBundle {
  const sourceSystemId = deterministicId("source_system", W, "synthetic-platform");
  const sourceAccountId = deterministicId("source_account", W, "opaque-synthetic-account");
  const runId = deterministicId("ingestion_run", W, "synthetic-run-1");
  const sourceRecordId = deterministicId("source_record", W, "synthetic-conversation-1");
  const captureId = deterministicId("capture_version", W, "synthetic-capture-1");
  const conversationId = deterministicId("conversation", W, "synthetic-conversation-1");
  const messageId = deterministicId("message", W, "synthetic-message-1");
  const blockId = deterministicId("content_block", W, "synthetic-message-1:block-0");
  const representationHash = sha256("Synthetic source statement.");
  const candidateSpecs: Array<[string, KnowledgeCandidateKind, unknown]> = [
    ["policy-v1", "claim", { statement: "Synthetic retention is 30 days." }],
    ["policy-v2", "claim", { statement: "Synthetic retention is 90 days." }],
    ["entity-hhs", "entity", { name: "Synthetic HHS" }],
    ["entity-client", "entity", { name: "Synthetic Client" }],
    ["relationship", "relationship", { relationship: "supports" }],
    ["use-case", "use_case", { name: "Synthetic lookup", outcome: "Find a cited record" }],
    ["decision", "decision", { statement: "Use synthetic fixtures" }],
    ["task", "task", { title: "Run synthetic validation" }],
    ["sop", "sop", { title: "Synthetic ingestion", steps: ["Validate", "Propose", "Review"] }]
  ];

  const knowledge_candidates = candidateSpecs.map(([key, kind, proposed_value]) => ({
    ...identity("knowledge_candidate", key),
    knowledge_candidate_id: deterministicId("knowledge_candidate", W, key),
    kind,
    status: "approved" as CandidateStatus,
    proposed_value,
    proposed_value_sha256: sha256(proposed_value),
    created_at: T0
  }));

  const provenance_edges = knowledge_candidates.map((candidate) => ({
    ...identity("provenance_edge", candidate.knowledge_candidate_id),
    provenance_edge_id: deterministicId("provenance_edge", W, candidate.knowledge_candidate_id),
    target_record_type: "knowledge_candidate",
    target_record_id: candidate.knowledge_candidate_id,
    relation: "derived_from" as const,
    evidence: {
      workspace_id: W, source_record_id: sourceRecordId, capture_version_id: captureId,
      conversation_id: conversationId, message_id: messageId, content_block_id: blockId,
      representation_kind: "canonical_text", representation_sha256: representationHash
    },
    created_at: T0
  }));

  const candidate_evidence = knowledge_candidates.map((candidate, index) => ({
    ...identity("candidate_evidence", candidate.knowledge_candidate_id),
    candidate_evidence_id: deterministicId("candidate_evidence", W, candidate.knowledge_candidate_id),
    knowledge_candidate_id: candidate.knowledge_candidate_id,
    provenance_edge_id: provenance_edges[index]!.provenance_edge_id,
    role: "supporting" as const
  }));

  const human_review_events = knowledge_candidates.flatMap((candidate) => {
    const reviewId = deterministicId("human_review_event", W, [candidate.knowledge_candidate_id, "review"]);
    const approvalId = deterministicId("human_review_event", W, [candidate.knowledge_candidate_id, "approve"]);
    return [
      {
        ...identity("human_review_event", [candidate.knowledge_candidate_id, "review"]),
        human_review_event_id: reviewId, knowledge_candidate_id: candidate.knowledge_candidate_id,
        actor_kind: "human" as const, reviewer_id: "synthetic-reviewer", from_status: "proposed" as const,
        to_status: "in_review" as const, rationale: "Synthetic review opened.", occurred_at: T0,
        event_sha256: sha256({ candidate: candidate.knowledge_candidate_id, transition: "proposed:in_review" })
      },
      {
        ...identity("human_review_event", [candidate.knowledge_candidate_id, "approve"]),
        human_review_event_id: approvalId, knowledge_candidate_id: candidate.knowledge_candidate_id,
        actor_kind: "human" as const, reviewer_id: "synthetic-reviewer", from_status: "in_review" as const,
        to_status: "approved" as const, rationale: "Synthetic approval only.", occurred_at: "2026-01-01T00:01:00.000Z",
        event_sha256: sha256({ candidate: candidate.knowledge_candidate_id, transition: "in_review:approved" })
      }
    ];
  });

  const approved_knowledge = knowledge_candidates.map((candidate, index) => ({
    ...identity("approved_knowledge", candidate.knowledge_candidate_id),
    approved_knowledge_id: deterministicId("approved_knowledge", W, candidate.knowledge_candidate_id),
    knowledge_candidate_id: candidate.knowledge_candidate_id,
    approval_event_id: human_review_events[index * 2 + 1]!.human_review_event_id,
    approved_value: candidate.proposed_value,
    approved_value_sha256: candidate.proposed_value_sha256,
    provenance_edge_ids: [provenance_edges[index]!.provenance_edge_id],
    approved_at: "2026-01-01T00:01:00.000Z"
  }));

  const byKey = (key: string) => candidateSpecs.findIndex(([candidateKey]) => candidateKey === key);
  const approvedId = (key: string) => approved_knowledge[byKey(key)]!.approved_knowledge_id;
  const edgeId = (key: string) => provenance_edges[byKey(key)]!.provenance_edge_id;
  const entityHhs = deterministicId("entity", W, "entity-hhs");
  const entityClient = deterministicId("entity", W, "entity-client");

  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    workspaces: [{ ...identity("workspace", W), name: "Synthetic HHS Workspace", isolation_key: "synthetic-isolation", status: "active" }],
    source_systems: [{ ...identity("source_system", "synthetic-platform"), source_system_id: sourceSystemId, kind: "synthetic_ai", adapter_contract: "synthetic/0.1.0" }],
    source_accounts: [{ ...identity("source_account", "opaque-synthetic-account"), source_account_id: sourceAccountId, source_system_id: sourceSystemId, opaque_account_reference: "opaque-synthetic-account" }],
    ingestion_runs: [{ ...identity("ingestion_run", "synthetic-run-1"), ingestion_run_id: runId, source_system_id: sourceSystemId, source_account_id: sourceAccountId, status: "completed", started_at: T0, completed_at: "2026-01-01T00:00:01.000Z", input_manifest_sha256: sha256("synthetic-manifest") }],
    source_records: [{ ...identity("source_record", "synthetic-conversation-1"), source_record_id: sourceRecordId, ingestion_run_id: runId, source_system_id: sourceSystemId, source_account_id: sourceAccountId, source_native_id: "synthetic-conversation-1", record_kind: "conversation", immutable_evidence_locator: "synthetic://archive/capture-1", source_sha256: sha256("synthetic-source"), observed_at: T0 }],
    capture_versions: [{ ...identity("capture_version", "synthetic-capture-1"), capture_version_id: captureId, source_record_id: sourceRecordId, conversation_id: conversationId, immutable_archive_locator: "synthetic://archive/capture-1", manifest_sha256: sha256("synthetic-capture-manifest"), verification_status: "complete", captured_at: T0 }],
    conversations: [{ ...identity("conversation", "synthetic-conversation-1"), conversation_id: conversationId, source_record_id: sourceRecordId, capture_version_id: captureId, source_conversation_id: "synthetic-conversation-1" }],
    messages: [{ ...identity("message", "synthetic-message-1"), message_id: messageId, conversation_id: conversationId, capture_version_id: captureId, source_message_id: "synthetic-message-1", sequence: 0, role: "user", active_path: true, representations: [{ representation_kind: "canonical_text", value: "Synthetic source statement.", sha256: representationHash, evidence_locator: "synthetic://archive/capture-1/message-1" }] }],
    content_blocks: [{ ...identity("content_block", "synthetic-message-1:block-0"), content_block_id: blockId, message_id: messageId, capture_version_id: captureId, sequence: 0, block_kind: "paragraph", representations: [{ representation_kind: "canonical_text", value: "Synthetic source statement.", sha256: representationHash, evidence_locator: "synthetic://archive/capture-1/message-1/block-0" }] }],
    provenance_edges,
    verification_results: [{ ...identity("verification_result", captureId), verification_result_id: deterministicId("verification_result", W, captureId), capture_version_id: captureId, ruleset_version: "synthetic/0.1.0", status: "complete", checks: [{ check_id: "synthetic-boundaries", status: "pass", evidence_sha256: sha256("synthetic-boundary-evidence") }] }],
    knowledge_candidates,
    candidate_evidence,
    human_review_events,
    approved_knowledge,
    entities: [
      { ...identity("entity", "entity-hhs"), entity_id: entityHhs, approved_knowledge_id: approvedId("entity-hhs"), entity_type: "company", canonical_name: "Synthetic HHS" },
      { ...identity("entity", "entity-client"), entity_id: entityClient, approved_knowledge_id: approvedId("entity-client"), entity_type: "company", canonical_name: "Synthetic Client" }
    ],
    relationships: [{ ...identity("relationship", "relationship"), relationship_id: deterministicId("relationship", W, "relationship"), approved_knowledge_id: approvedId("relationship"), subject_id: entityHhs, object_id: entityClient, relationship_kind: "supports" }],
    contradictions: [{ ...identity("contradiction", "policy-v1:policy-v2"), contradiction_id: deterministicId("contradiction", W, "policy-v1:policy-v2"), left_record_id: approvedId("policy-v1"), right_record_id: approvedId("policy-v2"), status: "confirmed", provenance_edge_ids: [edgeId("policy-v1"), edgeId("policy-v2")] }],
    supersessions: [{ ...identity("supersession", "policy-v1:policy-v2"), supersession_id: deterministicId("supersession", W, "policy-v1:policy-v2"), prior_approved_knowledge_id: approvedId("policy-v1"), successor_approved_knowledge_id: approvedId("policy-v2"), human_review_event_id: human_review_events[byKey("policy-v2") * 2 + 1]!.human_review_event_id, provenance_edge_ids: [edgeId("policy-v1"), edgeId("policy-v2")] }],
    use_cases: [{ ...identity("use_case", "use-case"), use_case_id: deterministicId("use_case", W, "use-case"), approved_knowledge_id: approvedId("use-case"), provenance_edge_ids: [edgeId("use-case")], name: "Synthetic lookup", outcome: "Find a cited record" }],
    decisions: [{ ...identity("decision", "decision"), decision_id: deterministicId("decision", W, "decision"), approved_knowledge_id: approvedId("decision"), provenance_edge_ids: [edgeId("decision")], statement: "Use synthetic fixtures", decision_status: "active" }],
    tasks: [{ ...identity("task", "task"), task_id: deterministicId("task", W, "task"), approved_knowledge_id: approvedId("task"), provenance_edge_ids: [edgeId("task")], title: "Run synthetic validation", task_status: "done" }],
    sops: [{ ...identity("sop", "sop"), sop_id: deterministicId("sop", W, "sop"), approved_knowledge_id: approvedId("sop"), provenance_edge_ids: [edgeId("sop")], title: "Synthetic ingestion", ordered_steps: ["Validate", "Propose", "Review"] }],
    quarantine_items: [{ ...identity("quarantine_item", "unsupported-synthetic-record"), quarantine_item_id: deterministicId("quarantine_item", W, "unsupported-synthetic-record"), ingestion_run_id: runId, reason_code: "unsupported_synthetic_format", payload_sha256: sha256("synthetic-quarantine-payload"), status: "open" }],
    dead_letters: [{ ...identity("dead_letter", "synthetic-operation-1"), dead_letter_id: deterministicId("dead_letter", W, "synthetic-operation-1"), ingestion_run_id: runId, operation: "normalize_synthetic_record", payload_sha256: sha256("synthetic-dead-letter-payload"), failure_code: "synthetic_failure", attempt_count: 1 }]
  };
}
