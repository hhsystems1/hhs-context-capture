import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareCaptureVersions } from "@hhs/capture-comparison";
import { syntheticCapture } from "../../capture-comparison/test/fixtures/synthetic-captures.js";
import { FileReviewQueue } from "./index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("private local review queue", () => {
  it("idempotently queues every uncertain comparison record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-review-")); roots.push(root);
    const queue = new FileReviewQueue(root); await queue.initialize();
    const prior = syntheticCapture("prior", [{ id: "old-1", platformId: null, role: "assistant", text: "Repeated", sequence: 0 }, { id: "old-2", platformId: null, role: "assistant", text: "Repeated", sequence: 1 }]);
    const current = syntheticCapture("current", [{ id: "new-1", platformId: null, role: "assistant", text: "Repeated", sequence: 0 }]);
    const comparison = compareCaptureVersions(prior, current);
    const context = { platform_id: "synthetic-ai", opaque_account_reference: "opaque-account-fixture", conversation_id: "conversation-1", created_at: "2026-07-18T00:00:00.000Z" };
    const first = await queue.enqueueComparison(comparison, context);
    const repeated = await queue.enqueueComparison(comparison, context);
    expect(first.length).toBeGreaterThan(0);
    expect(repeated.map((item) => item.review_id)).toEqual(first.map((item) => item.review_id));
    expect(Object.keys((await queue.read()).items)).toHaveLength(first.length);
  });

  it("transactionally and idempotently queues independent capture verification failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-review-")); roots.push(root);
    const queue = new FileReviewQueue(root); await queue.initialize();
    const transaction = {
      transaction_id: "capture-review-1",
      platform_id: "synthetic-ai",
      opaque_account_reference: "opaque-account-fixture",
      created_at: "2026-07-18T00:00:00.000Z",
      items: [
        { capture_id: "capture-a", conversation_id: "conversation-1", reason_codes: ["boundary.earliest"], evidence_hashes: ["a".repeat(64)] },
        { capture_id: "capture-b", conversation_id: "conversation-1", reason_codes: ["branches.complete"], evidence_hashes: ["b".repeat(64)] }
      ]
    };
    const first = await queue.enqueueCaptureVerifications(transaction);
    const replay = await queue.enqueueCaptureVerifications(transaction);
    const state = await queue.read();
    expect(first).toMatchObject({ applied: true, revision: 2 });
    expect(replay).toMatchObject({ applied: false, revision: 2 });
    expect(Object.values(state.items).map((item) => item.capture_id).sort()).toEqual(["capture-a", "capture-b"]);
    expect(new Set(Object.values(state.items).map((item) => item.review_id)).size).toBe(2);
  });
});
