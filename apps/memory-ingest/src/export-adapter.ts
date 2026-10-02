/**
 * Native OpenAI export adapter (source_family = native_export).
 *
 * Converts ONE conversation record from a native `conversations.json` export
 * into the normalized memory_v1 shape, preserving the FULL mapping tree.
 *
 * Deliberately NOT a browser capture: there is no DOM, no scroll, no manifest.
 * Nothing here fabricates capture-shaped metadata, and the verification ruleset
 * in ./export-verification.ts emits no browser-only checks.
 *
 * Full-tree preservation is required, not optional. Measured over the verified
 * Jan 6 2026 export: 116 of 976 conversations carry nodes off the active path,
 * 1,284 off-path nodes across 184 fork points. Active-path-only ingestion would
 * discard all of them, reproducing the exact weakness that made 6 of 27 browser
 * captures fail their branches.complete check.
 */
import { deterministicId, idempotencyKey, sha256, type PreservedRepresentation, type SourceRecord } from "@hhs/memory-schema";
import {
  NATIVE_EXPORT,
  emptyBundle,
  type SourceVersion,
  type SourceVersionedBundle,
  type VersionedContentBlock,
  type VersionedConversation,
  type VersionedMessage,
  type VersionedProvenanceEdge
} from "@hhs/memory-schema/source-version";

export const NATIVE_EXPORT_PIPELINE_VERSION = "memory-export-v1/0.1.0";
export const NATIVE_EXPORT_ADAPTER_VERSION = "0.1.0";

/** Shape of a single record in a native OpenAI conversations.json export. */
export interface ExportAuthor { role?: string; name?: string | null }
/** Payload fields vary by content_type; only `parts` is common. Index signature
 * keeps non-`parts` payloads (thoughts, code, reasoning_recap, ...) reachable. */
export interface ExportContent { content_type?: string; parts?: unknown[]; [field: string]: unknown }
export interface ExportMessage {
  id?: string;
  author?: ExportAuthor;
  create_time?: number | null;
  update_time?: number | null;
  content?: ExportContent;
  metadata?: Record<string, unknown>;
}
export interface ExportMappingNode {
  id?: string;
  message?: ExportMessage | null;
  parent?: string | null;
  children?: string[];
}
export interface ExportConversation {
  conversation_id: string;
  id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping: Record<string, ExportMappingNode>;
}

export interface ExportAdapterOptions {
  workspaceId: string;
  /** SHA-256 of the immutable export ZIP container. */
  containerSha256: string;
  /** Export folder name, used to build human-traceable locators. */
  containerName: string;
  /** ISO timestamp the export was generated. */
  generatedAt: string;
  sourceSystemId: string;
  sourceAccountId: string;
  ingestionRunId: string;
  pipelineVersion?: string;
  /** Exact SHA-256 of conversations.json, distinct from the export ZIP hash. */
  sourceFileSha256?: string;
  /** File-level SourceRecord for conversations.json, created once per export. */
  sourceFileRecordId?: string;
}

/** OpenAI author roles -> the existing memory_v1 role CHECK. `system` becomes
 * system_visible so system content stays distinguishable from user intent
 * rather than being flattened into `unknown`. */
export function mapRole(role: string | undefined): "user" | "assistant" | "tool" | "system_visible" | "unknown" {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool";
    case "system": return "system_visible";
    default: return "unknown";
  }
}

/** Canonical text for one content part. Objects (multimodal_text) are
 * canonicalized rather than dropped, so nothing is lost. */
export function partToText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part === null || part === undefined) return "";
  return JSON.stringify(part);
}

/**
 * Content parts for ANY content_type.
 *
 * Only `text` and `multimodal_text` use `parts`. Measured across the verified
 * export, 15,316 of 41,446 message nodes (37%) carry their payload in a
 * type-specific field instead -- `thoughts`, `code`->text, `reasoning_recap`
 * ->content, `tether_browsing_display`->result/summary, `user_editable_context`
 * ->user_profile/user_instructions, and so on. Reading only `parts` would
 * silently drop every one of them.
 *
 * So: fall back to the whole remaining payload as a single canonical part. This
 * is lossless, deterministic, and requires no per-content_type special-casing,
 * which means a content type OpenAI adds later is preserved rather than dropped.
 * The original content_type is retained separately as the block's block_kind.
 */
