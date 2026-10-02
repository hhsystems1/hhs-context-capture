import { createHash } from "node:crypto";
import type {
  ComparisonContext,
  DiscoveredIdentity,
  KnownConversationRecord,
  KnownConversationRow
} from "../../src/index.js";

export const CAPTURED_AT = "2026-08-01T12:00:00.000Z";

export function nodeSha256(value: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(value, "utf8").digest("hex"));
}

export function titleSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function discovered(
  nativeId: string | null,
  title = `Conversation ${nativeId ?? "unknown"}`,
  reviewStatus: DiscoveredIdentity["review_status"] = "clear"
): DiscoveredIdentity {
  return {
    item_id: `item-${nativeId ?? "unstable"}`,
    source_native_id: nativeId,
    title,
    review_status: reviewStatus
  };
}

export function knownRecord(
  nativeId: string,
  overrides: Partial<KnownConversationRecord> = {}
): KnownConversationRecord {
  return {
    source_native_id: nativeId,
    verification_status: "complete",
    captured_at: CAPTURED_AT,
    capture_version_count: 1,
    title_matches: true,
    ambiguous: false,
    ambiguity_reasons: [],
    ...overrides
  };
}

export function knownRow(
  nativeId: string,
  overrides: Partial<KnownConversationRow> = {}
): KnownConversationRow {
  return {
    source_native_id: nativeId,
    conversation_record_id: `conversation-${nativeId}`,
    verification_status: "complete",
    captured_at: CAPTURED_AT,
    title_sha256: titleSha256(`Conversation ${nativeId}`),
    ...overrides
  };
}

export function context(overrides: Partial<ComparisonContext> = {}): ComparisonContext {
  return { discovery_status: "complete", account_established: true, ...overrides };
}

export function expectedTitles(...nativeIds: string[]): Map<string, string> {
  return new Map(nativeIds.map((nativeId) => [nativeId, titleSha256(`Conversation ${nativeId}`)]));
}
