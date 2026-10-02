import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { syntheticInventory, syntheticObservation } from "../test/fixtures/synthetic-inventory.js";
import { computeInventoryHash, validateInventoryIntegrity } from "./index.js";

describe("inventory run contract", () => {
  it("accepts a hash-valid platform-neutral synthetic inventory", async () => {
    const schemaPath = fileURLToPath(new URL("../schemas/inventory-run.schema.json", import.meta.url));
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const validate = new Ajv2020Module.default({ strict: true, formats: { "date-time": true } }).compile(schema);
    const inventory = syntheticInventory("inventory-schema-1", [syntheticObservation("alpha", "Alpha", 0)]);

    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
    expect(validateInventoryIntegrity(inventory)).toEqual([]);
    expect(computeInventoryHash(inventory)).toBe(inventory.snapshot_sha256);
  });

  it("detects evidence and snapshot tampering", () => {
    const inventory = syntheticInventory("inventory-schema-2", [syntheticObservation("alpha", "Alpha", 0)]);
    inventory.evidence[0]!.value = "tampered";

    expect(validateInventoryIntegrity(inventory)).toEqual(expect.arrayContaining([
      "inventory.snapshot_hash_mismatch",
      "inventory.evidence_hash_mismatch:evidence-alpha"
    ]));
  });
});
