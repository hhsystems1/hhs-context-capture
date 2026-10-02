import { createHash } from "node:crypto";
import type { CaptureBundle, CanonicalMessage } from "@hhs/canonical-schema";
import { projectImmutableCaptureReference, type ImmutableCaptureReference } from "@hhs/inventory-schema";

export const CAPTURE_VERSION_SCHEMA_VERSION = "0.1.0";

export interface MessageVersionSummary {
  message_id: string;
  platform_message_id?: string;
  sequence: number;
  role: CanonicalMessage["role"];
  parent_message_id?: string;
  branch_id?: string;
  representation_hashes: Record<string, string>;
  content_block_hashes: Record<string, string>;
  attachment_hashes: string[];
  citation_hashes: string[];
  artifact_hashes: string[];
  tool_event_hashes: string[];
  summary_sha256: string;
}

export interface ImmutableCaptureVersion extends ImmutableCaptureReference {
  version_schema: typeof CAPTURE_VERSION_SCHEMA_VERSION;
  platform_id: string;
  opaque_account_reference: string;
  source_url: string;
  schema_version: string;
  adapter_version: string;
  verification_status: CaptureBundle["verification"]["status"];
  branch_hashes: string[];
  messages: MessageVersionSummary[];
  version_sha256: string;
}

export interface ReconciliationCandidate {
  version: ImmutableCaptureVersion;
  source_archive_path: string;
  source_hashes_verified: boolean;
}

export interface ReconciliationDecision {
  capture_id: string;
  conversation_id: string;
  disposition: "add" | "already_present" | "needs_review";
  reasons: string[];
  reference: ImmutableCaptureReference;
}

export function createImmutableCaptureVersion(bundle: CaptureBundle, archivePath: string, manifestSha256: string): ImmutableCaptureVersion {
  assertHash(manifestSha256, "manifest");
  const messages = [...bundle.messages].sort((a, b) => a.sequence - b.sequence).map((message) => summarizeMessage(bundle, message));
  const reference: ImmutableCaptureReference = {
    capture_id: bundle.capture.capture_id,
    conversation_id: bundle.conversation.conversation_id,
    archive_path: archivePath,
    manifest_sha256: manifestSha256,
    captured_at: bundle.capture.completed_at,
    status: bundle.verification.status,
    message_count: bundle.messages.length,
    message_hashes: Object.fromEntries(messages.map((message) => [message.message_id, message.summary_sha256]))
  };
  const payload: Omit<ImmutableCaptureVersion, "version_sha256"> = {
    ...reference,
    version_schema: CAPTURE_VERSION_SCHEMA_VERSION,
    platform_id: bundle.platform.id,
    opaque_account_reference: bundle.account.opaque_account_reference,
    source_url: bundle.conversation.source_url,
    schema_version: bundle.schema_version,
    adapter_version: bundle.capture.adapter_version,
    verification_status: bundle.verification.status,
    branch_hashes: bundle.branches.map((branch) => sha256(stableJson(branch))).sort(),
    messages
  };
  return { ...payload, version_sha256: sha256(stableJson(payload)) };
}

export function toCaptureReference(version: ImmutableCaptureVersion): ImmutableCaptureReference {
  return projectImmutableCaptureReference(version);
}

export function planCaptureReconciliation(existing: ImmutableCaptureReference[], candidates: ReconciliationCandidate[]): ReconciliationDecision[] {
  const decisions: ReconciliationDecision[] = [];
  const seenIncoming = new Map<string, ImmutableCaptureVersion>();
  for (const candidate of candidates) {
    const reference = toCaptureReference(candidate.version);
    const priorIncoming = seenIncoming.get(reference.capture_id);
    const prior = existing.find((item) => item.capture_id === reference.capture_id);
    const reasons: string[] = [];
    if (!candidate.source_hashes_verified) reasons.push("source_archive_hashes_not_verified");
    if (!verifyCaptureVersion(candidate.version)) reasons.push("capture_version_hash_invalid");
    if (priorIncoming && stableJson(toCaptureReference(priorIncoming)) !== stableJson(reference)) reasons.push("duplicate_capture_id_conflict_in_scan");
    if (prior && stableJson(projectImmutableCaptureReference(prior)) !== stableJson(reference)) reasons.push("immutable_capture_reference_conflict");
    seenIncoming.set(reference.capture_id, candidate.version);
    decisions.push({
      capture_id: reference.capture_id,
      conversation_id: reference.conversation_id,
      disposition: reasons.length > 0 ? "needs_review" : prior ? "already_present" : "add",
      reasons,
      reference
    });
  }
  return decisions;
}

export function verifyCaptureVersion(version: ImmutableCaptureVersion): boolean {
  const { version_sha256, ...payload } = version;
  return /^[a-f0-9]{64}$/.test(version_sha256) && sha256(stableJson(payload)) === version_sha256 && version.messages.every((message) => verifyMessageSummary(message));
}

function summarizeMessage(bundle: CaptureBundle, message: CanonicalMessage): MessageVersionSummary {
  const relatedAttachments = bundle.attachments.filter((item) => item.related_message_id === message.message_id).map((item) => sha256(stableJson(item))).sort();
  const relatedCitations = bundle.citations.filter((item) => item.related_message_id === message.message_id).map((item) => sha256(stableJson(item))).sort();
  const relatedArtifacts = bundle.artifacts.filter((item) => item.related_message_id === message.message_id).map((item) => sha256(stableJson(item))).sort();
  const relatedToolEvents = bundle.tool_events.filter((item) => item.related_message_id === message.message_id).map((item) => sha256(stableJson(item))).sort();
  const payload = {
    message_id: message.message_id,
    ...(message.platform_message_id ? { platform_message_id: message.platform_message_id } : {}),
    sequence: message.sequence,
    role: message.role,
    ...(message.parent_message_id ? { parent_message_id: message.parent_message_id } : {}),
    ...(message.branch_id ? { branch_id: message.branch_id } : {}),
    representation_hashes: Object.fromEntries(message.representations.map((item): [string, string] => [item.kind, item.sha256]).sort(([a], [b]) => a.localeCompare(b))),
    content_block_hashes: Object.fromEntries(message.content_blocks.map((block): [string, string] => [block.block_id, sha256(stableJson({ type: block.type, sequence: block.sequence, representations: block.representations.map((item) => ({ kind: item.kind, sha256: item.sha256 })), attributes: block.attributes, platform_metadata: block.platform_metadata }))]).sort(([a], [b]) => a.localeCompare(b))),
    attachment_hashes: relatedAttachments,
    citation_hashes: relatedCitations,
    artifact_hashes: relatedArtifacts,
    tool_event_hashes: relatedToolEvents
  };
  return { ...payload, summary_sha256: sha256(stableJson(payload)) };
}

function verifyMessageSummary(message: MessageVersionSummary): boolean {
  const { summary_sha256, ...payload } = message;
  return sha256(stableJson(payload)) === summary_sha256;
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} SHA-256.`);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
}
