import type { DiscoveryRun } from "@hhs/discovery-schema";
import {
  buildCapturePlan,
  classifyDiscoveredConversations,
  summarizeComparison,
  type CapturePlan,
  type ClassifiedConversation,
  type ComparisonCounts,
  type DiscoveredIdentity,
  type KnownConversationRecord
} from "@hhs/capture-planning";

/** Placeholder used when no opaque account reference has been established for this browser. */
export const UNDECLARED_ACCOUNT = "opaque-account-undeclared";

/** The complete payload sent to the local Memory Query Service: identity and title only. */
export interface ComparisonRequestPayload {
  source_kind: string;
  opaque_account_reference: string;
  items: Array<{ source_native_id: string; title: string }>;
}

export interface ComparisonResponsePayload {
  known: KnownConversationRecord[];
}

export type ComparisonTransport = (payload: ComparisonRequestPayload) => Promise<ComparisonResponsePayload>;

export interface ComparisonClassificationSample {
  title: string;
  source_native_id: string | null;
  classification: string;
  reasons: string[];
}

export type ComparisonOutcome =
  | {
      available: true;
      counts: ComparisonCounts;
      plan: CapturePlan;
      needs_review_sample: ComparisonClassificationSample[];
    }
  | { available: false; reason: string };

/**
 * Builds the minimum comparison payload from a discovery run. Only conversation identities and their
 * visible titles are included; no content, evidence, URL, or metadata leaves the page.
 */
export function comparisonPayload(run: DiscoveryRun): ComparisonRequestPayload {
  return {
    source_kind: run.source.source_kind,
    opaque_account_reference: run.account.opaque_account_reference,
    items: run.items
      .filter((item) => item.item_kind === "conversation" && item.source_native_id !== undefined)
      .map((item) => ({ source_native_id: item.source_native_id!, title: item.title }))
  };
}

export function discoveredIdentities(run: DiscoveryRun): DiscoveredIdentity[] {
  return run.items
    .filter((item) => item.item_kind === "conversation")
    .map((item) => ({
      item_id: item.item_id,
      source_native_id: item.source_native_id ?? null,
      title: item.title,
      review_status: item.review_status
    }));
}

/**
 * Compares a discovery run against memory_v1 through the read-only local service and produces an
 * in-memory capture plan. Nothing is written on either side; if the service is unreachable the
 * discovery result still stands on its own.
 */
export async function compareDiscoveryRun(
  run: DiscoveryRun,
  transport: ComparisonTransport,
  hash: (value: string) => Promise<string>,
  now: () => string = () => new Date().toISOString(),
  needsReviewSampleLimit = 10
): Promise<ComparisonOutcome> {
  let known: KnownConversationRecord[];
  try {
    const response = await transport(comparisonPayload(run));
    known = Array.isArray(response.known) ? response.known : [];
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const classified = classifyDiscoveredConversations(discoveredIdentities(run), known, {
    discovery_status: run.status,
    account_established: run.account.opaque_account_reference !== UNDECLARED_ACCOUNT
  });

  const plan = await buildCapturePlan({
    source: {
      source_kind: run.source.source_kind,
      observed_host: run.source.observed_host,
      adapter_id: run.source.adapter_id,
      adapter_version: run.source.adapter_version,
      opaque_account_reference: run.account.opaque_account_reference
    },
    classified,
    discovery_snapshot_sha256: run.snapshot_sha256,
    created_at: now()
  }, hash);

  return {
    available: true,
    counts: summarizeComparison(classified),
    plan,
    needs_review_sample: sampleNeedsReview(classified, needsReviewSampleLimit)
  };
}

function sampleNeedsReview(classified: readonly ClassifiedConversation[], limit: number): ComparisonClassificationSample[] {
  return classified
    .filter((item) => item.classification === "needs_review")
    .slice(0, limit)
    .map((item) => ({
      title: item.title,
      source_native_id: item.source_native_id,
      classification: item.classification,
      reasons: item.reasons
    }));
}
