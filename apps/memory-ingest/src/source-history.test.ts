import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import type { DbClient } from "./db.js";
import { HISTORY_CONVERSATIONS_SQL, HISTORY_EVIDENCE_SQL, readSourceHistoryFromClient, sourceEvidence, SourceHistoryNotFound } from "./source-history.js";

const workspace = "proof-workspace-synthetic";
const text = "An original user statement.";
const edge = { provenance_edge_id: "edge_1", source_conversation_id: "source_1", message_id: "message_1", sequence: 1,
  role: "user", relation: "supports", source_version_id: "version_1", capture_version_id: null,
  representation_kind: "canonical_text", representation_sha256: sha256(text), text_value: text, verification_status: "complete" };

describe("historical evidence read model", () => {
  it("returns bounded excerpts only after hash and source verification, retaining full-source citation hashes", () => {
    expect(sourceEvidence(edge)).toMatchObject({ excerpt: text, verification: "hash_matched", truncated: false });
    for (const change of [{ text_value: "tampered" }, { representation_sha256: "0".repeat(64) }, { verification_status: "partial" }]) {
      expect(() => sourceEvidence({ ...edge, ...change })).toThrow("verification failed");
    }
    const long = "x".repeat(5000);
    const result = sourceEvidence({ ...edge, text_value: long, representation_sha256: sha256(long) });
    expect(result).toMatchObject({ full_length: 5000, truncated: true, representation_sha256: sha256(long) });
    expect(result.excerpt.length).toBe(2400);
    expect(result).not.toHaveProperty("immutable_source_locator");
  });

  it("lists only persisted analyzed conversations within the explicit source scope and paginates without losing the next row", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({ source_conversation_id: `source_${String(index).padStart(3, "0")}`, title: "Synthetic", observations_count: 1 }));
    const client = { query: async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("set local")) return { rows: [] };
      expect(sql).toBe(HISTORY_CONVERSATIONS_SQL);
      expect(args).toEqual([workspace, "source_before", 51]);
      return { rows };
    } } as unknown as DbClient;
    const result = await readSourceHistoryFromClient(client, workspace, { cursor: "source_before" });
    expect(result).toMatchObject({ view: "conversations", next_cursor: "source_049" });
    expect("conversations" in result && result.conversations.length).toBe(50);
  });

  it("refuses evidence reads for an observation outside the requested conversation before resolving provenance", async () => {
    const sqlCalls: string[] = [];
    const client = { query: async (sql: string, args?: unknown[]) => {
      sqlCalls.push(sql);
      if (sql.startsWith("set local")) return { rows: [] };
      if (sql.includes("group by c.conversation_id")) return { rowCount: 1, rows: [{ conversation_id: "conv_1", source_conversation_id: "source_1", title: "Synthetic", observations_count: 1 }] };
      expect(args).toEqual([workspace, "conv_1", "observation_foreign"]);
      return { rowCount: 0, rows: [] };
    } } as unknown as DbClient;
    await expect(readSourceHistoryFromClient(client, workspace, { conversation: "source_1", observation: "observation_foreign" })).rejects.toBeInstanceOf(SourceHistoryNotFound);
    expect(sqlCalls).not.toContain(HISTORY_EVIDENCE_SQL);
  });

  it("resolves selected evidence with exact observation version and scope", async () => {
    const client = { query: async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("set local")) return { rows: [] };
      if (sql.includes("group by c.conversation_id")) return { rowCount: 1, rows: [{ conversation_id: "conv_1", source_conversation_id: "source_1", title: "Synthetic", observations_count: 1 }] };
      if (sql.startsWith("select observation_id")) return { rowCount: 1, rows: [{ observation_id: "observation_1", pipeline_version: "pipeline_1" }] };
      expect(sql).toBe(HISTORY_EVIDENCE_SQL);
      expect(args).toEqual([workspace, "observation_1", "pipeline_1", null, 51]);
      return { rows: [edge] };
    } } as unknown as DbClient;
    const result = await readSourceHistoryFromClient(client, workspace, { conversation: "source_1", observation: "observation_1" });
    expect(result).toMatchObject({ view: "evidence", observation_id: "observation_1", next_cursor: null, evidence: [{ excerpt: text }] });
  });
});
