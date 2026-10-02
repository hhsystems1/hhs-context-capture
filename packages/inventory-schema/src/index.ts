import { createHash } from "node:crypto";
import type { CaptureStatus, PlatformId } from "@hhs/canonical-schema";

export const INVENTORY_SCHEMA_VERSION = "0.1.0";

export type InventoryStatus = "complete" | "partial" | "needs_review";
export type ReviewStatus = "clear" | "needs_review";
export type ConversationClassification = "new" | "possibly_changed" | "unchanged" | "missing" | "needs_review";

export interface PlatformReference {
  platform_id: PlatformId;
  observed_host: string;
}

export interface OpaqueAccountReference {
  opaque_account_reference: string;
}

export interface InventoryEvidence {
  evidence_id: string;
  kind: "observation_log" | "sanitized_dom" | "screenshot";
  media_type: string;
  value: string;
  sha256: string;
  evidence_locator: string;
  captured_at: string;
}

export interface ConversationObservation {
  observation_id: string;
  conversation_id: string;
  platform_conversation_id?: string;
  title: string;
  source_url?: string;
  sidebar_position: number;
  observed_at: string;
  observation_fingerprint: string;
  visible_status_indicators: string[];
  evidence_ids: string[];
  review_status: ReviewStatus;
  review_reasons: string[];
  platform_metadata: Record<string, unknown>;
}

export interface InventoryBoundaryVerification {
  earliest_reached: boolean;
  latest_reached: boolean;
  scroll_stabilized: boolean;
  observation_count_stabilized: boolean;
  initial_position_restored: boolean;
}

export interface InventoryRun {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  inventory_id: string;
  platform: PlatformReference;
  account: OpaqueAccountReference;
  started_at: string;
  completed_at: string;
  status: InventoryStatus;
  boundary_verification: InventoryBoundaryVerification;
  observations: ConversationObservation[];
  evidence: InventoryEvidence[];
  warnings: string[];
  snapshot_sha256: string;
}

export interface ImmutableCaptureReference {
  capture_id: string;
  conversation_id: string;
  archive_path: string;
  manifest_sha256: string;
  captured_at: string;
  status: CaptureStatus;
  message_count: number;
  message_hashes: Readonly<Record<string, string>>;
}

export function projectImmutableCaptureReference(reference: ImmutableCaptureReference): ImmutableCaptureReference {
  return {
    capture_id: reference.capture_id,
    conversation_id: reference.conversation_id,
    archive_path: reference.archive_path,
    manifest_sha256: reference.manifest_sha256,
    captured_at: reference.captured_at,
    status: reference.status,
    message_count: reference.message_count,
    message_hashes: { ...reference.message_hashes }
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function computeEvidenceHash(evidence: Pick<InventoryEvidence, "value">): string {
  return sha256(evidence.value);
}

export function computeObservationFingerprint(observation: Omit<ConversationObservation, "observation_fingerprint">): string {
  return sha256(stableJson({
    conversation_id: observation.conversation_id,
    platform_conversation_id: observation.platform_conversation_id ?? null,
    title: observation.title,
    source_url: observation.source_url ?? null,
    visible_status_indicators: observation.visible_status_indicators,
    platform_metadata: observation.platform_metadata
  }));
}

export function computeInventoryHash(run: Omit<InventoryRun, "snapshot_sha256"> | InventoryRun): string {
  const payload: Partial<InventoryRun> = { ...run };
  delete payload.snapshot_sha256;
  return sha256(stableJson(payload));
}

export function finalizeInventory(run: Omit<InventoryRun, "snapshot_sha256">): InventoryRun {
  return { ...run, snapshot_sha256: computeInventoryHash(run) };
}

export function validateInventoryIntegrity(run: InventoryRun): string[] {
  const failures: string[] = [];
  if (computeInventoryHash(run) !== run.snapshot_sha256) failures.push("inventory.snapshot_hash_mismatch");
  const evidenceIds = new Set<string>();
  for (const item of run.evidence) {
    if (evidenceIds.has(item.evidence_id)) failures.push(`inventory.duplicate_evidence:${item.evidence_id}`);
    evidenceIds.add(item.evidence_id);
    if (computeEvidenceHash(item) !== item.sha256) failures.push(`inventory.evidence_hash_mismatch:${item.evidence_id}`);
  }
  const observationIds = new Set<string>();
  for (const observation of run.observations) {
    if (observationIds.has(observation.observation_id)) failures.push(`inventory.duplicate_observation:${observation.observation_id}`);
    observationIds.add(observation.observation_id);
    for (const evidenceId of observation.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) failures.push(`inventory.missing_evidence:${observation.observation_id}:${evidenceId}`);
    }
    if (observation.review_status === "needs_review" && observation.review_reasons.length === 0) {
      failures.push(`inventory.review_reason_required:${observation.observation_id}`);
    }
  }
  if (run.status === "complete" && !isVerifiedCompleteInventory(run)) failures.push("inventory.complete_boundaries_not_verified");
  return failures;
}

export function isVerifiedCompleteInventory(run: InventoryRun): boolean {
  const boundary = run.boundary_verification;
  return run.status === "complete" && run.warnings.length === 0 && boundary.earliest_reached && boundary.latest_reached && boundary.scroll_stabilized && boundary.observation_count_stabilized;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
