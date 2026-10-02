import type {
  ContainerObservation,
  DiscoveryBoundaryVerification,
  DiscoveryEvidence,
  DiscoveryRun,
  DiscoveryStatus,
  EnumerationStatus,
  ItemObservation
} from "@hhs/discovery-schema";
import type {
  DiscoveryAdapter,
  DiscoveryPortContext,
  RawContainerObservation,
  RawItemObservation,
  TraversalSnapshot
} from "./adapter-contract.js";

export type {
  DiscoveryAdapter,
  DiscoveryPortContext,
  DiscoveryTraversalPort,
  RawContainerObservation,
  RawItemObservation,
  SourceIdentification,
  TraversalSnapshot
} from "./adapter-contract.js";

const DEFAULT_MAX_PASSES = 2_000;
const DEFAULT_STABLE_PASSES = 4;
const POSITION_TOLERANCE = 2;

export interface DiscoveryProgress {
  pass: number;
  containers: number;
  items: number;
  position: number;
  extent: number;
}

export interface DiscoveryRunOptions {
  opaqueAccountReference: string;
  /**
   * Injected SHA-256 implementation. The engine never imports a hashing library so that the same
   * code runs inside a browser content script and under Node in tests.
   */
  hash: (value: string) => Promise<string>;
  now?: () => string;
  maxPasses?: number;
  stablePasses?: number;
  onProgress?: (progress: DiscoveryProgress) => void;
}

/**
 * Site-agnostic discovery. This function contains no knowledge of any particular source: it drives
 * whatever `DiscoveryTraversalPort` the adapter supplies, accumulates observations across passes so
 * virtualized rows survive leaving the view, verifies boundaries, and reports typed absence.
 *
 * It performs no writes of any kind. It returns an in-memory run and persists nothing.
 */
