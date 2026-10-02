import { describe, expect, it } from "vitest";
import {
  CAPTURE_PLAN_VERSION,
  buildCapturePlan,
  classifyDiscoveredConversations,
  resolveKnownRecords,
  summarizeComparison
} from "./index.js";
import {
  CAPTURED_AT,
  context,
  discovered,
  expectedTitles,
  knownRecord,
  knownRow,
  nodeSha256,
  titleSha256
} from "../test/fixtures/synthetic-comparison.js";

const source = {
  source_kind: "chatgpt",
  observed_host: "chatgpt.com",
  adapter_id: "chatgpt-sidebar-discovery",
  adapter_version: "0.1.0",
  opaque_account_reference: "account-opaque-fixture"
};

function classifyOne(item: Parameters<typeof discovered>[0] extends never ? never : ReturnType<typeof discovered>, known: ReturnType<typeof knownRecord>[], ctx = context()) {
  return classifyDiscoveredConversations([item], known, ctx)[0]!;
}

describe("discovered conversation classification", () => {
  it("classifies an unmatched conversation as never_captured after a complete discovery", () => {
    const result = classifyOne(discovered("conv-1"), []);

    expect(result.classification).toBe("never_captured");
    expect(result.reasons).toContain("no_matching_source_record");
  });

  it("classifies a verified, unchanged match as captured_verified", () => {
    const result = classifyOne(discovered("conv-1"), [knownRecord("conv-1")]);

    expect(result.classification).toBe("captured_verified");
  });

  it("classifies a partial capture as captured_partial", () => {
    const result = classifyOne(discovered("conv-1"), [knownRecord("conv-1", { verification_status: "partial" })]);

    expect(result.classification).toBe("captured_partial");
  });

  it("classifies a changed visible title as possibly_changed", () => {
    const result = classifyOne(discovered("conv-1"), [knownRecord("conv-1", { title_matches: false })]);

    expect(result.classification).toBe("possibly_changed");
    expect(result.reasons).toContain("visible_title_differs_from_captured_title");
  });

  it("ranks a changed title above a partial capture", () => {
    const result = classifyOne(discovered("conv-1"), [
      knownRecord("conv-1", { verification_status: "partial", title_matches: false })
    ]);

    // The state implying the most outstanding work wins.
    expect(result.classification).toBe("possibly_changed");
  });

  it("routes failed and needs_review capture statuses to needs_review", () => {
    for (const status of ["failed", "needs_review"] as const) {
      const result = classifyOne(discovered("conv-1"), [knownRecord("conv-1", { verification_status: status })]);
      expect(result.classification).toBe("needs_review");
      expect(result.reasons).toContain(`capture_verification_status:${status}`);
    }
  });

  it("never concludes absence from an incomplete discovery", () => {
    for (const status of ["partial", "needs_review"] as const) {
      const result = classifyOne(discovered("conv-1"), [], context({ discovery_status: status }));
      expect(result.classification).toBe("needs_review");
      expect(result.reasons).toContain("incomplete_discovery_cannot_conclude_absence");
    }
  });

  it("never matches when the opaque account reference is not established", () => {
    const result = classifyOne(discovered("conv-1"), [knownRecord("conv-1")], context({ account_established: false }));

    expect(result.classification).toBe("needs_review");
    expect(result.reasons).toEqual(["opaque_account_reference_not_established"]);
  });

  it("never matches an item with an unstable identity", () => {
    const result = classifyOne(discovered(null), [knownRecord("conv-1")]);

    expect(result.classification).toBe("needs_review");
    expect(result.reasons).toContain("unstable_item_identity");
  });

  it("carries a discovery review flag into needs_review", () => {
    const result = classifyOne(discovered("conv-1", "Conversation conv-1", "needs_review"), [knownRecord("conv-1")]);

    expect(result.classification).toBe("needs_review");
    expect(result.reasons).toContain("discovery_flagged_item_for_review");
  });

  it("routes ambiguous matches to needs_review without choosing a candidate", () => {
    const result = classifyOne(discovered("conv-1"), [
      knownRecord("conv-1", { ambiguous: true, ambiguity_reasons: ["multiple_conversation_records"] })
    ]);

    expect(result.classification).toBe("needs_review");
    expect(result.reasons).toContain("multiple_conversation_records");
  });

  it("routes a match with no capture version to needs_review", () => {
    const result = classifyOne(discovered("conv-1"), [
      knownRecord("conv-1", { verification_status: null, captured_at: null })
    ]);

    expect(result.classification).toBe("needs_review");
    expect(result.reasons).toContain("matched_without_capture_version");
  });
});

