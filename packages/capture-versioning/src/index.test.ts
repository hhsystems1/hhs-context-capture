import { describe, expect, it } from "vitest";
import { baseMessages, syntheticCapture } from "../../capture-comparison/test/fixtures/synthetic-captures.js";
import { createImmutableCaptureVersion, planCaptureReconciliation, toCaptureReference, verifyCaptureVersion } from "./index.js";

describe("immutable capture version contracts", () => {
  it("creates deterministic hash-valid message and capture summaries", () => {
    const bundle = syntheticCapture("capture-1", baseMessages());
    const version = createImmutableCaptureVersion(bundle, "C:\\synthetic\\capture-1", "a".repeat(64));
    expect(verifyCaptureVersion(version)).toBe(true);
    expect(version.messages).toHaveLength(2);
    expect(Object.keys(version.message_hashes)).toEqual(["u1", "a1"]);
  });

  it("never replaces a conflicting immutable reference during reconciliation planning", () => {
    const version = createImmutableCaptureVersion(syntheticCapture("capture-1", baseMessages()), "C:\\synthetic\\capture-1", "a".repeat(64));
    const existing = [{ ...toCaptureReference(version), archive_path: "C:\\different" }];
    const decisions = planCaptureReconciliation(existing, [{ version, source_archive_path: version.archive_path, source_hashes_verified: true }]);
    expect(decisions[0]).toMatchObject({ disposition: "needs_review", reasons: ["immutable_capture_reference_conflict"] });
  });

  it("treats a legacy full-version catalog object as the same canonical reference", () => {
    const version = createImmutableCaptureVersion(syntheticCapture("capture-1", baseMessages()), "C:\\synthetic\\capture-1", "a".repeat(64));
    const decisions = planCaptureReconciliation([version], [{ version, source_archive_path: version.archive_path, source_hashes_verified: true }]);
    expect(decisions[0]).toMatchObject({ disposition: "already_present", reasons: [] });
    expect(Object.keys(decisions[0]!.reference).sort()).toEqual(["archive_path", "capture_id", "captured_at", "conversation_id", "manifest_sha256", "message_count", "message_hashes", "status"]);
  });
});
