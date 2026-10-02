/**
 * Read-only comparison rules and capture-plan assembly.
 *
 * This package is pure: no database, no filesystem, no network, and no hashing library. It is
 * bundled into a browser content script, so SHA-256 is injected by the caller.
 *
 * Every rule here is conservative. Ambiguity resolves to `needs_review`, and nothing classified
 * `needs_review` may enter a capture plan.
 */

export const CAPTURE_PLAN_VERSION = "0.1.0";

/** The five mutually exclusive primary states. `already_known` is a display rollup, never a state. */
export type ComparisonClassification =
  | "never_captured"
  | "possibly_changed"
  | "captured_partial"
  | "captured_verified"
  | "needs_review";

/**
 * Conservative precedence, highest first. When more than one signal applies, the state implying the
 * most outstanding work wins, and every contributing signal is retained in `reasons`.
 */
export const CLASSIFICATION_PRECEDENCE: readonly ComparisonClassification[] = [
  "needs_review",
  "possibly_changed",
  "captured_partial",
  "captured_verified",
  "never_captured"
];

/** Classifications eligible for a proposed capture. `captured_verified` and `needs_review` are not. */
export const PLANNABLE_CLASSIFICATIONS: readonly ComparisonClassification[] = [
  "never_captured",
  "possibly_changed",
  "captured_partial"
];

export type CaptureVerificationStatus = "complete" | "partial" | "failed" | "needs_review";

export interface DiscoveredIdentity {
  item_id: string;
  /** The raw platform conversation id. `null` when the source exposed no stable identity. */
  source_native_id: string | null;
  title: string;
  /** Review status carried over from the discovery run itself. */
  review_status: "clear" | "needs_review";
}

/** One row as returned by memory_v1, before collapsing to a single per-conversation verdict. */
export interface KnownConversationRow {
  source_native_id: string;
  conversation_record_id: string;
  verification_status: CaptureVerificationStatus | null;
  captured_at: string | null;
  title_sha256: string | null;
}

/** The collapsed, per-conversation view of what memory_v1 already holds. */
export interface KnownConversationRecord {
  source_native_id: string;
  verification_status: CaptureVerificationStatus | null;
  captured_at: string | null;
  capture_version_count: number;
  title_matches: boolean;
  ambiguous: boolean;
  ambiguity_reasons: string[];
}

export interface ComparisonContext {
  /** Status of the discovery run that produced the discovered identities. */
  discovery_status: "complete" | "partial" | "needs_review";
  /** False when discovery ran without an established opaque account reference. */
  account_established: boolean;
}

export interface ClassifiedConversation {
  item_id: string;
  source_native_id: string | null;
  title: string;
  classification: ComparisonClassification;
  reasons: string[];
}

export interface ComparisonCounts {
  total_discovered: number;
  /** Display rollup only: total discovered minus never_captured. Not a classification. */
  already_known: number;
  never_captured: number;
  possibly_changed: number;
  captured_partial: number;
  captured_verified: number;
  needs_review: number;
}

/**
 * Collapses raw memory_v1 rows into one verdict per conversation.
 *
 * Two conditions make a conversation ambiguous, and neither is ever resolved by guessing:
 * more than one conversation record for the same platform id, or several capture versions
 * tied on the same latest `captured_at`.
 */
export function resolveKnownRecords(
  rows: readonly KnownConversationRow[],
  expectedTitleSha256: ReadonlyMap<string, string>
): KnownConversationRecord[] {
  const grouped = new Map<string, KnownConversationRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.source_native_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.source_native_id, [row]);
  }

  const records: KnownConversationRecord[] = [];
  for (const [nativeId, group] of grouped) {
    const ambiguityReasons: string[] = [];
    if (new Set(group.map((row) => row.conversation_record_id)).size > 1) {
      ambiguityReasons.push("multiple_conversation_records");
    }

    const timestamps = group.map((row) => row.captured_at).filter((value): value is string => value !== null);
    const latest = timestamps.length > 0 ? timestamps.reduce((a, b) => (a >= b ? a : b)) : null;
    const latestRows = latest === null ? group : group.filter((row) => row.captured_at === latest);
    if (latest !== null && latestRows.length > 1) {
      const statuses = new Set(latestRows.map((row) => row.verification_status));
      // Tied timestamps only matter when they disagree about the outcome.
      if (statuses.size > 1) ambiguityReasons.push("tied_capture_versions");
    }

    const chosen = latestRows[0]!;
    const expected = expectedTitleSha256.get(nativeId);
    records.push({
      source_native_id: nativeId,
      verification_status: chosen.verification_status,
      captured_at: chosen.captured_at,
      capture_version_count: group.filter((row) => row.captured_at !== null).length,
      title_matches: expected !== undefined && chosen.title_sha256 !== null && chosen.title_sha256 === expected,
      ambiguous: ambiguityReasons.length > 0,
      ambiguity_reasons: ambiguityReasons
    });
  }
  return records;
}

