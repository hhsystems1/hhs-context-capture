import type { CapabilitySupport, DiscoveryBoundaryVerification, DiscoveryRun } from "@hhs/discovery-schema";
import { runDiscovery } from "@hhs/discovery-engine";
import { resolveDiscoveryAdapter, type UnsupportedResolution } from "./registry.js";
import { compareDiscoveryRun, type ComparisonOutcome, type ComparisonTransport } from "./compare.js";

export const DEFAULT_ITEM_SAMPLE_LIMIT = 25;

export interface DiscoveryItemSample {
  item_kind: string;
  title: string;
  source_native_id: string | null;
  container_title: string;
  review_status: string;
}

export interface DiscoveryContainerSummary {
  container_kind: string;
  title: string;
  observed_item_count: number;
  declared_item_count: number | null;
  enumeration_status: string;
}

export interface DiscoverySummary {
  source_kind: string;
  adapter_id: string;
  adapter_version: string;
  transport: string;
  observed_host: string;
  status: string;
  verified_complete: boolean;
  boundary_verification: DiscoveryBoundaryVerification;
  capabilities: Record<string, CapabilitySupport>;
  totals: {
    containers: number;
    items: number;
    items_needing_review: number;
    items_by_kind: Record<string, number>;
  };
  containers: DiscoveryContainerSummary[];
  warnings: string[];
  item_sample: DiscoveryItemSample[];
  item_sample_truncated: boolean;
  snapshot_sha256: string;
  started_at: string;
  completed_at: string;
  /**
   * Read-only comparison against memory_v1, when a comparison transport was supplied. Absent when
   * discovery ran without one; `available: false` when the local service could not be reached.
   */
  comparison?: ComparisonOutcome;
  /** Dry discovery. The full run is held in memory for the duration of the call and never stored. */
  persisted: false;
}

export type SiteDiscoveryResult =
  | { ok: true; summary: DiscoverySummary }
  | { ok: false; refusal: UnsupportedResolution };

/**
 * Runs one dry discovery pass over the current page.
 *
 * The complete `DiscoveryRun` never leaves this function: it is summarized and then dropped when the
 * call returns. Nothing is written to disk, storage, the collector, or the database, and the full run
 * is deliberately not returned so it cannot be forwarded across the extension message boundary.
 */
export async function runSiteDiscovery(
  root: Document,
  url: string,
  opaqueAccountReference: string,
  onProgress: (message: string) => void = () => undefined,
  sampleLimit: number = DEFAULT_ITEM_SAMPLE_LIMIT,
  compare?: ComparisonTransport
): Promise<SiteDiscoveryResult> {
  const host = new URL(url).hostname;
  const resolution = resolveDiscoveryAdapter(host);
  if (!resolution.supported) return { ok: false, refusal: resolution };

  const run = await runDiscovery(resolution.adapter, { host, url, root }, {
    opaqueAccountReference,
    hash: browserSha256,
    onProgress: (progress) => onProgress(
      `Read-only discovery: ${progress.items} items in ${progress.containers} containers; pass ${progress.pass}.`
    )
  });

  const summary = summarizeDiscoveryRun(run, sampleLimit);
  if (!compare) return { ok: true, summary };

  onProgress(`Comparing ${run.items.length} conversations against memory_v1 (read-only)...`);
  const comparison = await compareDiscoveryRun(run, compare, browserSha256);
  return { ok: true, summary: { ...summary, comparison } };
}

export function summarizeDiscoveryRun(run: DiscoveryRun, sampleLimit: number = DEFAULT_ITEM_SAMPLE_LIMIT): DiscoverySummary {
  const containerTitles = new Map(run.containers.map((container) => [container.container_id, container.title]));
  const itemsByKind: Record<string, number> = {};
  for (const item of run.items) itemsByKind[item.item_kind] = (itemsByKind[item.item_kind] ?? 0) + 1;

  return {
    source_kind: run.source.source_kind,
    adapter_id: run.source.adapter_id,
    adapter_version: run.source.adapter_version,
    transport: run.source.transport,
    observed_host: run.source.observed_host,
    status: run.status,
    verified_complete: isVerifiedComplete(run),
    boundary_verification: run.boundary_verification,
    capabilities: run.capabilities,
    totals: {
      containers: run.containers.length,
      items: run.items.length,
      items_needing_review: run.items.filter((item) => item.review_status === "needs_review").length,
      items_by_kind: itemsByKind
    },
    containers: run.containers.map((container) => ({
      container_kind: container.container_kind,
      title: container.title,
      observed_item_count: container.observed_item_count,
      declared_item_count: container.declared_item_count ?? null,
      enumeration_status: container.enumeration_status
    })),
    warnings: run.warnings,
    item_sample: run.items.slice(0, sampleLimit).map((item) => ({
      item_kind: item.item_kind,
      title: item.title,
      source_native_id: item.source_native_id ?? null,
      container_title: containerTitles.get(item.container_id) ?? item.container_id,
      review_status: item.review_status
    })),
    item_sample_truncated: run.items.length > sampleLimit,
    snapshot_sha256: run.snapshot_sha256,
    started_at: run.started_at,
    completed_at: run.completed_at,
    persisted: false
  };
}

/**
 * Mirrors `isVerifiedCompleteDiscovery` from `@hhs/discovery-schema`. That module cannot be imported
 * at runtime here because it depends on Node's crypto module, which cannot be bundled into a
 * content script.
 */
function isVerifiedComplete(run: DiscoveryRun): boolean {
  const boundary = run.boundary_verification;
  return run.status === "complete"
    && run.warnings.length === 0
    && boundary.enumeration_start_reached
    && boundary.enumeration_end_reached
    && boundary.traversal_stabilized
    && boundary.item_count_stabilized
    && run.containers.every((container) => container.enumeration_status === "complete");
}

async function browserSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
