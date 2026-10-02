import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  syntheticContainer,
  syntheticDiscovery,
  syntheticItem
} from "../test/fixtures/synthetic-discovery.js";
import {
  computeDiscoveryHash,
  finalizeDiscovery,
  isVerifiedCompleteDiscovery,
  validateDiscoveryIntegrity
} from "./index.js";

async function compileSchema() {
  const schemaPath = fileURLToPath(new URL("../schemas/discovery-run.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return new Ajv2020Module.default({ strict: true, formats: { "date-time": true } }).compile(schema);
}

describe("universal discovery run contract", () => {
  it("accepts a hash-valid source-neutral synthetic discovery run", async () => {
    const validate = await compileSchema();
    const run = syntheticDiscovery("discovery-1", [syntheticContainer("root", 2)], [
      syntheticItem("alpha", "root", 0),
      syntheticItem("beta", "root", 1)
    ]);

    expect(validate(run), JSON.stringify(validate.errors)).toBe(true);
    expect(validateDiscoveryIntegrity(run)).toEqual([]);
    expect(computeDiscoveryHash(run)).toBe(run.snapshot_sha256);
    expect(isVerifiedCompleteDiscovery(run)).toBe(true);
  });

  it("rejects 'complete' when any required boundary is incomplete", () => {
    const run = syntheticDiscovery("discovery-2", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)], {
      status: "complete",
      boundaryOverrides: { enumeration_end_reached: false }
    });

    expect(isVerifiedCompleteDiscovery(run)).toBe(false);
    expect(validateDiscoveryIntegrity(run)).toContain("discovery.complete_boundaries_not_verified");
  });

  it("rejects 'complete' when warnings were raised", () => {
    const run = syntheticDiscovery("discovery-3", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)], {
      status: "complete",
      warnings: ["traversal_did_not_stabilize"]
    });

    expect(isVerifiedCompleteDiscovery(run)).toBe(false);
    expect(validateDiscoveryIntegrity(run)).toContain("discovery.complete_boundaries_not_verified");
  });

  it("rejects 'complete' when any container was not fully enumerated", () => {
    const run = syntheticDiscovery(
      "discovery-4",
      [syntheticContainer("root", 1, "complete"), syntheticContainer("blocked-project", 0, "blocked", 1)],
      [syntheticItem("alpha", "root", 0)],
      { status: "complete" }
    );

    expect(isVerifiedCompleteDiscovery(run)).toBe(false);
    expect(validateDiscoveryIntegrity(run)).toContain("discovery.complete_boundaries_not_verified");
  });

  it("treats 'not_attempted' as distinct from an enumerated empty container", async () => {
    const validate = await compileSchema();
    const enumeratedEmpty = syntheticDiscovery("discovery-5", [syntheticContainer("root", 0, "complete")], []);
    const neverLooked = syntheticDiscovery("discovery-6", [syntheticContainer("root", 0, "not_attempted")], [], {
      status: "partial"
    });

    // Both have zero items, but they are different states and must not hash alike.
    expect(enumeratedEmpty.containers[0]!.observed_item_count).toBe(0);
    expect(neverLooked.containers[0]!.observed_item_count).toBe(0);
    expect(enumeratedEmpty.containers[0]!.enumeration_status).not.toBe(neverLooked.containers[0]!.enumeration_status);
    expect(enumeratedEmpty.containers[0]!.observation_fingerprint).not.toBe(neverLooked.containers[0]!.observation_fingerprint);

    expect(validate(enumeratedEmpty), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(neverLooked), JSON.stringify(validate.errors)).toBe(true);
    expect(validateDiscoveryIntegrity(enumeratedEmpty)).toEqual([]);
    expect(validateDiscoveryIntegrity(neverLooked)).toEqual([]);

    // Only the enumerated-empty run may be considered verified-complete.
    expect(isVerifiedCompleteDiscovery(enumeratedEmpty)).toBe(true);
    expect(isVerifiedCompleteDiscovery(neverLooked)).toBe(false);
  });

  it("refuses a 'not_attempted' container that still claims observed items", () => {
    const container = syntheticContainer("root", 0, "not_attempted");
    const run = finalizeDiscovery({
      ...syntheticDiscovery("discovery-7", [container], [], { status: "partial" }),
      containers: [{ ...container, observed_item_count: 3 }]
    });

    expect(validateDiscoveryIntegrity(run)).toContain("discovery.not_attempted_container_reported_items:root");
  });

  it("detects evidence and snapshot tampering", () => {
    const run = syntheticDiscovery("discovery-8", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)]);
    run.evidence[0]!.value = "tampered";

    expect(validateDiscoveryIntegrity(run)).toEqual(expect.arrayContaining([
      "discovery.snapshot_hash_mismatch",
      `discovery.evidence_hash_mismatch:${run.evidence[0]!.evidence_id}`
    ]));
  });

  it("computes a deterministic snapshot hash that changes when any observation changes", () => {
    const first = syntheticDiscovery("discovery-9", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)]);
    const identical = syntheticDiscovery("discovery-9", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)]);
    const changed = syntheticDiscovery("discovery-9", [syntheticContainer("root", 1)], [
      syntheticItem("alpha", "root", 0, { title: "A different title" })
    ]);

    expect(first.snapshot_sha256).toBe(identical.snapshot_sha256);
    expect(changed.snapshot_sha256).not.toBe(first.snapshot_sha256);
  });

  it("requires a capability report and preserves 'unsupported' as distinct from absence", async () => {
    const validate = await compileSchema();
    const run = syntheticDiscovery("discovery-10", [syntheticContainer("root", 0, "complete")], []);
    const declared = { ...run, capabilities: { containers: "supported" as const, audio_overviews: "unsupported" as const } };
    const finalized = finalizeDiscovery(declared);

    expect(validate(finalized), JSON.stringify(validate.errors)).toBe(true);
    expect(finalized.capabilities.audio_overviews).toBe("unsupported");
    expect(validateDiscoveryIntegrity(finalized)).toEqual([]);

    const withoutCapabilities = finalizeDiscovery({ ...run, capabilities: {} });
    expect(validateDiscoveryIntegrity(withoutCapabilities)).toContain("discovery.capability_report_missing");
  });

  it("resolves container, item, and relationship references", () => {
    const run = syntheticDiscovery("discovery-11", [syntheticContainer("root", 1)], [syntheticItem("alpha", "root", 0)]);
    const broken = finalizeDiscovery({
      ...run,
      items: [{ ...run.items[0]!, container_id: "missing-container" }]
    });

    expect(validateDiscoveryIntegrity(broken)).toEqual(expect.arrayContaining([
      "discovery.unresolved_container:alpha"
    ]));
  });
});
