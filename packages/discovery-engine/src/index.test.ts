import { describe, expect, it, vi } from "vitest";
import { isVerifiedCompleteDiscovery, validateDiscoveryIntegrity } from "@hhs/discovery-schema";
import { FakeSourceAdapter, fakeContext, nodeSha256, type FakeSourceOptions } from "../test/fixtures/fake-source.js";
import { runDiscovery } from "./index.js";

// Any attempt by the engine to touch the filesystem fails the suite outright.
vi.mock("node:fs/promises", () => ({
  writeFile: () => { throw new Error("discovery engine attempted a filesystem write"); },
  mkdir: () => { throw new Error("discovery engine attempted a filesystem write"); },
  rename: () => { throw new Error("discovery engine attempted a filesystem write"); },
  appendFile: () => { throw new Error("discovery engine attempted a filesystem write"); }
}));

const baseOptions: FakeSourceOptions = {
  containers: [
    { id: "root", title: "All items" },
    { id: "project-a", title: "Project A" }
  ],
  items: [
    { id: "item-1", containerRef: "root", title: "First" },
    { id: "item-2", containerRef: "root", title: "Second" },
    { id: "item-3", containerRef: "root", title: "Third" },
    { id: "item-4", containerRef: "project-a", title: "Fourth" },
    { id: "item-5", containerRef: "project-a", title: "Fifth" },
    { id: "item-6", containerRef: "project-a", title: "Sixth" }
  ]
};

function run(options: FakeSourceOptions = baseOptions) {
  return runDiscovery(new FakeSourceAdapter(options), fakeContext(), {
    opaqueAccountReference: "opaque-account-test",
    hash: nodeSha256,
    now: () => "2026-08-12T12:00:00.000Z"
  });
}

describe("site-agnostic discovery engine", () => {
  it("drives a source with no DOM, no network, and no filesystem", async () => {
    const result = await run();

    // Every item survived virtualization even though only a window was ever visible.
    expect(result.items).toHaveLength(6);
    expect(result.containers).toHaveLength(2);
    expect(result.source.source_kind).toBe("fake-source");
    expect(result.source.transport).toBe("http_api");
    expect(result.items.map((item) => item.source_native_id)).toEqual([
      "item-1", "item-2", "item-3", "item-4", "item-5", "item-6"
    ]);
  });

  it("produces a run that passes full contract integrity validation", async () => {
    const result = await run();

    // This also proves the engine's fingerprint payloads match the schema package's definitions.
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
    expect(result.status).toBe("complete");
    expect(isVerifiedCompleteDiscovery(result)).toBe(true);
  });

  it("assigns items to the container the source declared", async () => {
    const result = await run();
    const byId = new Map(result.containers.map((container) => [container.container_id, container]));
    const counts = result.items.reduce<Record<string, number>>((totals, item) => {
      const title = byId.get(item.container_id)!.title;
      totals[title] = (totals[title] ?? 0) + 1;
      return totals;
    }, {});

    expect(counts).toEqual({ "All items": 3, "Project A": 3 });
    expect(result.containers.map((container) => container.observed_item_count)).toEqual([3, 3]);
  });

  it("performs zero writes during a dry run", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const xhrSpy = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhrSpy);
    const sendBeaconSpy = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon: sendBeaconSpy });

    try {
      const result = await run();
      expect(result.items).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });

  it("refuses to claim 'complete' when the end boundary is never verified", async () => {
    const result = await run({ ...baseOptions, growingExtent: true });

    expect(result.boundary_verification.enumeration_end_reached).toBe(false);
    expect(result.warnings).toContain("enumeration_end_boundary_not_verified");
    expect(result.status).toBe("needs_review");
    expect(isVerifiedCompleteDiscovery(result)).toBe(false);
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
  });

  it("refuses to claim 'complete' when the initial state cannot be restored", async () => {
    const port = { ...baseOptions, refuseRestore: true };
    const result = await runDiscovery(new FakeSourceAdapter(port), fakeContext(), {
      opaqueAccountReference: "opaque-account-test",
      hash: nodeSha256,
      now: () => "2026-08-12T12:00:00.000Z"
    });

    // The traversal still enumerated everything, but the run reports the unrestored state honestly.
    expect(result.items).toHaveLength(6);
    expect(result.status).not.toBe("complete");
  });

  it("marks a container partial when fewer items were seen than the source declared", async () => {
    const result = await run({
      containers: [
        { id: "root", title: "All items" },
        { id: "project-a", title: "Project A", declaredItemCount: 5 }
      ],
      items: [
        { id: "item-1", containerRef: "root", title: "First" },
        { id: "item-2", containerRef: "project-a", title: "Second" }
      ]
    });

    const project = result.containers.find((container) => container.title === "Project A")!;
    expect(project.enumeration_status).toBe("partial");
    expect(project.declared_item_count).toBe(5);
    expect(project.observed_item_count).toBe(1);
    expect(project.review_reasons).toContain("declared_item_count_mismatch:5:1");
    expect(result.status).toBe("partial");
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
  });

  it("records an unresolved container reference instead of silently reassigning the item", async () => {
    const result = await run({
      containers: [{ id: "root", title: "All items" }],
      items: [
        { id: "item-1", containerRef: "root", title: "First" },
        { id: "item-2", containerRef: "ghost", title: "Orphan" }
      ]
    });

    expect(result.warnings).toContain("unresolved_container_reference:ghost");
    const orphan = result.items.find((item) => item.title === "Orphan")!;
    expect(orphan.review_status).toBe("needs_review");
    expect(orphan.review_reasons).toContain("unresolved_container_reference");
    const synthetic = result.containers.find((container) => container.container_kind === "unresolved_container")!;
    expect(synthetic.enumeration_status).toBe("partial");
    expect(validateDiscoveryIntegrity(result)).toEqual([]);
  });

  it("flags rows that expose no stable identity", async () => {
    const result = await run({
      containers: [{ id: "root", title: "All items" }],
      items: [{ id: "item-1", containerRef: "root", title: "First", unstableIdentity: true }]
    });

    const item = result.items[0]!;
    expect(item.source_native_id).toBeUndefined();
    expect(item.review_reasons).toContain("unstable_item_identity");
    expect(item.review_status).toBe("needs_review");
  });

  it("flags conflicting observations for one stable identity", async () => {
    const result = await run({ ...baseOptions, unstableTitles: true });

    expect(result.warnings.some((warning) => warning.startsWith("identity_collisions:"))).toBe(true);
    expect(result.status).toBe("needs_review");
  });

  it("carries the adapter capability declaration onto the run", async () => {
    const result = await run();

    expect(result.capabilities.versions).toBe("unsupported");
    expect(result.capabilities.attachments).toBe("unknown");
    expect(result.capabilities.items).toBe("supported");
  });

  it("computes a stable snapshot hash for identical observations", async () => {
    const first = await run();
    const second = await run();

    expect(first.snapshot_sha256).toBe(second.snapshot_sha256);
  });
});