export async function runDiscovery(
  adapter: DiscoveryAdapter,
  context: DiscoveryPortContext,
  options: DiscoveryRunOptions
): Promise<DiscoveryRun> {
  const now = options.now ?? (() => new Date().toISOString());
  const hash = options.hash;
  const startedAt = now();
  const warnings: string[] = [];

  const identification = adapter.identify(context);
  if (!identification.detected) {
    throw new Error(`Source not detected by ${adapter.adapterId}: ${identification.reasons.join(" ")}`);
  }
  if (identification.confidence !== "high") warnings.push(`source_identification_confidence:${identification.confidence}`);

  const port = await adapter.openPort(context);
  const containers = new Map<string, AccumulatedContainer>();
  const items = new Map<string, AccumulatedItem>();
  const evidence: DiscoveryEvidence[] = [];
  const evidenceKeys = new Set<string>();
  let collisions = 0;

  const observe = async (snapshot: TraversalSnapshot): Promise<void> => {
    collisions += await accumulate(snapshot, containers, items, evidence, evidenceKeys, hash, now);
  };

  const initial = port.inspect();
  const initialPosition = initial.position;
  await observe(initial);

  port.seek(0);
  await port.waitForSettled();
  let snapshot = port.inspect();
  await observe(snapshot);
  const startReached = snapshot.position <= POSITION_TOLERANCE;
  if (!startReached) warnings.push("enumeration_start_boundary_not_reached");

  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const stablePassesRequired = options.stablePasses ?? DEFAULT_STABLE_PASSES;
  let endReached = false;
  let traversalStabilized = false;
  let countStabilized = false;
  let stableEndPasses = 0;
  let stableCountPasses = 0;
  let previousCount = containers.size + items.size;
  let previousPosition = -1;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    snapshot = port.inspect();
    await observe(snapshot);
    options.onProgress?.({
      pass,
      containers: containers.size,
      items: items.size,
      position: snapshot.position,
      extent: snapshot.extent
    });

    const observedCount = containers.size + items.size;
    stableCountPasses = observedCount === previousCount ? stableCountPasses + 1 : 0;
    previousCount = observedCount;

    const atEnd = snapshot.position + snapshot.viewport >= snapshot.extent - POSITION_TOLERANCE;
    stableEndPasses = atEnd && Math.abs(snapshot.position - previousPosition) <= POSITION_TOLERANCE ? stableEndPasses + 1 : 0;

    if (stableEndPasses >= stablePassesRequired && stableCountPasses >= stablePassesRequired) {
      endReached = true;
      traversalStabilized = true;
      countStabilized = true;
      break;
    }

    previousPosition = snapshot.position;
    const step = Math.max(200, Math.floor(snapshot.viewport * 0.75));
    port.seek(Math.min(snapshot.extent, snapshot.position + step));
    await port.waitForSettled();
  }

  if (!endReached) warnings.push("enumeration_end_boundary_not_verified");
  if (!traversalStabilized) warnings.push("traversal_did_not_stabilize");
  if (!countStabilized) warnings.push("observation_count_did_not_stabilize");
  if (collisions > 0) warnings.push(`identity_collisions:${collisions}`);

  port.seek(initialPosition);
  await port.waitForSettled();
  const restored = Math.abs(port.inspect().position - initialPosition) <= POSITION_TOLERANCE;
  if (!restored) warnings.push("initial_state_not_restored");

  const boundary: DiscoveryBoundaryVerification = {
    enumeration_start_reached: startReached,
    enumeration_end_reached: endReached,
    traversal_stabilized: traversalStabilized,
    item_count_stabilized: countStabilized,
    initial_state_restored: restored
  };
  const traversalVerified = startReached && endReached && traversalStabilized && countStabilized;

  const sourceId = `${adapter.sourceKind}:${context.host}`;
  const assembled = await assemble(containers, items, sourceId, traversalVerified, warnings, hash, now);

  if (assembled.containers.length === 0) warnings.push("no_containers_observed");
  if (assembled.items.length === 0) warnings.push("no_items_observed");

  const status: DiscoveryStatus = warnings.length > 0
    ? "needs_review"
    : assembled.containers.some((container) => container.enumeration_status !== "complete")
      ? "partial"
      : "complete";

  const withoutHash: Omit<DiscoveryRun, "snapshot_sha256"> = {
    schema_version: "0.1.0",
    discovery_run_id: `discovery-${await hash(`${sourceId}:${startedAt}`)}`.slice(0, 40),
    source: {
      source_id: sourceId,
      source_kind: adapter.sourceKind,
      observed_host: context.host,
      transport: adapter.transport,
      adapter_id: adapter.adapterId,
      adapter_version: adapter.adapterVersion
    },
    account: { opaque_account_reference: options.opaqueAccountReference },
    started_at: startedAt,
    completed_at: now(),
    status,
    boundary_verification: boundary,
    capabilities: { ...adapter.capabilities },
    containers: assembled.containers,
    items: assembled.items,
    relationships: [],
    evidence,
    warnings
  };

  return { ...withoutHash, snapshot_sha256: await hash(stableJson(withoutHash)) };
}

interface AccumulatedContainer {
  key: string;
  raw: RawContainerObservation;
  orderHint: number;
  evidenceIds: string[];
  reviewReasons: string[];
}

interface AccumulatedItem {
  key: string;
  raw: RawItemObservation;
  orderHint: number;
  evidenceIds: string[];
  reviewReasons: string[];
}

function containerKey(raw: RawContainerObservation): string {
  return raw.source_native_id ?? `${raw.container_kind}:${raw.title}`;
}

function itemKey(raw: RawItemObservation): string {
  return raw.source_native_id ?? raw.evidence_locator;
}

