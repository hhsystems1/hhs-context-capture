import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ImmutableCaptureReference } from "@hhs/inventory-schema";
import { syntheticInventory, syntheticObservation } from "../../inventory-schema/test/fixtures/synthetic-inventory.js";
import { FileCatalog } from "./index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent conversation catalog", () => {
  it("classifies complete inventories conservatively and never deletes missing records", async () => {
    const catalog = await createCatalog();
    const first = syntheticInventory("inventory-1", [
      syntheticObservation("alpha", "Alpha", 0),
      syntheticObservation("beta", "Beta", 1),
      syntheticObservation("gamma", "Gamma", 2)
    ]);
    const firstResult = await catalog.applyInventory(first, [capture("alpha")]);
    expect(firstResult.classifications).toMatchObject({ alpha: "new", beta: "new", gamma: "new" });

    const second = syntheticInventory("inventory-2", [
      syntheticObservation("alpha", "Alpha", 0),
      syntheticObservation("beta", "Beta changed visibly", 1),
      syntheticObservation("delta", "Delta", 2)
    ]);
    const secondResult = await catalog.applyInventory(second);
    expect(secondResult.classifications).toEqual({
      alpha: "unchanged",
      beta: "possibly_changed",
      delta: "new",
      gamma: "missing"
    });

    const state = await catalog.read();
    const gamma = Object.values(state.conversations).find((item) => item.conversation_id === "gamma");
    expect(gamma?.classification.reason_codes).toContain("retained_not_deleted");
    expect(Object.values(state.conversations)).toHaveLength(4);
  });

  it("does not infer missing or unchanged from an incomplete inventory", async () => {
    const catalog = await createCatalog();
    await catalog.applyInventory(syntheticInventory("inventory-complete", [
      syntheticObservation("alpha", "Alpha", 0),
      syntheticObservation("beta", "Beta", 1)
    ]), [capture("alpha")]);

    const partial = syntheticInventory("inventory-partial", [syntheticObservation("alpha", "Alpha", 0)], "partial");
    const result = await catalog.applyInventory(partial);
    expect(result.classifications).toEqual({ alpha: "needs_review" });

    const state = await catalog.read();
    const beta = Object.values(state.conversations).find((item) => item.conversation_id === "beta");
    expect(beta?.classification.classification).toBe("new");
    expect(beta?.last_inventory_id).toBe("inventory-complete");
  });

  it("is idempotent and rejects mutation of an immutable capture reference", async () => {
    const catalog = await createCatalog();
    const inventory = syntheticInventory("inventory-idempotent", [syntheticObservation("alpha", "Alpha", 0)]);
    const reference = capture("alpha");
    const first = await catalog.applyInventory(inventory, [reference]);
    const repeated = await catalog.applyInventory(inventory, [reference]);

    expect(first.applied).toBe(true);
    expect(repeated.applied).toBe(false);
    expect(repeated.revision).toBe(first.revision);

    const conflictingInventory = syntheticInventory("inventory-conflict", [syntheticObservation("alpha", "Alpha", 0)]);
    await expect(catalog.applyInventory(conflictingInventory, [{ ...reference, archive_path: "C:\\immutable\\changed" }])).rejects.toThrow("Immutable capture reference conflict");
  });

  it("replays a hash-verified transaction journal after snapshot loss", async () => {
    const root = await temporaryRoot();
    const catalog = new FileCatalog(root);
    await catalog.initialize();
    const inventory = syntheticInventory("inventory-resume", [syntheticObservation("alpha", "Alpha", 0)]);
    await catalog.applyInventory(inventory);
    await rm(path.join(root, "catalog.json"));

    const resumed = new FileCatalog(root);
    await resumed.initialize();
    const state = await resumed.read();
    expect(state.revision).toBe(1);
    expect(state.inventories["inventory-resume"]?.snapshot_sha256).toBe(inventory.snapshot_sha256);
    expect(Object.values(state.conversations).map((item) => item.conversation_id)).toEqual(["alpha"]);

    const journalName = (await import("node:fs/promises")).readdir(path.join(root, "transactions"));
    const journal = JSON.parse(await readFile(path.join(root, "transactions", (await journalName)[0]!), "utf8"));
    expect(journal.inventory.evidence[0].sha256).toBe(inventory.evidence[0]?.sha256);
    expect(journal.transaction_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recovers a stale process lock before replaying transactions", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, ".catalog.lock"), JSON.stringify({ pid: -1, acquired_at: "2026-07-17T00:00:00.000Z" }));
    const catalog = new FileCatalog(root);
    await catalog.initialize();
    const state = await catalog.read();
    expect(state.revision).toBe(0);
  });

  it("routes observation uncertainty to needs_review", async () => {
    const catalog = await createCatalog();
    const inventory = syntheticInventory("inventory-review", [syntheticObservation("ambiguous", "Duplicate title", 0, ["stable_identity_unavailable"])]);
    const result = await catalog.applyInventory(inventory);
    expect(result.classifications.ambiguous).toBe("needs_review");
  });

  it("persists a catalog snapshot conforming to the formal JSON Schema", async () => {
    const catalog = await createCatalog();
    await catalog.applyInventory(syntheticInventory("inventory-schema", [syntheticObservation("alpha", "Alpha", 0)]), [capture("alpha")]);
    const schemaPath = fileURLToPath(new URL("../schemas/catalog-state.schema.json", import.meta.url));
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const validate = new Ajv2020Module.default({ strict: true }).compile(schema);
    const state = await catalog.read();
    expect(validate(state), JSON.stringify(validate.errors)).toBe(true);
  });

  it("transactionally reconciles immutable capture references without replacing history", async () => {
    const catalog = await createCatalog();
    await catalog.applyInventory(syntheticInventory("inventory-reconcile", [syntheticObservation("alpha", "Alpha", 0)]));
    const reference = capture("alpha");
    const input = { reconciliation_id: "reconcile-1", platform_id: "synthetic-ai", opaque_account_reference: "opaque-account-fixture-001", created_at: "2026-07-18T00:00:00.000Z", capture_references: [reference, capture("unmatched")] };
    const first = await catalog.reconcileCaptureReferences(input);
    const repeated = await catalog.reconcileCaptureReferences(input);
    expect(first).toMatchObject({ applied: true, added_capture_ids: ["capture-alpha"], unmatched_capture_ids: ["capture-unmatched"] });
    expect(repeated.applied).toBe(false);
    const alpha = Object.values((await catalog.read()).conversations).find((item) => item.conversation_id === "alpha");
    expect(alpha?.capture_versions.map((item) => item.capture_id)).toEqual(["capture-alpha"]);
  });

  it("canonicalizes legacy extended references in snapshots without rewriting their journal", async () => {
    const root = await temporaryRoot();
    const catalog = new FileCatalog(root); await catalog.initialize();
    await catalog.applyInventory(syntheticInventory("inventory-legacy", [syntheticObservation("alpha", "Alpha", 0)]));
    const legacy = { ...capture("alpha"), legacy_version_sha256: "d".repeat(64), messages: [{ legacy: true }] } as unknown as ImmutableCaptureReference;
    await catalog.reconcileCaptureReferences({ reconciliation_id: "legacy-reference", platform_id: "synthetic-ai", opaque_account_reference: "opaque-account-fixture-001", created_at: "2026-07-18T00:00:00.000Z", capture_references: [legacy] });
    const state = await catalog.read();
    const stored = Object.values(state.conversations).find((item) => item.conversation_id === "alpha")?.capture_versions[0];
    expect(Object.keys(stored ?? {}).sort()).toEqual(["archive_path", "capture_id", "captured_at", "conversation_id", "manifest_sha256", "message_count", "message_hashes", "status"]);
    const transactionNames = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, "transactions")));
    const journal = await Promise.all(transactionNames.map(async (name) => JSON.parse(await readFile(path.join(root, "transactions", name), "utf8"))));
    const legacyJournal = journal.find((item) => item.reconciliation_id === "legacy-reference");
    expect(legacyJournal.capture_references[0].legacy_version_sha256).toBe("d".repeat(64));
  });
});

async function createCatalog(): Promise<FileCatalog> {
  const catalog = new FileCatalog(await temporaryRoot());
  await catalog.initialize();
  return catalog;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hhs-catalog-test-"));
  temporaryRoots.push(root);
  return root;
}

function capture(conversationId: string): ImmutableCaptureReference {
  return {
    capture_id: `capture-${conversationId}`,
    conversation_id: conversationId,
    archive_path: `C:\\synthetic-archive\\${conversationId}\\capture-1`,
    manifest_sha256: "a".repeat(64),
    captured_at: "2026-07-17T11:00:00.000Z",
    status: "complete",
    message_count: 2,
    message_hashes: { "message-1": "b".repeat(64), "message-2": "c".repeat(64) }
  };
}
