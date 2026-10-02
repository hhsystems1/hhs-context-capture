import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateInventoryIntegrity } from "@hhs/inventory-schema";
import { SyntheticVirtualizedSidebar, syntheticSidebarItems } from "../test/fixtures/synthetic-sidebar.js";
import { ChatGptSidebarInventoryAdapter, hashInventoryEvidence } from "./inventory-adapter.js";

describe("ChatGPT read-only sidebar inventory", () => {
  it("accumulates a virtualized sidebar, verifies both boundaries, hashes evidence, and restores position", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(25), 7);
    const inventory = await new ChatGptSidebarInventoryAdapter().inventory(port, "account-opaque-fixture", () => undefined, { stable_boundary_passes: 2 });
    await hashInventoryEvidence(inventory);

    expect(inventory.status).toBe("complete");
    expect(inventory.observations).toHaveLength(25);
    expect(inventory.observations[0]?.conversation_id).toBe("conversation-001");
    expect(inventory.observations.at(-1)?.conversation_id).toBe("conversation-025");
    expect(inventory.boundary_verification).toMatchObject({ earliest_reached: true, latest_reached: true, scroll_stabilized: true, observation_count_stabilized: true, initial_position_restored: true });
    expect(port.scrollTop).toBe(700);
    expect(inventory.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    expect(validateInventoryIntegrity(inventory)).toEqual([]);
  });

  it("does not interpret repeated virtualization observations as duplicate conversations", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(8), 2);
    const inventory = await new ChatGptSidebarInventoryAdapter().inventory(port, "account-opaque-fixture", () => undefined, { stable_boundary_passes: 2 });
    await hashInventoryEvidence(inventory);
    expect(inventory.observations).toHaveLength(8);
    expect(inventory.warnings.some((item) => item.startsWith("conversation_identity_collisions"))).toBe(false);
  });

  it("marks conflicting stable identities as needs_review", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(10));
    port.conflictingIdentity = "conversation-004";
    const inventory = await new ChatGptSidebarInventoryAdapter().inventory(port, "account-opaque-fixture", () => undefined, { stable_boundary_passes: 2 });
    await hashInventoryEvidence(inventory);
    expect(inventory.status).toBe("needs_review");
    expect(inventory.warnings.some((item) => item.startsWith("conversation_identity_collisions"))).toBe(true);
    expect(inventory.observations.find((item) => item.conversation_id === "conversation-004")?.review_status).toBe("needs_review");
  });

  it("prohibits complete status when scrolling cannot reach boundaries", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(20), 5);
    port.movementBlocked = true;
    const inventory = await new ChatGptSidebarInventoryAdapter().inventory(port, "account-opaque-fixture", () => undefined, { max_scroll_passes: 5, stable_boundary_passes: 2 });
    await hashInventoryEvidence(inventory);
    expect(inventory.status).toBe("needs_review");
    expect(inventory.boundary_verification.latest_reached).toBe(false);
    expect(inventory.boundary_verification.earliest_reached).toBe(false);
    expect(inventory.warnings).toEqual(expect.arrayContaining(["latest_sidebar_boundary_not_reached", "earliest_sidebar_boundary_not_verified"]));
  });

  it("reports restoration uncertainty instead of silently completing", async () => {
    const port = new SyntheticVirtualizedSidebar(syntheticSidebarItems(15), 4);
    port.restoreBlocked = true;
    const inventory = await new ChatGptSidebarInventoryAdapter().inventory(port, "account-opaque-fixture", () => undefined, { stable_boundary_passes: 2 });
    await hashInventoryEvidence(inventory);
    expect(inventory.status).toBe("needs_review");
    expect(inventory.boundary_verification.initial_position_restored).toBe(false);
    expect(inventory.warnings).toContain("initial_sidebar_position_not_restored");
  });

  it("contains no click operation in the inventory adapter implementation", async () => {
    const sourcePath = fileURLToPath(new URL("./inventory-adapter.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");
    expect(source).not.toMatch(/\.click\s*\(/);
  });
});