describe("known record resolution", () => {
  it("collapses multiple capture versions to the latest", () => {
    const [record] = resolveKnownRecords([
      knownRow("conv-1", { captured_at: "2026-07-01T00:00:00.000Z", verification_status: "partial" }),
      knownRow("conv-1", { captured_at: CAPTURED_AT, verification_status: "complete" })
    ], expectedTitles("conv-1"));

    expect(record!.verification_status).toBe("complete");
    expect(record!.captured_at).toBe(CAPTURED_AT);
    expect(record!.capture_version_count).toBe(2);
    expect(record!.ambiguous).toBe(false);
  });

  it("marks multiple conversation records for one platform id as ambiguous", () => {
    const [record] = resolveKnownRecords([
      knownRow("conv-1", { conversation_record_id: "conversation-a" }),
      knownRow("conv-1", { conversation_record_id: "conversation-b" })
    ], expectedTitles("conv-1"));

    expect(record!.ambiguous).toBe(true);
    expect(record!.ambiguity_reasons).toContain("multiple_conversation_records");
  });

  it("marks disagreeing tied capture versions as ambiguous", () => {
    const [record] = resolveKnownRecords([
      knownRow("conv-1", { verification_status: "complete" }),
      knownRow("conv-1", { verification_status: "partial" })
    ], expectedTitles("conv-1"));

    expect(record!.ambiguous).toBe(true);
    expect(record!.ambiguity_reasons).toContain("tied_capture_versions");
  });

  it("detects a title change by hash without comparing titles directly", () => {
    const [record] = resolveKnownRecords(
      [knownRow("conv-1", { title_sha256: titleSha256("A different title") })],
      expectedTitles("conv-1")
    );

    expect(record!.title_matches).toBe(false);
  });

  it("treats a missing stored title hash as a non-match", () => {
    const [record] = resolveKnownRecords([knownRow("conv-1", { title_sha256: null })], expectedTitles("conv-1"));

    expect(record!.title_matches).toBe(false);
  });
});

describe("comparison counts", () => {
  it("reports already_known as a rollup of everything except never_captured", () => {
    const classified = classifyDiscoveredConversations(
      [discovered("a"), discovered("b"), discovered("c"), discovered("d"), discovered(null)],
      [
        knownRecord("a"),
        knownRecord("b", { verification_status: "partial" }),
        knownRecord("c", { title_matches: false })
      ],
      context()
    );
    const counts = summarizeComparison(classified);

    expect(counts).toEqual({
      total_discovered: 5,
      already_known: 4,
      never_captured: 1,
      possibly_changed: 1,
      captured_partial: 1,
      captured_verified: 1,
      needs_review: 1
    });
    // The five primary states always sum to the total.
    expect(counts.never_captured + counts.possibly_changed + counts.captured_partial + counts.captured_verified + counts.needs_review)
      .toBe(counts.total_discovered);
  });
});

describe("capture plan", () => {
  const classified = () => classifyDiscoveredConversations(
    [discovered("a"), discovered("b"), discovered("c"), discovered("d"), discovered(null)],
    [
      knownRecord("a"),
      knownRecord("b", { verification_status: "partial" }),
      knownRecord("c", { title_matches: false })
    ],
    context()
  );

  it("proposes only plannable conversations and excludes verified and needs_review", async () => {
    const plan = await buildCapturePlan({
      source,
      classified: classified(),
      discovery_snapshot_sha256: "a".repeat(64),
      created_at: "2026-08-12T12:00:00.000Z"
    }, nodeSha256);

    expect(plan.conversation_ids).toEqual(["b", "c", "d"]);
    expect(plan.expected_item_count).toBe(3);
    expect(plan.excluded).toEqual({ captured_verified: 1, needs_review: 1 });
    expect(plan.operation).toBe("capture_conversation");
    expect(plan.plan_version).toBe(CAPTURE_PLAN_VERSION);
    expect(plan.required_capability_tokens).toEqual(["source_capture_writer"]);
    expect(plan.estimated_volume_bytes).toBeNull();
    expect(plan.estimated_volume_basis).toBe("unavailable_from_source");
  });

  it("never includes an ambiguous or unstable identity", async () => {
    const plan = await buildCapturePlan({
      source,
      classified: classifyDiscoveredConversations(
        [discovered(null), discovered("x")],
        [knownRecord("x", { ambiguous: true, ambiguity_reasons: ["multiple_conversation_records"] })],
        context()
      ),
      discovery_snapshot_sha256: "a".repeat(64),
      created_at: "2026-08-12T12:00:00.000Z"
    }, nodeSha256);

    expect(plan.conversation_ids).toEqual([]);
    expect(plan.expected_item_count).toBe(0);
  });

  it("produces a deterministic hash for an identical plan", async () => {
    const input = {
      source,
      classified: classified(),
      discovery_snapshot_sha256: "a".repeat(64),
      created_at: "2026-08-12T12:00:00.000Z"
    };
    const first = await buildCapturePlan(input, nodeSha256);
    const second = await buildCapturePlan(input, nodeSha256);

    expect(first.plan_sha256).toBe(second.plan_sha256);
    expect(first.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when any part of the plan changes", async () => {
    const base = {
      source,
      classified: classified(),
      discovery_snapshot_sha256: "a".repeat(64),
      created_at: "2026-08-12T12:00:00.000Z"
    };
    const original = await buildCapturePlan(base, nodeSha256);

    const differentItems = await buildCapturePlan({
      ...base,
      classified: classifyDiscoveredConversations([discovered("a")], [], context())
    }, nodeSha256);
    const differentSnapshot = await buildCapturePlan({ ...base, discovery_snapshot_sha256: "b".repeat(64) }, nodeSha256);
    const differentAccount = await buildCapturePlan({
      ...base,
      source: { ...source, opaque_account_reference: "account-opaque-other" }
    }, nodeSha256);

    for (const changed of [differentItems, differentSnapshot, differentAccount]) {
      expect(changed.plan_sha256).not.toBe(original.plan_sha256);
    }
  });
});