export function extractParts(content: ExportContent | undefined): unknown[] {
  if (!content) return [];
  if (Array.isArray(content.parts) && content.parts.length > 0) return content.parts;
  const remainder = Object.entries(content)
    .filter(([key]) => key !== "content_type" && key !== "parts")
    .sort(([a], [b]) => a.localeCompare(b));
  if (remainder.length === 0) return [];
  return [Object.fromEntries(remainder)];
}

/**
 * Deterministic total order over the whole mapping tree: depth-first pre-order
 * from the root, following each node's declared `children` order. Produces
 * contiguous sequences from 0 across BOTH on-path and off-path nodes, which is
 * what memory_v1's chunk_coverage_invalid check requires.
 */
export function orderMappingNodes(conversation: ExportConversation): string[] {
  const mapping = conversation.mapping ?? {};
  const roots = Object.keys(mapping).filter((id) => {
    const parent = mapping[id]?.parent;
    return parent === null || parent === undefined || !(parent in mapping);
  }).sort();
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !(id in mapping)) return;   // cycle-safe
    seen.add(id);
    ordered.push(id);
    for (const child of mapping[id]?.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Any node unreachable from a root (malformed tree) still gets ingested, so
  // evidence is never silently dropped.
  for (const id of Object.keys(mapping).sort()) visit(id);
  return ordered;
}

/** Node ids on the active path, walked back from current_node. */
export function activePathNodes(conversation: ExportConversation): Set<string> {
  const mapping = conversation.mapping ?? {};
  const path = new Set<string>();
  let cursor = conversation.current_node ?? undefined;
  while (cursor && cursor in mapping && !path.has(cursor)) {
    path.add(cursor);
    cursor = mapping[cursor]?.parent ?? undefined;
  }
  return path;
}

function isoOrUndefined(epochSeconds: number | null | undefined): string | undefined {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return undefined;
  // OpenAI normally emits Unix seconds. One verified source node uses the same
  // instant in Unix milliseconds (1749249189415.0), which is recognizable
  // because interpreting it as seconds is beyond ISO year 9999. Normalize that
  // unit anomaly without changing the immutable source artifact or its hash.
  const normalizedSeconds = Math.abs(epochSeconds) > 253_402_300_799 ? epochSeconds / 1000 : epochSeconds;
  return new Date(normalizedSeconds * 1000).toISOString();
}

function representation(kind: string, value: string, locator: string): PreservedRepresentation {
  return { representation_kind: kind, value, sha256: sha256(value), evidence_locator: locator };
}

export interface ExportAdapterResult {
  bundle: SourceVersionedBundle;
  stats: {
    mapping_nodes: number;
    message_nodes: number;
    off_path_nodes: number;
    content_blocks: number;
    roles: Record<string, number>;
    content_types: Record<string, number>;
    messages_with_source_timestamp: number;
  };
}

/**
 * Adapt one export conversation. Pure: no DB, no filesystem, unit-testable —
 * mirroring the validateProposals() precedent in extraction.ts.
 */
