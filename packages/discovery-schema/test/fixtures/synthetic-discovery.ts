import type {
  ContainerObservation,
  DiscoveryEvidence,
  DiscoveryRun,
  EnumerationStatus,
  ItemObservation,
  RelationshipObservation
} from "../../src/index.js";
import {
  computeContainerFingerprint,
  computeEvidenceHash,
  computeItemFingerprint,
  finalizeDiscovery
} from "../../src/index.js";

const timestamp = "2026-08-12T12:00:00.000Z";

export function syntheticEvidence(reference: string): DiscoveryEvidence {
  const value = JSON.stringify({ reference, source: "synthetic_fixture" });
  return {
    evidence_id: `evidence-${reference}`,
    kind: "observation_log",
    media_type: "application/json",
    value,
    sha256: computeEvidenceHash({ value }),
    evidence_locator: `synthetic://${reference}`,
    captured_at: timestamp
  };
}

export function syntheticContainer(
  containerId: string,
  observedItemCount: number,
  enumerationStatus: EnumerationStatus = "complete",
  position = 0
): ContainerObservation {
  const base = {
    container_id: containerId,
    source_native_id: `native-${containerId}`,
    container_kind: "project",
    title: `Container ${containerId}`,
    source_url: `https://synthetic.invalid/container/${containerId}`,
    depth: 0,
    position,
    observed_item_count: observedItemCount,
    enumeration_status: enumerationStatus,
    observed_at: timestamp,
    evidence_ids: [`evidence-${containerId}`],
    review_status: "clear" as const,
    review_reasons: [],
    source_metadata: { fixture: true }
  };
  return { ...base, observation_fingerprint: computeContainerFingerprint(base) };
}

export function syntheticItem(
  itemId: string,
  containerId: string,
  position = 0,
  overrides: Partial<Pick<ItemObservation, "evidence_class" | "capture_feasibility" | "declared" | "title">> = {}
): ItemObservation {
  const base = {
    item_id: itemId,
    source_native_id: `native-${itemId}`,
    container_id: containerId,
    item_kind: "conversation",
    title: overrides.title ?? `Item ${itemId}`,
    source_url: `https://synthetic.invalid/item/${itemId}`,
    position,
    declared: overrides.declared ?? { modified_at: timestamp },
    evidence_class: overrides.evidence_class ?? ("original_evidence" as const),
    capture_feasibility: overrides.capture_feasibility ?? ("capturable" as const),
    observed_at: timestamp,
    evidence_ids: [`evidence-${itemId}`],
    review_status: "clear" as const,
    review_reasons: [],
    source_metadata: { fixture: true }
  };
  return { ...base, observation_fingerprint: computeItemFingerprint(base) };
}

export function syntheticRelationship(
  relationshipId: string,
  fromItemId: string,
  toItemId: string,
  kind: RelationshipObservation["kind"] = "derived_from",
  confidence: RelationshipObservation["confidence"] = "asserted_by_source"
): RelationshipObservation {
  return {
    relationship_id: relationshipId,
    from_item_id: fromItemId,
    to_item_id: toItemId,
    kind,
    confidence,
    basis: ["synthetic_fixture"]
  };
}

export interface SyntheticDiscoveryOptions {
  status?: DiscoveryRun["status"];
  boundaryOverrides?: Partial<DiscoveryRun["boundary_verification"]>;
  warnings?: string[];
  relationships?: RelationshipObservation[];
  extraEvidence?: DiscoveryEvidence[];
}

export function syntheticDiscovery(
  discoveryRunId: string,
  containers: ContainerObservation[],
  items: ItemObservation[],
  options: SyntheticDiscoveryOptions = {}
): DiscoveryRun {
  const evidence = [
    ...containers.map((container) => syntheticEvidence(container.container_id)),
    ...items.map((item) => syntheticEvidence(item.item_id)),
    ...(options.extraEvidence ?? [])
  ];
  return finalizeDiscovery({
    schema_version: "0.1.0",
    discovery_run_id: discoveryRunId,
    source: {
      source_id: "synthetic-source",
      source_kind: "synthetic",
      observed_host: "synthetic.invalid",
      transport: "browser_dom",
      adapter_id: "synthetic-adapter",
      adapter_version: "0.1.0"
    },
    account: { opaque_account_reference: "opaque-account-synthetic" },
    started_at: timestamp,
    completed_at: timestamp,
    status: options.status ?? "complete",
    boundary_verification: {
      enumeration_start_reached: true,
      enumeration_end_reached: true,
      traversal_stabilized: true,
      item_count_stabilized: true,
      initial_state_restored: true,
      ...options.boundaryOverrides
    },
    capabilities: { containers: "supported", items: "supported", item_timestamps: "unknown" },
    containers,
    items,
    relationships: options.relationships ?? [],
    evidence,
    warnings: options.warnings ?? []
  });
}
