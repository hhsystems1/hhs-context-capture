import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_KNOWLEDGE_LIST_SQL, PENDING_REVIEWS_SQL, approvedStatement, safeRef } from "./store.js";
import { APPROVED_KNOWLEDGE_QUERY_SQL } from "../../memory-ingest/src/query.js";

describe("Mission Control safety boundary", () => {
  it("turns private identities into stable non-reversible references", () => {
    const reference = safeRef("capture", "synthetic-private-id");
    expect(reference).toMatch(/^capture-[a-f0-9]{12}$/);
    expect(reference).not.toContain("synthetic-private-id");
  });

  it("keeps distinct kinds visibly separate", () => {
    expect(safeRef("message", "synthetic-id")).not.toBe(safeRef("capture", "synthetic-id"));
  });
});

describe("pending review definition", () => {
  it("keeps the proposed health counter on the promotion-inclusive base table", () => {
    const source = readFileSync(path.resolve("apps/mission-control/src/store.ts"), "utf8");
    const proposed = source.match(/\(select count\(\*\) from [^\n]+\) proposed,/)?.[0];
    expect(proposed).toBe("(select count(*) from memory_v1.knowledge_candidates where workspace_id=$1 and status='proposed') proposed,");
    expect(proposed).not.toContain("trusted_knowledge_candidates");
  });
  const candidateBranch = PENDING_REVIEWS_SQL.slice(
    PENDING_REVIEWS_SQL.indexOf("'knowledge_candidate'"),
    PENDING_REVIEWS_SQL.indexOf("'contradiction'")
  );

  it("excludes candidates that already carry a human review decision", () => {
    expect(candidateBranch).toMatch(/not exists \(select 1 from memory_v1\.human_review_events e/);
    expect(candidateBranch).toMatch(/e\.knowledge_candidate_id=k\.knowledge_candidate_id/);
    expect(candidateBranch).toMatch(/e\.workspace_id=k\.workspace_id/);
  });

  it("does not treat the immutable candidate status as sufficient on its own", () => {
    expect(candidateBranch).toContain("k.status='proposed'");
    expect(candidateBranch).toContain("human_review_events");
  });

  it("still reads candidates through the trusted view and stays workspace scoped", () => {
    expect(candidateBranch).toContain("memory_v1.trusted_knowledge_candidates");
    expect(candidateBranch).toContain("k.workspace_id=$1");
    expect(candidateBranch).toContain("'promotion_receipt_id',k.promotion_receipt_id");
  });

  it("remains a read-only projection", () => {
    expect(PENDING_REVIEWS_SQL).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });
});

describe("approved knowledge tier", () => {
  const storeSource = readFileSync(path.resolve("apps/mission-control/src/store.ts"), "utf8");

  it("delegates text matching to the proven approved-knowledge query", () => {
    expect(storeSource).toContain('import { APPROVED_KNOWLEDGE_QUERY_SQL } from "../../memory-ingest/src/query.js"');
    expect(storeSource).toContain("client.query(APPROVED_KNOWLEDGE_QUERY_SQL,");
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/plainto_tsquery\('english', \$2\)/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/from memory_v1\.approved_knowledge ak/);
  });

  it("lists only approved knowledge and resolves the exact provenance chain", () => {
    expect(APPROVED_KNOWLEDGE_LIST_SQL).toMatch(/from memory_v1\.approved_knowledge ak/);
    for (const table of ["candidate_evidence", "provenance_edges", "content_blocks", "messages", "conversations", "capture_versions", "human_review_events"]) {
      expect(APPROVED_KNOWLEDGE_LIST_SQL, table).toContain(`memory_v1.${table}`);
    }
    expect(APPROVED_KNOWLEDGE_LIST_SQL).toContain("immutable_archive_locator");
    expect(APPROVED_KNOWLEDGE_LIST_SQL).toMatch(/rep->>'sha256'=pe\.representation_sha256/);
    expect(APPROVED_KNOWLEDGE_LIST_SQL).toContain("ak.workspace_id=$1");
  });

  it("never reaches unapproved candidates or review-event writes", () => {
    expect(APPROVED_KNOWLEDGE_LIST_SQL).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
    expect(storeSource).not.toMatch(/createPool\(/);
    expect(storeSource).not.toMatch(/\b(insert into|update |delete from|truncate)\b/i);
  });

  it("exposes exactly one read-only approved-knowledge route", () => {
    const serverSource = readFileSync(path.resolve("apps/mission-control/src/server.ts"), "utf8");
    expect(serverSource).toContain('request.method === "POST" && request.url === "/api/approved-knowledge"');
    expect(serverSource).toContain("await store.approvedKnowledge(input)");
    expect(serverSource).not.toMatch(/\b(approve|reject)Candidate\b/);
    expect(serverSource).not.toMatch(/MEMORY_(REVIEW|INGEST|DATABASE)_URL/);
  });

  it("renders distilled statements and message ranges without inventing content", () => {
    expect(approvedStatement({ statement: "Branch completeness failed for capture 440431cd." }))
      .toBe("Branch completeness failed for capture 440431cd.");
    expect(approvedStatement({ candidate_type: "message_range", start_sequence: 10, end_sequence: 14, message_ids: ["a", "b"] }))
      .toBe("Approved message range 10–14 (2 messages) of the preserved capture.");
    expect(approvedStatement({ unexpected: true })).toBe('{"unexpected":true}');
  });
});
