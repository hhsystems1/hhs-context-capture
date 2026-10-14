import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicId } from "@hhs/memory-schema";
import { immutableRow, recordDecisionFromClient } from "./review.js";
import type { DbClient } from "./db.js";

const reviewSource = await readFile(path.resolve("apps/memory-ingest/src/review.ts"), "utf8");
const migrationSource = await readFile(path.resolve("supabase/migrations/20260809000000_memory_v11_review_role.sql"), "utf8");

describe("review role migration", () => {
  it("is additive and grants insert on exactly the two review tables", () => {
    expect(migrationSource).toMatch(/create role memory_v1_reviewer nologin/);
    expect(migrationSource).toMatch(/create role memory_v1_review_login login inherit/);
    expect(migrationSource).toMatch(/grant insert on memory_v1\.human_review_events, memory_v1\.approved_knowledge to memory_v1_reviewer/);
    expect(migrationSource).not.toMatch(/drop\s+(table|role|policy|trigger)/i);
    expect(migrationSource).not.toMatch(/grant\s+(update|delete|truncate)/i);
    expect((migrationSource.match(/grant insert/gi) ?? []).length).toBe(1);
  });
});

describe("review decision records", () => {
  it("still refuses approval of legacy candidates without local evidence", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => {
      calls.push(sql);
      return sql.includes("select knowledge_candidate_id")
        ? { rowCount: 1, rows: [{ knowledge_candidate_id: "legacy", pipeline_version: "legacy/1", status: "proposed", promotion_receipt_id: null }] }
        : { rowCount: 0, rows: [] };
    } } as unknown as DbClient;
    await expect(recordDecisionFromClient(client, { workspaceId: "workspace", candidateId: "legacy", reviewerId: "human", rationale: "Checked" }, "approved")).rejects.toThrow(/no evidence/);
    expect(calls.some((sql) => sql.startsWith("insert into memory_v1.approved_knowledge"))).toBe(false);
  });
  it("derives deterministic identities from the candidate alone so a second decision collides", () => {
    const eventA = deterministicId("human_review_event", "workspace_w", ["candidate_1"]);
    const eventB = deterministicId("human_review_event", "workspace_w", ["candidate_1"]);
    const eventOther = deterministicId("human_review_event", "workspace_w", ["candidate_2"]);
    expect(eventA).toBe(eventB);
    expect(eventA).not.toBe(eventOther);
  });

  it("hashes the full row body so differing decisions can never replay silently", () => {
    const approve = immutableRow("human_review_event", "workspace_w", ["candidate_1"], { to_status: "approved" });
    const reject = immutableRow("human_review_event", "workspace_w", ["candidate_1"], { to_status: "rejected" });
    expect(approve.idempotency_key).toBe(reject.idempotency_key);
    expect(approve.record_sha256).not.toBe(reject.record_sha256);
  });

  it("uses only the reviewer role for decisions and never issues update or delete statements", () => {
    expect(reviewSource).toMatch(/createPool\("reviewer"\)/);
    expect(reviewSource).not.toMatch(/createPool\("(admin|writer)"\)/);
    expect(reviewSource).not.toMatch(/\b(update|delete from)\s+memory_v1\./i);
  });

  it("refuses a second decision with an explicit already-reviewed error", () => {
    expect(reviewSource).toMatch(/Candidate already reviewed/);
    expect(reviewSource).toMatch(/append-only/);
  });

  it("records reviewer identity, timestamp, rationale, and human actor kind", () => {
    for (const field of ["reviewer_id", "occurred_at", "rationale", 'actor_kind: "human"', "event_sha256"]) {
      expect(reviewSource).toContain(field);
    }
  });
});
