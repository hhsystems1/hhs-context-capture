/**
 * Browser-capture -> source version bridge (source_family = browser_capture).
 *
 * Produces the generic SourceVersion view of an EXISTING archive capture so that
 * both evidence families converge on one normalized shape. It is read-only with
 * respect to capture history: it never rewrites a capture_versions row, never
 * mutates the archive, and preserves the original capture_version identity as a
 * back-link on the source version.
 *
 * This is the family-B counterpart to ./export-adapter.ts. Both emit the same
 * SourceVersionedBundle, which is the entire point of the abstraction.
 */
import { deterministicId, idempotencyKey, sha256, type PreservedRepresentation } from "@hhs/memory-schema";
import {
  BROWSER_CAPTURE,
  emptyBundle,
  type SourceVersion,
  type SourceVersionedBundle,
  type VersionedContentBlock,
  type VersionedConversation,
  type VersionedMessage,
  type VersionedProvenanceEdge,
  type VersionedVerificationResult
} from "@hhs/memory-schema/source-version";

export const CAPTURE_PIPELINE_VERSION = "memory-capture-v1/0.1.0";

export interface CaptureRepresentation { kind?: string; value?: string; sha256?: string; evidence_locator?: string }
export interface CaptureContentBlock {
  block_id?: string;
  type?: string;
  block_kind?: string;
  sequence?: number;
  representations?: CaptureRepresentation[];
}
export interface CaptureMessage {
  message_id?: string;
  platform_message_id?: string;
  role?: string;
  sequence?: number;
  representations?: CaptureRepresentation[];
  content_blocks?: CaptureContentBlock[];
}
export interface NormalizedCapture {
  capture?: { capture_id?: string; started_at?: string; completed_at?: string; adapter_version?: string; status?: string };
  conversation?: { conversation_id?: string; platform_conversation_id?: string; title?: string };
  messages?: CaptureMessage[];
  verification?: { status?: string; ruleset_version?: string };
  platform_metadata?: Record<string, unknown>;
}

export interface CaptureBridgeOptions {
  workspaceId: string;
  /** sha256 of the capture manifest, the capture's existing evidence identity. */
  manifestSha256: string;
  sourceSystemId: string;
  sourceAccountId: string;
  ingestionRunId: string;
}

function mapRole(role: string | undefined): "user" | "assistant" | "tool" | "system_visible" | "unknown" {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool";
    case "system": case "system_visible": return "system_visible";
    default: return "unknown";
  }
}

function pickCanonical(reps: CaptureRepresentation[] | undefined): { value: string; kind: string } {
  const list = reps ?? [];
  const canonical = list.find((r) => r.kind === "canonical_text") ?? list.find((r) => r.kind === "text_content") ?? list[0];
  return { value: canonical?.value ?? "", kind: "canonical_text" };
}

function representation(value: string, locator: string): PreservedRepresentation {
  return { representation_kind: "canonical_text", value, sha256: sha256(value), evidence_locator: locator };
}

export interface CaptureBridgeResult {
  bundle: SourceVersionedBundle;
  stats: { messages: number; content_blocks: number; roles: Record<string, number> };
}

