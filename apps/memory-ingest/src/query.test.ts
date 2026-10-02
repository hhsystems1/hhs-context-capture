import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_KNOWLEDGE_QUERY_SQL } from "./query.js";

const querySource = await readFile(path.resolve("apps/memory-ingest/src/query.ts"), "utf8");

describe("approved-knowledge query", () => {
  it("is fully parameterized deterministic text search", () => {
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/plainto_tsquery\('english', \$2\)/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/ak\.workspace_id = \$1/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/limit \$3/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).not.toMatch(/\$\{/);
  });

  it("selects only approved knowledge and resolves exact provenance to the immutable archive", () => {
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/from memory_v1\.approved_knowledge ak/);
    for (const column of ["approved_knowledge_id", "immutable_archive_locator", "source_conversation_id", "message_id", "provenance_edge_id", "representation_sha256", "reviewer_id"]) {
      expect(APPROVED_KNOWLEDGE_QUERY_SQL).toContain(column);
    }
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/rep->>'sha256' = pe\.representation_sha256/);
  });

  it("uses only the read-only report role", () => {
    expect(querySource).toMatch(/createPool\("reader"\)/);
    expect(querySource).not.toMatch(/createPool\("(admin|writer|reviewer)"\)/);
    expect(querySource).toMatch(/readOnlyTransaction/);
  });

  it("never mutates state", () => {
    expect(querySource).not.toMatch(/\b(insert|update|delete)\b/i);
  });
});
