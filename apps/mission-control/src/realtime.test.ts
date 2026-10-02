import { describe, expect, it } from "vitest";
import { SnapshotFeed } from "./realtime.js";

describe("Mission Control real-time feed", () => {
  it("publishes changed synthetic states and suppresses exact duplicates", () => {
    const feed = new SnapshotFeed();
    const ready = { generated_at: "2026-01-01T00:00:00.000Z", system: { collector: { state: "ready" } } };
    const degraded = { generated_at: "2026-01-01T00:00:05.000Z", system: { collector: { state: "degraded" } } };
    expect(feed.next(ready)).toContain('"state":"ready"');
    expect(feed.next(ready)).toBeNull();
    expect(feed.next(degraded)).toContain('"state":"degraded"');
  });
});
