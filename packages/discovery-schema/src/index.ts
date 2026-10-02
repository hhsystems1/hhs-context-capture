import { createHash } from "node:crypto";

export const DISCOVERY_SCHEMA_VERSION = "0.1.0";

/** Overall outcome of one discovery run. A run is never `complete` while any boundary or container is unverified. */
export type DiscoveryStatus = "complete" | "partial" | "needs_review";

/**
 * Typed absence. `complete` with zero items means "enumerated, nothing there".
 * `not_attempted` means "never looked" and must never be read as emptiness.
 */
export type EnumerationStatus = "complete" | "partial" | "not_attempted" | "blocked";

/** Per-dimension honesty about what an adapter can observe on a source. */
export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export type ReviewStatus = "clear" | "needs_review";

/** Whether an item is primary evidence or material a platform generated from other items. */
export type EvidenceClass = "original_evidence" | "derived_generated" | "mixed" | "unknown";

export type CaptureFeasibility = "capturable" | "metadata_only" | "blocked" | "unknown";

export type TransportKind = "browser_dom" | "local_file" | "export_archive" | "http_api" | "filesystem";

export type RelationshipKind =
  | "derived_from"
  | "attachment_of"
  | "transcript_of"
  | "duplicate_of"
  | "version_of"
  | "references"
  | "contained_in";

export type RelationshipConfidence = "observed" | "asserted_by_source" | "inferred";

export interface SourceReference {
  source_id: string;
  source_kind: string;
  observed_host: string;
  transport: TransportKind;
  adapter_id: string;
  adapter_version: string;
}

export interface OpaqueAccountReference {
  opaque_account_reference: string;
}

export interface DiscoveryEvidence {
  evidence_id: string;
  kind: "observation_log" | "sanitized_dom" | "screenshot";
  media_type: string;
  value: string;
  sha256: string;
  evidence_locator: string;
  captured_at: string;
}

export interface DiscoveryBoundaryVerification {
  enumeration_start_reached: boolean;
  enumeration_end_reached: boolean;
  traversal_stabilized: boolean;
  item_count_stabilized: boolean;
  initial_state_restored: boolean;
}

export interface ContainerObservation {
  container_id: string;
  source_native_id?: string;
  parent_container_id?: string;
  container_kind: string;
  title: string;
  source_url?: string;
  depth: number;
  position: number;
  declared_item_count?: number;
  observed_item_count: number;
  enumeration_status: EnumerationStatus;
  observed_at: string;
  observation_fingerprint: string;
  evidence_ids: string[];
  review_status: ReviewStatus;
  review_reasons: string[];
  source_metadata: Record<string, unknown>;
}

export interface DeclaredItemMetadata {
  created_at?: string;
  modified_at?: string;
  size_bytes?: number;
  item_count?: number;
  message_count?: number;
  duration_seconds?: number;
  mime_type?: string;
  version_label?: string;
  checksum?: string;
}

export interface ItemObservation {
  item_id: string;
  source_native_id?: string;
  container_id: string;
  item_kind: string;
  title: string;
  source_url?: string;
  position: number;
  declared: DeclaredItemMetadata;
  evidence_class: EvidenceClass;
  capture_feasibility: CaptureFeasibility;
  blocked_reason?: string;
  observed_at: string;
  observation_fingerprint: string;
  evidence_ids: string[];
  review_status: ReviewStatus;
  review_reasons: string[];
  source_metadata: Record<string, unknown>;
}

export interface RelationshipObservation {
  relationship_id: string;
  from_item_id: string;
  to_item_id: string;
  kind: RelationshipKind;
  confidence: RelationshipConfidence;
  basis: string[];
}