async function accumulate(
  snapshot: TraversalSnapshot,
  containers: Map<string, AccumulatedContainer>,
  items: Map<string, AccumulatedItem>,
  evidence: DiscoveryEvidence[],
  evidenceKeys: Set<string>,
  hash: (value: string) => Promise<string>,
  now: () => string
): Promise<number> {
  let collisions = 0;

  const recordEvidence = async (locator: string, value: string): Promise<string> => {
    const evidenceId = `evidence-${(await hash(locator)).slice(0, 24)}`;
    if (!evidenceKeys.has(evidenceId)) {
      evidenceKeys.add(evidenceId);
      evidence.push({
        evidence_id: evidenceId,
        kind: "sanitized_dom",
        media_type: "text/html",
        value,
        sha256: await hash(value),
        evidence_locator: locator,
        captured_at: now()
      });
    }
    return evidenceId;
  };

  for (const raw of snapshot.containers) {
    const key = containerKey(raw);
    const evidenceId = await recordEvidence(raw.evidence_locator, raw.sanitized_evidence);
    const existing = containers.get(key);
    if (existing) {
      if (existing.raw.title !== raw.title || existing.raw.source_url !== raw.source_url) {
        collisions += 1;
        if (!existing.reviewReasons.includes("conflicting_observations_for_stable_identity")) {
          existing.reviewReasons.push("conflicting_observations_for_stable_identity");
        }
      }
      existing.orderHint = Math.min(existing.orderHint, raw.order_hint);
      if (!existing.evidenceIds.includes(evidenceId)) existing.evidenceIds.push(evidenceId);
    } else {
      containers.set(key, { key, raw, orderHint: raw.order_hint, evidenceIds: [evidenceId], reviewReasons: [] });
    }
  }

  for (const raw of snapshot.items) {
    const key = itemKey(raw);
    const evidenceId = await recordEvidence(raw.evidence_locator, raw.sanitized_evidence);
    const existing = items.get(key);
    if (existing) {
      if (existing.raw.title !== raw.title || existing.raw.source_url !== raw.source_url) {
        collisions += 1;
        if (!existing.reviewReasons.includes("conflicting_observations_for_stable_identity")) {
          existing.reviewReasons.push("conflicting_observations_for_stable_identity");
        }
      }
      existing.orderHint = Math.min(existing.orderHint, raw.order_hint);
      if (!existing.evidenceIds.includes(evidenceId)) existing.evidenceIds.push(evidenceId);
    } else {
      items.set(key, { key, raw, orderHint: raw.order_hint, evidenceIds: [evidenceId], reviewReasons: [] });
    }
  }

  return collisions;
}

interface AssembledObservations {
  containers: ContainerObservation[];
  items: ItemObservation[];
}

