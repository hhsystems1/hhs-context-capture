import { describe, expect, it } from "vitest";
import {
  nextStatus, reconstructOperationReport, safeErrorSummaries, updateRecentOperationCache,
  validateAppendEvent, validateSafeMetadata, type AppendOperationEventInput, type OperationEventType
} from "./index.js";

const idempotency = "a".repeat(64);
const base = { operation_id: "operation_test_00000001", correlation_id: "correlation_test_000001" };
const at = "2026-07-23T00:00:00.000Z";

function event(event_type: OperationEventType, event_sequence: number, metadata: Record<string, string | number | boolean | null> = {}): AppendOperationEventInput {
  return { ...base, event_type, event_sequence, event_timestamp: at, source_component: "collector", metadata, idempotency_key: idempotency };
}

describe("capture operation state machine", () => {
  it("reconstructs a successful lifecycle and read-only answers", () => {
    const events = [
      event("operation_created", 1), event("identity_observed", 2), event("identity_verified", 3),
      event("capture_requested", 4), event("capture_started", 5), event("capture_progress", 6),
      event("collector_delivery_started", 7), event("collector_delivery_succeeded", 8),
      event("archive_started", 9), event("archive_completed", 10, { safe_capture_reference: "capture-safe-0001", archive_created: true }),
      event("verification_completed", 11, { verification_status: "complete" }), event("capture_completed", 12)
    ];
    const report = reconstructOperationReport({ ...base, platform: "synthetic", operation_type: "capture" }, events);
    expect(report).toMatchObject({ status: "completed", capture_started: true, identity_verified: true, collector_delivery_succeeded: true, archive_created: true, verification_finished: true, safe_capture_reference: "capture-safe-0001", stuck: false });
  });

  it.each([
    ["pairing failure", [event("operation_created", 1), event("pairing_requested", 2), event("pairing_failed", 3, { safe_error_code: "pairing_failed", safe_error_summary: safeErrorSummaries.pairing_failed })], "failed"],
    ["identity mismatch", [event("operation_created", 1), event("identity_observed", 2), event("identity_mismatch", 3, { safe_error_code: "identity_mismatch", safe_error_summary: safeErrorSummaries.identity_mismatch })], "failed"],
    ["delivery failure", [event("operation_created", 1), event("identity_observed", 2), event("capture_started", 3), event("collector_delivery_failed", 4)], "failed"],
    ["archive failure", [event("operation_created", 1), event("identity_observed", 2), event("capture_started", 3), event("collector_delivery_started", 4), event("collector_delivery_succeeded", 5), event("archive_started", 6), event("capture_failed", 7)], "failed"],
    ["needs review", [event("operation_created", 1), event("identity_observed", 2), event("capture_started", 3), event("collector_delivery_started", 4), event("collector_delivery_succeeded", 5), event("archive_started", 6), event("archive_completed", 7), event("verification_completed", 8), event("capture_needs_review", 9)], "needs_review"]
  ])("reconstructs %s", (_name, events, status) => {
    expect(reconstructOperationReport({ ...base, platform: "synthetic", operation_type: "capture" }, events as AppendOperationEventInput[]).status).toBe(status);
  });

  it("rejects invalid, out-of-order, and terminal mutations", () => {
    expect(() => nextStatus("created", "capture_completed")).toThrow(/Invalid/);
    expect(() => nextStatus("completed", "capture_progress")).toThrow(/Terminal/);
    expect(() => reconstructOperationReport({ ...base, platform: "synthetic", operation_type: "capture" }, [event("operation_created", 1), event("identity_observed", 3)])).toThrow(/contiguous/);
  });
});

describe("privacy and restart-safe cache", () => {
  it("rejects unknown, nested, path, URL, and sensitive fields", () => {
    expect(() => validateSafeMetadata({ transcript: "private" })).toThrow(/prohibited/);
    expect(() => validateSafeMetadata({ stage: { nested: true } })).toThrow(/scalar/);
    expect(() => validateSafeMetadata({ stage: "C:\\private\\archive" })).toThrow(/path/);
    expect(() => validateSafeMetadata({ stage: "https://example.invalid/?secret=x" })).toThrow(/URL/);
    expect(() => validateSafeMetadata({ safe_error_summary: "raw error" })).toThrow(/requires/);
  });

  it("validates deterministic event fields and survives popup/worker restart reconstruction", () => {
    expect(validateAppendEvent(event("operation_created", 1, { stage: "created" }))).toEqual({ stage: "created" });
    const report = reconstructOperationReport({ ...base, platform: "synthetic", operation_type: "capture" }, [event("operation_created", 1)]);
    const stored = JSON.parse(JSON.stringify(updateRecentOperationCache(undefined, report)));
    expect(updateRecentOperationCache(stored, report).operations).toHaveLength(1);
    expect(stored.operations[0]?.operation_id).toBe(base.operation_id);
  });
});
