import { describe, expect, it } from "vitest";
import { createPool, readOnlyTransaction } from "./db.js";
import {
  ALLOWED_ITEM_FIELDS,
  KNOWN_CONVERSATIONS_SQL,
  MAX_COMPARISON_ITEMS,
  ComparisonPayloadError,
  compareDiscoveredConversations,
  parseComparisonPayload,
  toKnownConversationRow
} from "./discovery-comparison.js";

const dbEnabled = Boolean(process.env.MEMORY_REPORT_DATABASE_URL && process.env.MEMORY_WORKSPACE_ID);
const dbSuite = dbEnabled ? describe : describe.skip;

describe("comparison payload validation", () => {
  it("accepts the minimum payload", () => {
    const payload = parseComparisonPayload({
      source_kind: "chatgpt",
      opaque_account_reference: "account-opaque-1",
      items: [{ source_native_id: "conv-1", title: "A title" }]
    });

    expect(payload.sourceKind).toBe("chatgpt");
    expect(payload.items).toEqual([{ source_native_id: "conv-1", title: "A title" }]);
  });

  it("rejects any field beyond the identity and title", () => {
    expect(() => parseComparisonPayload({
      source_kind: "chatgpt",
      opaque_account_reference: "account-opaque-1",
      items: [{ source_native_id: "conv-1", title: "A title", messages: ["secret content"] }]
    })).toThrow(ComparisonPayloadError);

    expect(ALLOWED_ITEM_FIELDS).toEqual(["source_native_id", "title"]);
  });

  it("rejects unregistered source kinds", () => {
    for (const sourceKind of ["notebooklm", "onedrive", "gemini", "youtube", ""]) {
      expect(() => parseComparisonPayload({
        source_kind: sourceKind,
        opaque_account_reference: "account-opaque-1",
        items: []
      })).toThrow(/source_kind must be one of/);
    }
  });

  it("requires an opaque account reference", () => {
    expect(() => parseComparisonPayload({ source_kind: "chatgpt", opaque_account_reference: "  ", items: [] }))
      .toThrow(/opaque_account_reference is required/);
  });

  it("rejects oversized and malformed item lists", () => {
    expect(() => parseComparisonPayload({ source_kind: "chatgpt", opaque_account_reference: "a", items: "nope" }))
      .toThrow(/items must be an array/);
    expect(() => parseComparisonPayload({
      source_kind: "chatgpt",
      opaque_account_reference: "a",
      items: Array.from({ length: MAX_COMPARISON_ITEMS + 1 }, () => ({ source_native_id: "x", title: "y" }))
    })).toThrow(/may not exceed/);
    expect(() => parseComparisonPayload({
      source_kind: "chatgpt",
      opaque_account_reference: "a",
      items: [{ title: "missing id" }]
    })).toThrow(/source_native_id is required/);
  });
});

describe("row mapping", () => {
  it("normalizes timestamps and rejects unknown verification statuses", () => {
    const row = toKnownConversationRow({
      source_native_id: "conv-1",
      conversation_record_id: "conversation-1",
      verification_status: "complete",
      captured_at: new Date("2026-08-01T12:00:00.000Z"),
      title_sha256: "a".repeat(64)
    });

    expect(row.captured_at).toBe("2026-08-01T12:00:00.000Z");
    expect(row.verification_status).toBe("complete");

    const unknown = toKnownConversationRow({
      source_native_id: "conv-2",
      conversation_record_id: "conversation-2",
      verification_status: "something_else",
      captured_at: null,
      title_sha256: null
    });
    expect(unknown.verification_status).toBeNull();
    expect(unknown.title_sha256).toBeNull();
  });
});

describe("comparison query shape", () => {
  it("contains no write statement", () => {
    expect(KNOWN_CONVERSATIONS_SQL).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant)\b/i);
    expect(KNOWN_CONVERSATIONS_SQL).toMatch(/^\s*select/i);
  });

  it("scopes every query by workspace, account, and source kind", () => {
    expect(KNOWN_CONVERSATIONS_SQL).toMatch(/c\.workspace_id = \$1/);
    expect(KNOWN_CONVERSATIONS_SQL).toMatch(/sa\.opaque_account_reference = \$2/);
    expect(KNOWN_CONVERSATIONS_SQL).toMatch(/ss\.adapter_contract like \$3/);
  });
});

dbSuite("read-only database enforcement (requires local database)", () => {
  const workspaceId = process.env.MEMORY_WORKSPACE_ID ?? "";

  it("executes the comparison query through the report-reader path", async () => {
    const pool = createPool("reader");
    try {
      const records = await compareDiscoveredConversations({
        workspaceId,
        sourceKind: "chatgpt",
        opaqueAccountReference: "account-opaque-does-not-exist",
        items: [{ source_native_id: "conversation-does-not-exist", title: "Nothing" }]
      }, pool);

      expect(records).toEqual([]);
    } finally { await pool.end(); }
  });

  it("rejects a write attempted inside the read-only transaction", async () => {
    const pool = createPool("reader");
    try {
      await expect(readOnlyTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "insert into memory_v1.workspaces (workspace_id, idempotency_key, record_sha256, name) values ($1,$2,$3,$4)",
          [`intrusion-${Date.now()}`, "a".repeat(64), "b".repeat(64), "should never be written"]
        );
      })).rejects.toThrow(/read-only|permission denied|must be owner/i);
    } finally { await pool.end(); }
  });

  it("rejects a write even outside a read-only transaction, because the role holds no write grant", async () => {
    const pool = createPool("reader");
    const client = await pool.connect();
    try {
      // Wrapped in a transaction that is always rolled back, so that even an unexpected success
      // cannot leave a row behind in memory_v1.
      await client.query("begin");
      await expect(client.query(
        "insert into memory_v1.workspaces (workspace_id, idempotency_key, record_sha256, name) values ($1,$2,$3,$4)",
        ["intrusion-probe", "a".repeat(64), "b".repeat(64), "should never be written"]
      )).rejects.toThrow(/permission denied|read-only|must be owner|violates row-level security/i);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