async function assemble(
  containers: Map<string, AccumulatedContainer>,
  items: Map<string, AccumulatedItem>,
  sourceId: string,
  traversalVerified: boolean,
  warnings: string[],
  hash: (value: string) => Promise<string>,
  now: () => string
): Promise<AssembledObservations> {
  const sortedContainers = [...containers.values()].sort((a, b) => a.orderHint - b.orderHint || a.key.localeCompare(b.key));
  const sortedItems = [...items.values()].sort((a, b) => a.orderHint - b.orderHint || a.key.localeCompare(b.key));

  const containerIdByKey = new Map<string, string>();
  for (const container of sortedContainers) {
    containerIdByKey.set(container.key, `container-${(await hash(`${sourceId}:${container.key}`)).slice(0, 24)}`);
  }

  // An item may reference a container the adapter did not emit. That is a structural defect in the
  // observation, not an empty container: it is recorded explicitly rather than silently reassigned.
  const unresolvedRefs = new Set<string>();
  for (const item of sortedItems) {
    if (!containerIdByKey.has(item.raw.container_ref)) unresolvedRefs.add(item.raw.container_ref);
  }
  for (const ref of unresolvedRefs) {
    warnings.push(`unresolved_container_reference:${ref}`);
    containerIdByKey.set(ref, `container-${(await hash(`${sourceId}:unresolved:${ref}`)).slice(0, 24)}`);
  }

  const itemsByContainerId = new Map<string, ItemObservation[]>();
  const assembledItems: ItemObservation[] = [];
  for (const [index, item] of sortedItems.entries()) {
    const containerId = containerIdByKey.get(item.raw.container_ref)!;
    const reviewReasons = [...item.reviewReasons];
    if (unresolvedRefs.has(item.raw.container_ref)) reviewReasons.push("unresolved_container_reference");
    if (item.raw.source_native_id === undefined) reviewReasons.push("unstable_item_identity");

    const base = {
      item_id: `item-${(await hash(`${sourceId}:${item.key}`)).slice(0, 24)}`,
      ...(item.raw.source_native_id === undefined ? {} : { source_native_id: item.raw.source_native_id }),
      container_id: containerId,
      item_kind: item.raw.item_kind,
      title: item.raw.title,
      ...(item.raw.source_url === undefined ? {} : { source_url: item.raw.source_url }),
      position: index,
      declared: item.raw.declared,
      evidence_class: item.raw.evidence_class,
      capture_feasibility: item.raw.capture_feasibility,
      ...(item.raw.blocked_reason === undefined ? {} : { blocked_reason: item.raw.blocked_reason }),
      observed_at: now(),
      evidence_ids: item.evidenceIds,
      review_status: (reviewReasons.length > 0 ? "needs_review" : "clear") as ItemObservation["review_status"],
      review_reasons: reviewReasons,
      source_metadata: item.raw.source_metadata
    };
    const observation: ItemObservation = { ...base, observation_fingerprint: await hash(stableJson(itemFingerprintPayload(base))) };
    assembledItems.push(observation);
    const bucket = itemsByContainerId.get(containerId);
    if (bucket) bucket.push(observation);
    else itemsByContainerId.set(containerId, [observation]);
  }

  const assembledContainers: ContainerObservation[] = [];
  const emit = async (
    containerId: string,
    raw: Pick<RawContainerObservation, "container_kind" | "title" | "depth" | "source_metadata"> & Partial<RawContainerObservation>,
    position: number,
    evidenceIds: string[],
    reviewReasons: string[],
    forcedStatus?: EnumerationStatus
  ): Promise<void> => {
    const observed = itemsByContainerId.get(containerId)?.length ?? 0;
    const declared = raw.declared_item_count;
    const reasons = [...reviewReasons];
    let enumerationStatus: EnumerationStatus = forcedStatus ?? (traversalVerified ? "complete" : "partial");
    if (declared !== undefined && declared !== observed) {
      enumerationStatus = "partial";
      reasons.push(`declared_item_count_mismatch:${declared}:${observed}`);
    }
    const base = {
      container_id: containerId,
      ...(raw.source_native_id === undefined ? {} : { source_native_id: raw.source_native_id }),
      container_kind: raw.container_kind,
      title: raw.title,
      ...(raw.source_url === undefined ? {} : { source_url: raw.source_url }),
      depth: raw.depth,
      position,
      ...(declared === undefined ? {} : { declared_item_count: declared }),
      observed_item_count: observed,
      enumeration_status: enumerationStatus,
      observed_at: now(),
      evidence_ids: evidenceIds,
      review_status: (reasons.length > 0 ? "needs_review" : "clear") as ContainerObservation["review_status"],
      review_reasons: reasons,
      source_metadata: raw.source_metadata
    };
    assembledContainers.push({ ...base, observation_fingerprint: await hash(stableJson(containerFingerprintPayload(base))) });
  };

  let position = 0;
  for (const container of sortedContainers) {
    await emit(containerIdByKey.get(container.key)!, container.raw, position, container.evidenceIds, container.reviewReasons);
    position += 1;
  }
  for (const ref of unresolvedRefs) {
    await emit(
      containerIdByKey.get(ref)!,
      { container_kind: "unresolved_container", title: ref, depth: 0, source_metadata: { unresolved_reference: ref } },
      position,
      [],
      ["unresolved_container_reference"],
      "partial"
    );
    position += 1;
  }

  return { containers: assembledContainers, items: assembledItems };
}

/**
 * These payload shapes must stay byte-identical to `computeContainerFingerprint` and
 * `computeItemFingerprint` in `@hhs/discovery-schema`. The engine cannot import those functions
 * because they pull in Node's crypto module, which cannot be bundled into a content script.
 * `validateDiscoveryIntegrity` recomputes both fingerprints, so any drift fails the engine tests.
 */
function containerFingerprintPayload(container: Omit<ContainerObservation, "observation_fingerprint">): unknown {
  return {
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
  };
}

function itemFingerprintPayload(item: Omit<ItemObservation, "observation_fingerprint">): unknown {
  return {
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
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
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
