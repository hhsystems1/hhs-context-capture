/**
 * Source Versions V1: the generic evidence-source abstraction.
 *
 * A source version is "one conversation as it existed in one immutable source".
 * Browser captures (family B) keep their existing CaptureVersion record and gain
 * a SourceVersion alongside it; native OpenAI exports (family A) have a
 * SourceVersion and no CaptureVersion. Both families converge on the same
 * normalized Conversation/Message/ContentBlock/ProvenanceEdge records.
 *
 * Nothing here modifies the existing MemoryFoundationBundle contract or
 * validateMemoryFoundation(); those remain the browser-capture path verbatim.
 */
import {
  sha256,
  type ContentBlock,
  type Conversation,
  type Message,
  type PreservedRepresentation,
  type ProvenanceEdge,
  type RecordId,
  type Sha256,
  type SourceRecord,
  type VerificationResult,
  type WorkspaceScoped
} from "./index.js";

/** Known evidence families. Open-ended by design: a new family must not require
 * a schema migration, so this is a widened string rather than a closed union. */
export type SourceFamily = "native_export" | "browser_capture" | (string & {});

export const NATIVE_EXPORT: SourceFamily = "native_export";
export const BROWSER_CAPTURE: SourceFamily = "browser_capture";

export interface SourceVersion extends WorkspaceScoped {
  source_version_id: RecordId;
  idempotency_key: Sha256;
  source_record_id: RecordId;
  conversation_id: RecordId;
  source_family: SourceFamily;
  /** Hash of THIS conversation's canonical source content. Never the container hash. */
  content_sha256: Sha256;
  immutable_source_locator: string;
  /** Export ZIP / file hash. Absent for browser captures. */
  source_container_sha256?: Sha256;
  verification_status: "complete" | "partial" | "failed" | "needs_review";
  source_observed_at: string;
  source_metadata: Record<string, unknown>;
  /** Present only for source_family = browser_capture. */
  capture_version_id?: RecordId;
}

/** Normalized records accept exactly one of capture_version_id / source_version_id. */
export type Versioned<T> = Omit<T, "capture_version_id"> & {
  capture_version_id?: RecordId;
  source_version_id?: RecordId;
};

export type VersionedConversation = Versioned<Conversation>;
export type VersionedMessage = Versioned<Message> & {
  source_created_at?: string;
  source_updated_at?: string;
};
export type VersionedContentBlock = Versioned<ContentBlock>;
export type VersionedVerificationResult = Versioned<VerificationResult>;

export interface VersionedEvidenceReference extends WorkspaceScoped {
  source_record_id: RecordId;
  capture_version_id?: RecordId;
  source_version_id?: RecordId;
  conversation_id: RecordId;
  message_id: RecordId;
  content_block_id: RecordId;
  representation_kind: string;
  representation_sha256: Sha256;
}

export type VersionedProvenanceEdge = Omit<ProvenanceEdge, "evidence"> & {
  evidence: VersionedEvidenceReference;
};

/** The union of both families, ready for downstream discovery/synthesis. */
export interface SourceVersionedBundle {
  source_records: SourceRecord[];
  source_versions: SourceVersion[];
  conversations: VersionedConversation[];
  messages: VersionedMessage[];
  content_blocks: VersionedContentBlock[];
  provenance_edges: VersionedProvenanceEdge[];
  verification_results: VersionedVerificationResult[];
}

export function emptyBundle(): SourceVersionedBundle {
  return {
    source_records: [], source_versions: [], conversations: [], messages: [],
    content_blocks: [], provenance_edges: [], verification_results: []
  };
}

export function mergeBundles(...bundles: SourceVersionedBundle[]): SourceVersionedBundle {
  const merged = emptyBundle();
  for (const bundle of bundles) {
    merged.source_records.push(...bundle.source_records);
    merged.source_versions.push(...bundle.source_versions);
    merged.conversations.push(...bundle.conversations);
    merged.messages.push(...bundle.messages);
    merged.content_blocks.push(...bundle.content_blocks);
    merged.provenance_edges.push(...bundle.provenance_edges);
    merged.verification_results.push(...bundle.verification_results);
  }
  return merged;
}

export interface VersionIssue { code: string; record_id?: string; message: string }

/** The evidence-version key a normalized row belongs to, whichever family it is. */
export function evidenceVersionKey(
  row: { capture_version_id?: RecordId; source_version_id?: RecordId }
): RecordId | undefined {
  return row.source_version_id ?? row.capture_version_id;
}