export function adaptCapture(capture: NormalizedCapture, options: CaptureBridgeOptions): CaptureBridgeResult {
  const workspaceId = options.workspaceId;
  const bundle = emptyBundle();

  const uuid = capture.conversation?.conversation_id ?? capture.conversation?.platform_conversation_id ?? "";
  const captureId = capture.capture?.capture_id ?? "";
  const observedAt = capture.capture?.completed_at ?? capture.capture?.started_at ?? new Date(0).toISOString();

  // Identity mirrors ingest.ts so the bridge lines up with existing capture rows.
  const captureVersionId = deterministicId("capture_version", workspaceId, captureId);
  const conversationId = deterministicId("conversation", workspaceId, uuid);
  const sourceVersionId = deterministicId("source_version", workspaceId, { uuid, capture: captureId });
  const conversationSourceRecordId = deterministicId("source_record", workspaceId, { kind: "conversation", uuid, capture: captureId });

  const captureLocator = `hhs-archive://capture/${captureId}`;
  const conversationLocator = `${captureLocator}#/${uuid}`;

  bundle.source_records.push({
    workspace_id: workspaceId,
    source_record_id: conversationSourceRecordId,
    idempotency_key: idempotencyKey("source_record", workspaceId, { kind: "conversation", uuid, capture: captureId }),
    ingestion_run_id: options.ingestionRunId,
    source_system_id: options.sourceSystemId,
    source_account_id: options.sourceAccountId,
    source_native_id: uuid,
    record_kind: "conversation",
    immutable_evidence_locator: conversationLocator,
    source_sha256: options.manifestSha256,
    observed_at: observedAt
  });

  const roles: Record<string, number> = {};
  const messages = [...(capture.messages ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  messages.forEach((message, messageIndex) => {
    const nativeId = message.platform_message_id ?? message.message_id ?? `seq-${messageIndex}`;
    const messageId = deterministicId("message", workspaceId, { uuid, capture: captureId, node: nativeId });
    const role = mapRole(message.role);
    roles[role] = (roles[role] ?? 0) + 1;
    const messageLocator = `${conversationLocator}/messages/${nativeId}`;
    const canonical = pickCanonical(message.representations);

    const normalizedMessage: VersionedMessage = {
      workspace_id: workspaceId,
      message_id: messageId,
      idempotency_key: idempotencyKey("message", workspaceId, { uuid, capture: captureId, node: nativeId }),
      conversation_id: conversationId,
      capture_version_id: captureVersionId,
      source_message_id: nativeId,
      sequence: messageIndex,
      role,
      // A DOM capture flattens to the visible thread: everything captured is on
      // the active path by construction. Off-path branches are exactly what the
      // browser pipeline cannot see, which is why the export matters.
      active_path: true,
      representations: [representation(canonical.value, messageLocator)]
    };
    bundle.messages.push(normalizedMessage);

    const blocks = message.content_blocks ?? [];
    blocks.forEach((block, blockIndex) => {
      const blockNatural = { uuid, capture: captureId, node: nativeId, part: blockIndex };
      const blockId = deterministicId("content_block", workspaceId, blockNatural);
      const blockSourceRecordId = deterministicId("source_record", workspaceId, { kind: "content_block", ...blockNatural });
      const blockLocator = `${messageLocator}/blocks/${blockIndex}`;
      const blockCanonical = pickCanonical(block.representations);

      bundle.source_records.push({
        workspace_id: workspaceId,
        source_record_id: blockSourceRecordId,
        idempotency_key: idempotencyKey("source_record", workspaceId, { kind: "content_block", ...blockNatural }),
        ingestion_run_id: options.ingestionRunId,
        source_system_id: options.sourceSystemId,
        source_account_id: options.sourceAccountId,
        source_native_id: `${nativeId}#${blockIndex}`,
        record_kind: "content_block",
        immutable_evidence_locator: blockLocator,
        source_sha256: sha256(blockCanonical.value),
        observed_at: observedAt
      });

      bundle.content_blocks.push({
        workspace_id: workspaceId,
        content_block_id: blockId,
        idempotency_key: idempotencyKey("content_block", workspaceId, blockNatural),
        message_id: messageId,
        capture_version_id: captureVersionId,
        sequence: blockIndex,
        block_kind: block.type ?? block.block_kind ?? "unknown",
        representations: [representation(blockCanonical.value, blockLocator)]
      } satisfies VersionedContentBlock);

      bundle.provenance_edges.push({
        workspace_id: workspaceId,
        provenance_edge_id: deterministicId("provenance_edge", workspaceId, blockNatural),
        idempotency_key: idempotencyKey("provenance_edge", workspaceId, blockNatural),
        target_record_type: "source_evidence",
        target_record_id: blockId,
        relation: "derived_from",
        evidence: {
          workspace_id: workspaceId,
          source_record_id: blockSourceRecordId,
          capture_version_id: captureVersionId,
          conversation_id: conversationId,
          message_id: messageId,
          content_block_id: blockId,
          representation_kind: "canonical_text",
          representation_sha256: sha256(blockCanonical.value)
        },
        created_at: observedAt
      } satisfies VersionedProvenanceEdge);
    });
  });

  bundle.conversations.push({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    idempotency_key: idempotencyKey("conversation", workspaceId, uuid),
    source_record_id: conversationSourceRecordId,
    capture_version_id: captureVersionId,
    source_conversation_id: uuid,
    title_representation: representation(capture.conversation?.title ?? "", conversationLocator)
  } satisfies VersionedConversation);

  const status = (capture.verification?.status ?? capture.capture?.status ?? "needs_review") as SourceVersion["verification_status"];
  bundle.source_versions.push({
    workspace_id: workspaceId,
    source_version_id: sourceVersionId,
    idempotency_key: idempotencyKey("source_version", workspaceId, { uuid, capture: captureId }),
    source_record_id: conversationSourceRecordId,
    conversation_id: conversationId,
    source_family: BROWSER_CAPTURE,
    // The capture manifest hash IS this capture's per-conversation content identity.
    content_sha256: options.manifestSha256,
    immutable_source_locator: conversationLocator,
    verification_status: status,
    source_observed_at: observedAt,
    capture_version_id: captureVersionId,
    source_metadata: {
      adapter: "browser-capture-bridge",
      adapter_version: capture.capture?.adapter_version ?? "unknown",
      pipeline_version: CAPTURE_PIPELINE_VERSION,
      has_full_branch_tree: false,
      source_timestamps: "not_available_per_message",
      source_markdown_available: (capture.platform_metadata?.source_markdown_available as boolean | undefined) ?? false,
      observed_branch_indicators: capture.platform_metadata?.observed_branch_indicators ?? [],
      truncation_indicators: capture.platform_metadata?.truncation_indicators ?? [],
      roles
    }
  } satisfies SourceVersion);

  bundle.verification_results.push({
    workspace_id: workspaceId,
    verification_result_id: deterministicId("verification_result", workspaceId, captureId),
    idempotency_key: idempotencyKey("verification_result", workspaceId, captureId),
    capture_version_id: captureVersionId,
    ruleset_version: capture.verification?.ruleset_version ?? "0.1.0",
    status: status,
    checks: []
  } satisfies VersionedVerificationResult);

  return { bundle, stats: { messages: bundle.messages.length, content_blocks: bundle.content_blocks.length, roles } };
}
