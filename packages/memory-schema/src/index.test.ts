import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildSyntheticMemoryFixture } from "../test/fixtures/synthetic-memory.js";
import { deterministicId, idempotencyKey } from "./index.js";
import { mergeMemoryFoundation, validateMemoryFoundation } from "./invariants.js";

describe("Memory Foundation M1", () => {
  it("accepts the complete synthetic acceptance fixture", async () => {
    const validate = await schemaValidator();
    const fixture = buildSyntheticMemoryFixture();
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validateMemoryFoundation(fixture)).toEqual([]);
  });

  it("builds deterministic identifiers and replays idempotently", () => {
    const first = buildSyntheticMemoryFixture();
    const second = buildSyntheticMemoryFixture();
    expect(second).toEqual(first);
    expect(deterministicId("candidate", "workspace", "key")).toBe(deterministicId("candidate", "workspace", "key"));
    expect(idempotencyKey("candidate", "workspace", "key")).toHaveLength(64);
    expect(mergeMemoryFoundation(first, second)).toEqual(first);
  });

  it("rejects an unresolved or altered evidence representation", () => {
    const fixture = buildSyntheticMemoryFixture();
    fixture.provenance_edges[0]!.evidence.representation_sha256 = "f".repeat(64);
    expect(validateMemoryFoundation(fixture).map((issue) => issue.code)).toContain("representation_unresolved");
  });

  it("rejects normalized representation values that do not match their hashes", () => {
    const fixture = buildSyntheticMemoryFixture();
    fixture.content_blocks[0]!.representations[0]!.value = "Altered after hashing";
    expect(validateMemoryFoundation(fixture).map((issue) => issue.code)).toContain("representation_hash_mismatch");
  });

  it("rejects direct proposed-to-approved lifecycle transitions", () => {
    const fixture = buildSyntheticMemoryFixture();
    fixture.human_review_events[0]!.to_status = "approved";
    expect(validateMemoryFoundation(fixture).map((issue) => issue.code)).toContain("invalid_candidate_transition");
  });

  it("rejects approved knowledge without its separate human approval event", () => {
    const fixture = buildSyntheticMemoryFixture();
    fixture.approved_knowledge[0]!.approval_event_id = "missing-event";
    const codes = validateMemoryFoundation(fixture).map((issue) => issue.code);
    expect(codes).toContain("reference_unresolved");
    expect(codes).toContain("approval_event_invalid");
  });

  it("rejects cross-workspace derived records", () => {
    const fixture = buildSyntheticMemoryFixture();
    fixture.tasks[0]!.workspace_id = "another-workspace";
    expect(validateMemoryFoundation(fixture).map((issue) => issue.code)).toContain("workspace_unresolved");
  });

  it("rejects idempotency collisions instead of silently merging", () => {
    const first = buildSyntheticMemoryFixture();
    const conflicting = buildSyntheticMemoryFixture();
    conflicting.tasks[0]!.title = "Changed after deterministic identity assignment";
    expect(() => mergeMemoryFoundation(first, conflicting)).toThrow(/Idempotency collision/);
  });

  it("schema rejects invalid hashes and relationship kinds", async () => {
    const validate = await schemaValidator();
    const fixture = buildSyntheticMemoryFixture();
    fixture.source_records[0]!.source_sha256 = "not-a-sha256";
    expect(validate(fixture)).toBe(false);
    const invalid = buildSyntheticMemoryFixture() as unknown as { relationships: Array<{ relationship_kind: string }> };
    invalid.relationships[0]!.relationship_kind = "silently_replaces";
    expect(validate(invalid)).toBe(false);
  });
});

async function schemaValidator() {
  const schemaPath = fileURLToPath(new URL("../schemas/memory-foundation.schema.json", import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return new Ajv2020Module.default({ strict: true, formats: { "date-time": true } }).compile(schema);
}