/**
 * Family-agnostic invariant check. Deliberately a NEW function rather than a
 * change to validateMemoryFoundation(), so the existing browser-capture
 * validator keeps its behaviour byte-for-byte.
 */
export function validateSourceVersionedFoundation(bundle: SourceVersionedBundle): VersionIssue[] {
  const issues: VersionIssue[] = [];
  const add = (code: string, record_id: string | undefined, message: string): void => {
    issues.push({ code, ...(record_id === undefined ? {} : { record_id }), message });
  };

  const sourceRecords = new Map(bundle.source_records.map((r) => [r.source_record_id, r]));
  const versions = new Map(bundle.source_versions.map((v) => [v.source_version_id, v]));
  const conversations = new Map(bundle.conversations.map((c) => [c.conversation_id, c]));
  const messages = new Map(bundle.messages.map((m) => [m.message_id, m]));
  const blocks = new Map(bundle.content_blocks.map((b) => [b.content_block_id, b]));

  // Exactly one evidence version per normalized row.
  const single = (
    rows: Array<{ capture_version_id?: RecordId; source_version_id?: RecordId }>,
    label: string,
    idOf: (row: never) => string
  ): void => {
    for (const row of rows) {
      const present = [row.capture_version_id, row.source_version_id].filter((v) => v !== undefined).length;
      if (present !== 1) {
        add("single_evidence_version_violated", idOf(row as never), `${label} must cite exactly one of capture_version_id / source_version_id, found ${present}`);
      }
    }
  };
  // conversations are deliberately EXEMPT: a logical conversation may be
  // witnessed by several source versions (a later export of the same
  // conversation). Its linkage is source_versions.conversation_id, checked below.
  single(bundle.messages, "message", (r: VersionedMessage) => r.message_id);
  single(bundle.content_blocks, "content_block", (r: VersionedContentBlock) => r.content_block_id);
  single(bundle.verification_results, "verification_result", (r: VersionedVerificationResult) => r.verification_result_id);
  single(bundle.provenance_edges.map((e) => e.evidence), "provenance_edge evidence", () => "provenance_edge");

  // Source versions resolve to a source record and carry family-correct identity.
  for (const version of bundle.source_versions) {
    if (!sourceRecords.has(version.source_record_id)) {
      add("reference_unresolved", version.source_version_id, `source_record ${version.source_record_id} is unresolved`);
    }
    if (version.source_family === NATIVE_EXPORT && !version.source_container_sha256) {
      add("container_hash_missing", version.source_version_id, "native_export source versions must carry source_container_sha256");
    }
    if (version.source_family === BROWSER_CAPTURE && !version.capture_version_id) {
      add("capture_link_missing", version.source_version_id, "browser_capture source versions must link their capture_version_id");
    }
    if (!version.immutable_source_locator) {
      add("locator_missing", version.source_version_id, "source version must carry an immutable source locator");
    }
  }

  // Every conversation must be witnessed by at least one source version. This
  // replaces the exactly-one-of rule for conversations without pinning a logical
  // conversation to a single evidence version.
  const witnessed = new Set(bundle.source_versions.map((v) => v.conversation_id));
  for (const conversation of bundle.conversations) {
    if (!witnessed.has(conversation.conversation_id)) {
      add("conversation_unwitnessed", conversation.conversation_id, "Conversation is not referenced by any source version");
    }
  }

  // Distinct content hashes per source version guard the `limit 1` run→version
  // resolution in memory_v1.capture_ingestion_completion_errors().
  const byContent = new Map<string, string>();
  for (const version of bundle.source_versions) {
    const prior = byContent.get(version.content_sha256);
    if (prior !== undefined) {
      add("content_hash_collision", version.source_version_id, `content_sha256 already used by ${prior}; run→version resolution would be ambiguous`);
    } else byContent.set(version.content_sha256, version.source_version_id);
  }

  // Representation hashes must match their values, both families.
  const checkRepresentations = (id: string, reps: PreservedRepresentation[]): void => {
    for (const representation of reps) {
      if (representation.sha256 !== sha256(representation.value)) {
        add("representation_hash_mismatch", id, `${representation.representation_kind} SHA-256 does not match its value`);
      }
    }
  };
  for (const message of bundle.messages) checkRepresentations(message.message_id, message.representations);
  for (const block of bundle.content_blocks) checkRepresentations(block.content_block_id, block.representations);

  // Message sequences are contiguous from 0 within each evidence version, which
  // memory_v1's chunk_coverage_invalid check requires downstream.
  const sequences = new Map<string, number[]>();
  for (const message of bundle.messages) {
    const key = evidenceVersionKey(message);
    if (key === undefined) continue;
    const list = sequences.get(key) ?? [];
    list.push(message.sequence);
    sequences.set(key, list);
  }
  for (const [key, list] of sequences) {
    const sorted = [...list].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index] !== index) {
        add("sequence_not_contiguous", key, `Expected contiguous sequences from 0; found ${sorted[index]} at position ${index}`);
        break;
      }
    }
  }

  // Full provenance chain: block -> message -> conversation -> source version.
  for (const edge of bundle.provenance_edges) {
    const e = edge.evidence;
    const block = blocks.get(e.content_block_id);
    const message = messages.get(e.message_id);
    const conversation = conversations.get(e.conversation_id);
    if (!block) add("reference_unresolved", edge.provenance_edge_id, `content_block ${e.content_block_id} is unresolved`);
    if (!message) add("reference_unresolved", edge.provenance_edge_id, `message ${e.message_id} is unresolved`);
    if (!conversation) add("reference_unresolved", edge.provenance_edge_id, `conversation ${e.conversation_id} is unresolved`);

    const versionKey = evidenceVersionKey(e);
    if (e.source_version_id !== undefined && !versions.has(e.source_version_id)) {
      add("reference_unresolved", edge.provenance_edge_id, `source_version ${e.source_version_id} is unresolved`);
    }
    if (block && !block.representations.some(
      (r) => r.representation_kind === e.representation_kind && r.sha256 === e.representation_sha256
    )) {
      add("representation_unresolved", edge.provenance_edge_id, "Evidence representation kind and SHA-256 do not resolve to the content block");
    }
    if (block && (block.message_id !== e.message_id || evidenceVersionKey(block) !== versionKey)) {
      add("provenance_chain_mismatch", edge.provenance_edge_id, "Content block does not belong to the cited message and evidence version");
    }
    if (message && (message.conversation_id !== e.conversation_id || evidenceVersionKey(message) !== versionKey)) {
      add("provenance_chain_mismatch", edge.provenance_edge_id, "Message does not belong to the cited conversation and evidence version");
    }
    if (!sourceRecords.has(e.source_record_id)) {
      add("reference_unresolved", edge.provenance_edge_id, `source_record ${e.source_record_id} is unresolved`);
    }
  }
  return issues;
}

