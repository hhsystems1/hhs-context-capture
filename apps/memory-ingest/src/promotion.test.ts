import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import { assertImmutablePromotionSource, promotionImmutableInsert } from "./promotion.js";
import type { DbClient } from "./db.js";
import { readFileSync } from "node:fs";

describe("trusted promotion integrity", () => {
  it("preserves the legacy trusted-candidate branch verbatim while extending receipt trust", () => {
    const original = readFileSync("supabase/migrations/20260722233500_memory_v11_audit_corrections.sql","utf8");
    const added = readFileSync("supabase/migrations/20261006124036_memory_v11_trusted_promoted_candidates.sql","utf8");
    const legacy = original.split("create view memory_v1.trusted_knowledge_candidates with (security_invoker=true) as\n")[1]!.split(";\n")[0]!;
    const preserved = added.split("create or replace view memory_v1.trusted_knowledge_candidates with (security_invoker=true) as\n")[1]!.split("\nunion all\n")[0]!;
    expect(preserved).toBe(legacy);
  });
  it("recomputes immutable hashes including database timestamps", () => {
    const body = { workspace_id: "source", created_at: "2026-10-05T00:00:00.000Z", payload: { statement: "Decision" } };
    const row = { ...body, created_at: new Date(body.created_at), record_sha256: sha256(body) };
    expect(() => assertImmutablePromotionSource(row)).not.toThrow();
    expect(() => assertImmutablePromotionSource({ ...row, payload: { statement: "Forged" } })).toThrow(/hash/);
    expect(() => assertImmutablePromotionSource({ ...row, record_sha256: "a".repeat(64) })).toThrow(/hash/);
  });

  it("checks the winning hash after a concurrent conflicting insert", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => {
      calls.push(sql);
      return sql.startsWith("insert") ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ record_sha256: "other" }] };
    } } as unknown as DbClient;
    await expect(promotionImmutableInsert(client, "promotion_receipts", "promotion_receipt_id", {
      workspace_id: "destination", promotion_receipt_id: "receipt", record_sha256: "expected"
    })).rejects.toThrow(/collision/);
    expect(calls[0]).toContain("on conflict do nothing");
  });

  it("recognizes the existing provenance convention that omits the unused source family", () => {
    const body = { workspace_id: "source", target_record_type: "observation", source_version_id: "version" };
    expect(() => assertImmutablePromotionSource({ ...body, capture_version_id: null, record_sha256: sha256(body) })).not.toThrow();
    expect(() => assertImmutablePromotionSource({ ...body, capture_version_id: "forged", record_sha256: sha256(body) })).toThrow(/hash/);
  });
});
