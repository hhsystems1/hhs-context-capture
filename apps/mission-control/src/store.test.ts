import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { APPROVED_KNOWLEDGE_LIST_SQL, PENDING_REVIEWS_SQL, MissionControlStore, approvedStatement, safeRef } from "./store.js";
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

describe("bounded read-only fast status", () => {
  it("Finding 6: uses the report role and selected workspace, deterministic ordering, bounded queries, and explicit review deferral", async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === "select current_user") return { rows: [{ current_user: "memory_v1_report_login" }] };
      if (sql.includes("limit 1")) {
        expect(parameters).toEqual(["synthetic-workspace"]);
        expect(sql).toContain("order by created_at desc,operation_id asc");
        return { rows: [{ operation_id: "private-operation", status: "interrupted", last_successful_stage: "archive" }] };
      }
      if (sql.includes("operation_issues")) return { rows: [{ operation_issues: "2", quarantine: "3", contradictions: "4" }] };
      if (sql.includes("messages")) return { rows: [{ messages: "5", blocks: "6", proposed: "7", approved: "8" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as any);
    const store = new MissionControlStore("synthetic-workspace", "postgresql://memory_v1_report_login:synthetic@127.0.0.1:55022/postgres");
    try {
      const report = await store.statusSummary();
      expect(report).toMatchObject({ mode: "read_only", needs_you: 9, review_queue_state: "deferred_from_fast_status",
        memory: { messages: 5, blocks: 6, proposed: 7, approved: 8 },
        operations: [{ status: "interrupted", operation_ref: safeRef("operation", "private-operation") }] });
      expect(JSON.stringify(report)).not.toContain("private-operation");
      expect(query.mock.calls.slice(0, 5)).toEqual([
        ["begin read only"], ["select set_config('memory_v1.workspace_id',$1,true)", ["synthetic-workspace"]],
        ["select current_user"], ["set local statement_timeout = '5000ms'"], ["set local lock_timeout = '2000ms'"]
      ]);
      expect(query).toHaveBeenLastCalledWith("commit");
      expect(query.mock.calls.some(([sql]) => sql === PENDING_REVIEWS_SQL)).toBe(false);
      for (const [sql, parameters] of query.mock.calls.filter(([sql]) => sql.includes("from "))) {
        expect(parameters).toEqual(["synthetic-workspace"]);
        expect(sql).toContain("workspace_id=$1");
      }
      expect(release).toHaveBeenCalledOnce();
      const source = readFileSync("apps/mission-control/src/store.ts", "utf8");
      expect(source).toContain("connectionTimeoutMillis: 3000");
      expect(source).toContain("memory_v1.trusted_knowledge_candidates where workspace_id=$1) candidates");
      const cli = readFileSync("scripts/hhs.ts", "utf8");
      expect(cli).toContain("await store.statusSummary()");
      expect(cli).toContain('!report ? "unavailable"');
    } finally { connect.mockRestore(); await store.close(); }
  });

  it.each(["snapshot", "search"] as const)("Finding 6: %s does not inherit fast-status query timeouts", async (method) => {
    const query = vi.fn(async (sql: string) => ({ rows: sql === "select current_user"
      ? [{ current_user: "memory_v1_report_login" }] : [] }));
    const release = vi.fn();
    const connect = vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as any);
    const store = new MissionControlStore("synthetic-workspace", "postgresql://memory_v1_report_login:synthetic@127.0.0.1:55022/postgres");
    try {
      if (method === "snapshot") await store.snapshot(); else await store.search({ text: "synthetic" });
      expect(query.mock.calls.some(([sql]) => /statement_timeout|lock_timeout/.test(sql))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes("from "))).toBe(true);
      expect(query).toHaveBeenLastCalledWith("commit");
      expect(release).toHaveBeenCalledOnce();
    } finally { connect.mockRestore(); await store.close(); }
  });

  it("rejects a write-capable role without loading any status data", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql === "select current_user" ? [{ current_user: "memory_v1_ingest_login" }] : [] }));
    const release = vi.fn();
    const connect = vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as any);
    const store = new MissionControlStore("synthetic-workspace", "postgresql://memory_v1_ingest_login:synthetic@127.0.0.1:55022/postgres");
    try {
      await expect(store.statusSummary()).rejects.toThrow(/report-reader/);
      expect(query).toHaveBeenLastCalledWith("rollback");
      expect(query.mock.calls.some(([sql]) => sql.includes("from "))).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    } finally { connect.mockRestore(); await store.close(); }
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