export function classifyDiscoveredConversations(
  discovered: readonly DiscoveredIdentity[],
  known: readonly KnownConversationRecord[],
  context: ComparisonContext
): ClassifiedConversation[] {
  const knownByNativeId = new Map(known.map((record) => [record.source_native_id, record]));

  return discovered.map((item) => {
    const reasons: string[] = [];

    // 1. Without an established account reference, a match could belong to a different account.
    if (!context.account_established) {
      return classified(item, "needs_review", ["opaque_account_reference_not_established"]);
    }

    // 2. An identity we cannot trust is never matched against anything.
    if (item.source_native_id === null) {
      return classified(item, "needs_review", ["unstable_item_identity"]);
    }
    if (item.review_status === "needs_review") {
      reasons.push("discovery_flagged_item_for_review");
    }

    const record = knownByNativeId.get(item.source_native_id);

    // 3. No match. Absence is only a conclusion when the enumeration was verified complete.
    if (record === undefined) {
      if (context.discovery_status !== "complete") {
        return classified(item, "needs_review", [...reasons, "incomplete_discovery_cannot_conclude_absence"]);
      }
      return classified(item, reasons.length > 0 ? "needs_review" : "never_captured", [...reasons, "no_matching_source_record"]);
    }

    // 4. Ambiguous matches are never silently resolved.
    if (record.ambiguous) {
      return classified(item, "needs_review", [...reasons, ...record.ambiguity_reasons]);
    }
    if (record.verification_status === null) {
      return classified(item, "needs_review", [...reasons, "matched_without_capture_version"]);
    }
    if (record.verification_status === "failed" || record.verification_status === "needs_review") {
      return classified(item, "needs_review", [...reasons, `capture_verification_status:${record.verification_status}`]);
    }
    if (reasons.length > 0) {
      return classified(item, "needs_review", reasons);
    }

    // 5. A changed visible title means the stored capture may be stale.
    if (!record.title_matches) {
      return classified(item, "possibly_changed", ["visible_title_differs_from_captured_title"]);
    }
    if (record.verification_status === "partial") {
      return classified(item, "captured_partial", ["capture_verification_status:partial"]);
    }
    return classified(item, "captured_verified", ["capture_verification_status:complete", "visible_title_unchanged"]);
  });
}

export function summarizeComparison(classified: readonly ClassifiedConversation[]): ComparisonCounts {
  const count = (classification: ComparisonClassification): number =>
    classified.filter((item) => item.classification === classification).length;

  const neverCaptured = count("never_captured");
  return {
    total_discovered: classified.length,
    already_known: classified.length - neverCaptured,
    never_captured: neverCaptured,
    possibly_changed: count("possibly_changed"),
    captured_partial: count("captured_partial"),
    captured_verified: count("captured_verified"),
    needs_review: count("needs_review")
  };
}

export interface CapturePlanSource {
  source_kind: string;
  observed_host: string;
  adapter_id: string;
  adapter_version: string;
  opaque_account_reference: string;
}

export interface CapturePlan {
  plan_version: typeof CAPTURE_PLAN_VERSION;
  source: CapturePlanSource;
  operation: "capture_conversation";
  /** Exact platform conversation ids proposed for capture, sorted for determinism. */
  conversation_ids: string[];
  expected_item_count: number;
  estimated_volume_bytes: number | null;
  estimated_volume_basis: string;
  required_capability_tokens: string[];
  excluded: { captured_verified: number; needs_review: number };
  discovery_snapshot_sha256: string;
  created_at: string;
  /** Deterministic hash over every field above. Any change to the plan invalidates it. */
  plan_sha256: string;
}

export interface CapturePlanInput {
  source: CapturePlanSource;
  classified: readonly ClassifiedConversation[];
  discovery_snapshot_sha256: string;
  created_at: string;
  /** Bytes, when the source exposes size. The ChatGPT sidebar does not, so this stays null. */
  estimated_volume_bytes?: number | null;
  estimated_volume_basis?: string;
}

/**
 * Builds an in-memory capture plan. The plan is never executed, never written, and never
 * authorizes anything on its own: it is the artifact a human would approve later.
 */
export async function buildCapturePlan(
  input: CapturePlanInput,
  hash: (value: string) => Promise<string>
): Promise<CapturePlan> {
  const plannable = new Set<ComparisonClassification>(PLANNABLE_CLASSIFICATIONS);
  const conversationIds = input.classified
    .filter((item) => plannable.has(item.classification) && item.source_native_id !== null)
    .map((item) => item.source_native_id!)
    .sort((a, b) => a.localeCompare(b));

  const withoutHash: Omit<CapturePlan, "plan_sha256"> = {
    plan_version: CAPTURE_PLAN_VERSION,
    source: input.source,
    operation: "capture_conversation",
    conversation_ids: conversationIds,
    expected_item_count: conversationIds.length,
    estimated_volume_bytes: input.estimated_volume_bytes ?? null,
    estimated_volume_basis: input.estimated_volume_basis ?? "unavailable_from_source",
    required_capability_tokens: ["source_capture_writer"],
    excluded: {
      captured_verified: input.classified.filter((item) => item.classification === "captured_verified").length,
      needs_review: input.classified.filter((item) => item.classification === "needs_review").length
    },
    discovery_snapshot_sha256: input.discovery_snapshot_sha256,
    created_at: input.created_at
  };

  return { ...withoutHash, plan_sha256: await hash(stableJson(withoutHash)) };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function classified(
  item: DiscoveredIdentity,
  classification: ComparisonClassification,
  reasons: string[]
): ClassifiedConversation {
  return {
    item_id: item.item_id,
    source_native_id: item.source_native_id,
    title: item.title,
    classification,
    reasons
  };
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