/**
 * Resolves a content block all the way back to its immutable source identity.
 * This is the single read path both families share; it never branches on family
 * to obtain normalized content, only to report which family it came from.
 */
export interface ResolvedProvenance {
  content_block_id: RecordId;
  representation_sha256: Sha256;
  message_id: RecordId;
  source_message_id: string;
  role: string;
  active_path: boolean;
  conversation_id: RecordId;
  source_conversation_id: string;
  source_version_id?: RecordId;
  capture_version_id?: RecordId;
  source_family: SourceFamily;
  immutable_source_locator: string;
  content_sha256: Sha256;
  source_container_sha256?: Sha256;
}

export function resolveProvenance(
  bundle: SourceVersionedBundle,
  edge: VersionedProvenanceEdge
): ResolvedProvenance | undefined {
  const e = edge.evidence;
  const block = bundle.content_blocks.find((b) => b.content_block_id === e.content_block_id);
  const message = bundle.messages.find((m) => m.message_id === e.message_id);
  const conversation = bundle.conversations.find((c) => c.conversation_id === e.conversation_id);
  if (!block || !message || !conversation) return undefined;
  const versionKey = evidenceVersionKey(e);
  const version = bundle.source_versions.find((v) => v.source_version_id === versionKey)
    ?? bundle.source_versions.find((v) => v.capture_version_id === versionKey);
  if (!version) return undefined;
  return {
    content_block_id: block.content_block_id,
    representation_sha256: e.representation_sha256,
    message_id: message.message_id,
    source_message_id: message.source_message_id,
    role: message.role,
    active_path: message.active_path,
    conversation_id: conversation.conversation_id,
    source_conversation_id: conversation.source_conversation_id,
    ...(version.source_version_id === undefined ? {} : { source_version_id: version.source_version_id }),
    ...(version.capture_version_id === undefined ? {} : { capture_version_id: version.capture_version_id }),
    source_family: version.source_family,
    immutable_source_locator: version.immutable_source_locator,
    content_sha256: version.content_sha256,
    ...(version.source_container_sha256 === undefined ? {} : { source_container_sha256: version.source_container_sha256 })
  };
}