export interface DiscoveryRun {
  schema_version: typeof DISCOVERY_SCHEMA_VERSION;
  discovery_run_id: string;
  source: SourceReference;
  account: OpaqueAccountReference;
  started_at: string;
  completed_at: string;
  status: DiscoveryStatus;
  boundary_verification: DiscoveryBoundaryVerification;
  capabilities: Record<string, CapabilitySupport>;
  containers: ContainerObservation[];
  items: ItemObservation[];
  relationships: RelationshipObservation[];
  evidence: DiscoveryEvidence[];
  warnings: string[];
  snapshot_sha256: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function computeEvidenceHash(evidence: Pick<DiscoveryEvidence, "value">): string {
  return sha256(evidence.value);
}

export function computeContainerFingerprint(container: Omit<ContainerObservation, "observation_fingerprint">): string {
  return sha256(stableJson({
    container_id: container.container_id,
    source_native_id: container.source_native_id ?? null,
    parent_container_id: container.parent_container_id ?? null,
    container_kind: container.container_kind,
    title: container.title,
    source_url: container.source_url ?? null,
    declared_item_count: container.declared_item_count ?? null,
    observed_item_count: container.observed_item_count,
    enumeration_status: container.enumeration_status,
    source_metadata: container.source_metadata
  }));
}

export function computeItemFingerprint(item: Omit<ItemObservation, "observation_fingerprint">): string {
  return sha256(stableJson({
    item_id: item.item_id,
    source_native_id: item.source_native_id ?? null,
    container_id: item.container_id,
    item_kind: item.item_kind,
    title: item.title,
    source_url: item.source_url ?? null,
    declared: item.declared,
    evidence_class: item.evidence_class,
    capture_feasibility: item.capture_feasibility,
    source_metadata: item.source_metadata
  }));
}

export function computeDiscoveryHash(run: Omit<DiscoveryRun, "snapshot_sha256"> | DiscoveryRun): string {
  const payload: Partial<DiscoveryRun> = { ...run };
  delete payload.snapshot_sha256;
  return sha256(stableJson(payload));
}

export function finalizeDiscovery(run: Omit<DiscoveryRun, "snapshot_sha256">): DiscoveryRun {
  return { ...run, snapshot_sha256: computeDiscoveryHash(run) };
}

/**
 * A run may only claim `complete` when every boundary was verified, no warnings were raised,
 * and every container was fully enumerated. Anything less is `partial` or `needs_review`.
 */
export function isVerifiedCompleteDiscovery(run: DiscoveryRun): boolean {
  const boundary = run.boundary_verification;
  return run.status === "complete"
    && run.warnings.length === 0
    && boundary.enumeration_start_reached
    && boundary.enumeration_end_reached
    && boundary.traversal_stabilized
    && boundary.item_count_stabilized
    && run.containers.every((container) => container.enumeration_status === "complete");
}

export function validateDiscoveryIntegrity(run: DiscoveryRun): string[] {
  const failures: string[] = [];
  if (computeDiscoveryHash(run) !== run.snapshot_sha256) failures.push("discovery.snapshot_hash_mismatch");
  if (Object.keys(run.capabilities).length === 0) failures.push("discovery.capability_report_missing");

  const evidenceIds = new Set<string>();
  for (const item of run.evidence) {
    if (evidenceIds.has(item.evidence_id)) failures.push(`discovery.duplicate_evidence:${item.evidence_id}`);
    evidenceIds.add(item.evidence_id);
    if (computeEvidenceHash(item) !== item.sha256) failures.push(`discovery.evidence_hash_mismatch:${item.evidence_id}`);
  }

  const containerIds = new Set<string>();
  for (const container of run.containers) {
    if (containerIds.has(container.container_id)) failures.push(`discovery.duplicate_container:${container.container_id}`);
    containerIds.add(container.container_id);
    if (container.review_status === "needs_review" && container.review_reasons.length === 0) {
      failures.push(`discovery.review_reason_required:${container.container_id}`);
    }
    for (const evidenceId of container.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) failures.push(`discovery.missing_evidence:${container.container_id}:${evidenceId}`);
    }
    if (container.enumeration_status === "not_attempted" && container.observed_item_count !== 0) {
      failures.push(`discovery.not_attempted_container_reported_items:${container.container_id}`);
    }
    const { observation_fingerprint: containerFingerprint, ...containerRest } = container;
    if (computeContainerFingerprint(containerRest) !== containerFingerprint) {
      failures.push(`discovery.container_fingerprint_mismatch:${container.container_id}`);
    }
  }
  for (const container of run.containers) {
    if (container.parent_container_id !== undefined && !containerIds.has(container.parent_container_id)) {
      failures.push(`discovery.unresolved_parent_container:${container.container_id}`);
    }
  }

  const itemIds = new Set<string>();
  const observedPerContainer = new Map<string, number>();
  for (const item of run.items) {
    if (itemIds.has(item.item_id)) failures.push(`discovery.duplicate_item:${item.item_id}`);
    itemIds.add(item.item_id);
    if (!containerIds.has(item.container_id)) failures.push(`discovery.unresolved_container:${item.item_id}`);
    observedPerContainer.set(item.container_id, (observedPerContainer.get(item.container_id) ?? 0) + 1);
    if (item.review_status === "needs_review" && item.review_reasons.length === 0) {
      failures.push(`discovery.review_reason_required:${item.item_id}`);
    }
    if (item.capture_feasibility === "blocked" && item.blocked_reason === undefined) {
      failures.push(`discovery.blocked_reason_required:${item.item_id}`);
    }
    for (const evidenceId of item.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) failures.push(`discovery.missing_evidence:${item.item_id}:${evidenceId}`);
    }
    const { observation_fingerprint: itemFingerprint, ...itemRest } = item;
    if (computeItemFingerprint(itemRest) !== itemFingerprint) {
      failures.push(`discovery.item_fingerprint_mismatch:${item.item_id}`);
    }
  }

  for (const container of run.containers) {
    const actual = observedPerContainer.get(container.container_id) ?? 0;
    if (container.observed_item_count !== actual) {
      failures.push(`discovery.container_item_count_mismatch:${container.container_id}`);
    }
  }

  const relationshipIds = new Set<string>();
  for (const relationship of run.relationships) {
    if (relationshipIds.has(relationship.relationship_id)) {
      failures.push(`discovery.duplicate_relationship:${relationship.relationship_id}`);
    }
    relationshipIds.add(relationship.relationship_id);
    if (!itemIds.has(relationship.from_item_id)) failures.push(`discovery.unresolved_relationship_source:${relationship.relationship_id}`);
    if (!itemIds.has(relationship.to_item_id)) failures.push(`discovery.unresolved_relationship_target:${relationship.relationship_id}`);
  }

  if (run.status === "complete" && !isVerifiedCompleteDiscovery(run)) failures.push("discovery.complete_boundaries_not_verified");
  return failures;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}