export function adaptExportConversation(
  conversation: ExportConversation,
  options: ExportAdapterOptions
): ExportAdapterResult {
  const workspaceId = options.workspaceId;
  const pipelineVersion = options.pipelineVersion ?? NATIVE_EXPORT_PIPELINE_VERSION;
  const uuid = conversation.conversation_id;
  const bundle = emptyBundle();

  const containerLocator = `hhs-export://${options.containerSha256}/conversations.json`;
  const conversationLocator = `${containerLocator}#/${uuid}`;

  // Per-conversation content hash. Never the container hash: a hash shared
  // across conversations would make run->version resolution ambiguous.
  const contentSha256 = sha256(conversation);

  // Two distinct anchors, and the distinction is what makes revisions work:
  //
  //   identity anchor  - keyed on the OpenAI UUID alone. Stable across every
  //                      export that contains this conversation, so the logical
  //                      conversation row is byte-identical on replay AND on a
  //                      later export.
  //   version evidence - keyed on {uuid, container}. Version-specific, carries
  //                      the real per-version hash and locator.
  const identityRecordId = deterministicId("source_record", workspaceId, { kind: "conversation_identity", uuid });
  const conversationSourceRecordId = deterministicId("source_record", workspaceId, { kind: "conversation", uuid, container: options.containerSha256 });
  const conversationId = deterministicId("conversation", workspaceId, uuid);
  const sourceVersionId = deterministicId("source_version", workspaceId, { uuid, container: options.containerSha256 });

  const observedAt = options.generatedAt;

  bundle.source_records.push({
    workspace_id: workspaceId,
    source_record_id: identityRecordId,
    idempotency_key: idempotencyKey("source_record", workspaceId, { kind: "conversation_identity", uuid }),
    ingestion_run_id: options.ingestionRunId,
    source_system_id: options.sourceSystemId,
    source_account_id: options.sourceAccountId,
    source_native_id: uuid,
    record_kind: "other",
    immutable_evidence_locator: `hhs-conversation://${uuid}`,
    source_sha256: sha256(uuid),
    observed_at: observedAt
  } satisfies SourceRecord);

  const conversationSourceRecord: SourceRecord = {
    workspace_id: workspaceId,
    source_record_id: conversationSourceRecordId,
    idempotency_key: idempotencyKey("source_record", workspaceId, { kind: "conversation", uuid, container: options.containerSha256 }),
    ingestion_run_id: options.ingestionRunId,
    source_system_id: options.sourceSystemId,
    source_account_id: options.sourceAccountId,
    source_native_id: uuid,
    record_kind: "conversation",
    immutable_evidence_locator: conversationLocator,
    source_sha256: contentSha256,
    observed_at: observedAt
  };
  bundle.source_records.push(conversationSourceRecord);

  const ordered = orderMappingNodes(conversation);
  const activePath = activePathNodes(conversation);
  const mapping = conversation.mapping ?? {};

  const roles: Record<string, number> = {};
  const contentTypes: Record<string, number> = {};
  let offPath = 0;
  let withTimestamp = 0;

  // Only message-bearing nodes become messages; the synthetic root carries none.
  const messageNodeIds = ordered.filter((id) => mapping[id]?.message);
  const nodeToMessageId = new Map<string, string>();
  for (const nodeId of messageNodeIds) {
    nodeToMessageId.set(nodeId, deterministicId("message", workspaceId, { uuid, node: nodeId }));
  }

  let sequence = 0;
  for (const nodeId of messageNodeIds) {
    const node = mapping[nodeId];
    const message = node?.message as ExportMessage;
    const messageId = nodeToMessageId.get(nodeId) as string;
    const onPath = activePath.has(nodeId);
    if (!onPath) offPath += 1;

    const role = mapRole(message.author?.role);
    roles[role] = (roles[role] ?? 0) + 1;
    const contentType = message.content?.content_type ?? "unknown";
    contentTypes[contentType] = (contentTypes[contentType] ?? 0) + 1;
    const createdAt = isoOrUndefined(message.create_time);
    const updatedAt = isoOrUndefined(message.update_time);
    if (createdAt) withTimestamp += 1;

    // Nearest message-bearing ancestor, so the tree survives the synthetic root.
    let parentNode = node?.parent ?? undefined;
    while (parentNode && !nodeToMessageId.has(parentNode)) parentNode = mapping[parentNode]?.parent ?? undefined;
    const parentMessageId = parentNode ? nodeToMessageId.get(parentNode) : undefined;

    const messageLocator = `${conversationLocator}/mapping/${nodeId}`;
    const parts = extractParts(message.content);
    const joined = parts.map(partToText).join("\n");

    const normalizedMessage: VersionedMessage = {
      workspace_id: workspaceId,
      message_id: messageId,
      idempotency_key: idempotencyKey("message", workspaceId, { uuid, node: nodeId }),
      conversation_id: conversationId,
      source_version_id: sourceVersionId,
      source_message_id: nodeId,
      sequence,
      role,
      ...(parentMessageId === undefined ? {} : { parent_message_id: parentMessageId }),
      ...(createdAt === undefined ? {} : { source_created_at: createdAt }),
      ...(updatedAt === undefined ? {} : { source_updated_at: updatedAt }),
      active_path: onPath,
      representations: [representation("canonical_text", joined, messageLocator)]
    };
    bundle.messages.push(normalizedMessage);

    parts.forEach((part, index) => {
      const text = partToText(part);
      const blockLocator = `${messageLocator}/message/content/parts/${index}`;
      const blockNatural = { uuid, node: nodeId, part: index };
      const blockId = deterministicId("content_block", workspaceId, blockNatural);
      const blockSourceRecordId = deterministicId("source_record", workspaceId, { kind: "content_block", ...blockNatural, container: options.containerSha256 });

      bundle.source_records.push({
        workspace_id: workspaceId,
        source_record_id: blockSourceRecordId,
        idempotency_key: idempotencyKey("source_record", workspaceId, { kind: "content_block", ...blockNatural, container: options.containerSha256 }),
        ingestion_run_id: options.ingestionRunId,
        source_system_id: options.sourceSystemId,
        source_account_id: options.sourceAccountId,
        source_native_id: `${nodeId}#${index}`,
        record_kind: "content_block",
        immutable_evidence_locator: blockLocator,
        source_sha256: sha256(text),
        observed_at: observedAt
      });

      const block: VersionedContentBlock = {
        workspace_id: workspaceId,
        content_block_id: blockId,
        idempotency_key: idempotencyKey("content_block", workspaceId, blockNatural),
        message_id: messageId,
        source_version_id: sourceVersionId,
        sequence: index,
        // Preserve the ORIGINAL OpenAI content_type. Fidelity requirement:
        // thoughts / reasoning_recap / multimodal_text must stay distinguishable
        // from user-authored text downstream.
        block_kind: contentType,
        representations: [representation("canonical_text", text, blockLocator)]
      };
      bundle.content_blocks.push(block);

      const edge: VersionedProvenanceEdge = {
        workspace_id: workspaceId,
        provenance_edge_id: deterministicId("provenance_edge", workspaceId, { ...blockNatural, container: options.containerSha256 }),
        idempotency_key: idempotencyKey("provenance_edge", workspaceId, { ...blockNatural, container: options.containerSha256 }),
        target_record_type: "source_evidence",
        target_record_id: blockId,
        relation: "derived_from",
        evidence: {
          workspace_id: workspaceId,
          source_record_id: blockSourceRecordId,
          source_version_id: sourceVersionId,
          conversation_id: conversationId,
          message_id: messageId,
          content_block_id: blockId,
          representation_kind: "canonical_text",
          representation_sha256: sha256(text)
        },
        created_at: observedAt
      };
      bundle.provenance_edges.push(edge);
    });

    sequence += 1;
  }

  // The logical conversation row is version-INDEPENDENT: no source_version_id,
  // no container in any of its keys, and its title representation is anchored on
  // the identity locator. A later export of the same conversation therefore
  // produces a byte-identical row, so the logical conversation count never grows.
  const title = conversation.title ?? "";
  const normalizedConversation: VersionedConversation = {
    workspace_id: workspaceId,
    conversation_id: conversationId,
    idempotency_key: idempotencyKey("conversation", workspaceId, uuid),
    source_record_id: identityRecordId,
    source_conversation_id: uuid,
    title_representation: representation("canonical_text", title, `hhs-conversation://${uuid}`)
  };
  bundle.conversations.push(normalizedConversation);

  const sourceVersion: SourceVersion = {
    workspace_id: workspaceId,
    source_version_id: sourceVersionId,
    idempotency_key: idempotencyKey("source_version", workspaceId, { uuid, container: options.containerSha256 }),
    source_record_id: conversationSourceRecordId,
    conversation_id: conversationId,
    source_family: NATIVE_EXPORT,
    content_sha256: contentSha256,
    immutable_source_locator: conversationLocator,
    source_container_sha256: options.containerSha256,
    verification_status: "complete",
    source_observed_at: observedAt,
    source_metadata: {
      adapter: "native-export",
      adapter_version: NATIVE_EXPORT_ADAPTER_VERSION,
      pipeline_version: pipelineVersion,
      container_name: options.containerName,
      source_container_kind: "export_zip",
      ...(options.sourceFileSha256 === undefined ? {} : { conversations_json_sha256: options.sourceFileSha256 }),
      ...(options.sourceFileRecordId === undefined ? {} : { conversations_json_source_record_id: options.sourceFileRecordId }),
      has_full_branch_tree: true,
      source_timestamps: "per_message_where_present",
      mapping_nodes: ordered.length,
      message_nodes: messageNodeIds.length,
      off_path_nodes: offPath,
      roles,
      content_types: contentTypes,
      source_create_time: isoOrUndefined(conversation.create_time) ?? null,
      source_update_time: isoOrUndefined(conversation.update_time) ?? null
    }
  };
  bundle.source_versions.push(sourceVersion);

  return {
    bundle,
    stats: {
      mapping_nodes: ordered.length,
      message_nodes: messageNodeIds.length,
      off_path_nodes: offPath,
      content_blocks: bundle.content_blocks.length,
      roles,
      content_types: contentTypes,
      messages_with_source_timestamp: withTimestamp
    }
  };
}
