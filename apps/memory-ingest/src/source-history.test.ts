import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import type { DbClient } from "./db.js";
import { HISTORY_CONVERSATIONS_SQL, HISTORY_LINKS_SQL, sourceObservationLinks, HISTORY_EVIDENCE_SQL, readSourceHistoryFromClient, sourceEvidence, sourceConversationContext, HISTORY_CONTEXT_SQL, SourceHistoryNotFound } from "./source-history.js";

const workspace = "proof-workspace-synthetic";
const text = "An original user statement.";
const edge = { provenance_edge_id: "edge_1", source_conversation_id: "source_1", message_id: "message_1", sequence: 1,
  role: "user", active_path: true, relation: "supports", source_version_id: "version_1", capture_version_id: null,
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
      expect(args).toEqual([workspace, "source_before", 51, null]);
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
      if (sql === HISTORY_CONTEXT_SQL) {
        expect(args).toEqual([workspace, "conv_1", ["message_1"], 51]);
        return { rows: [] };
      }
      expect(sql).toBe(HISTORY_EVIDENCE_SQL);
      expect(args).toEqual([workspace, "observation_1", "pipeline_1", null, 51]);
      return { rows: [edge] };
    } } as unknown as DbClient;
    const result = await readSourceHistoryFromClient(client, workspace, { conversation: "source_1", observation: "observation_1" });
    expect(result).toMatchObject({ view: "evidence", observation_id: "observation_1", next_cursor: null, evidence: [{ excerpt: text }] });
  });
});


describe("surrounding original user context", () => {
  const row = { ...edge, anchor_message_id: "assistant_1", position: "before", message_id: "user_1" };
  it("hash-verifies original user text without pretending it is an observation's provenance edge", () => {
    const context = sourceConversationContext(row);
    expect(context).toMatchObject({ anchor_message_id: "assistant_1", position: "before", role: "user", message_id: "user_1", excerpt: text, verification: "hash_matched" });
    expect(context).not.toHaveProperty("provenance_edge_id");
    for (const changed of [{ text_value: "tampered" }, { verification_status: "partial" }, { role: "assistant" }, { position: "arbitrary" }]) {
      expect(() => sourceConversationContext({ ...row, ...changed })).toThrow();
    }
  });

  it("reads context only for the already verified anchors in the requested conversation", async () => {
    const client = { query: async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("set local")) return { rows: [] };
      if (sql.includes("group by c.conversation_id")) return { rowCount: 1, rows: [{ conversation_id: "conv_1", source_conversation_id: "source_1", title: "Synthetic", observations_count: 1 }] };
      if (sql.startsWith("select observation_id")) return { rowCount: 1, rows: [{ observation_id: "observation_1", pipeline_version: "pipeline_1" }] };
      if (sql === HISTORY_EVIDENCE_SQL) return { rows: [{ ...edge, message_id: "assistant_1", role: "assistant", sequence: 2 }] };
      expect(sql).toBe(HISTORY_CONTEXT_SQL);
      expect(args).toEqual([workspace, "conv_1", ["assistant_1"], 51]);
      return { rows: [row] };
    } } as unknown as DbClient;
    const result = await readSourceHistoryFromClient(client, workspace, { conversation: "source_1", observation: "observation_1" });
    expect(result).toMatchObject({ evidence: [{ role: "assistant" }], conversation_context: [{ role: "user", position: "before" }] });
  });
});

describe("original source dates",()=>{
 it("returns only original source dates, never storage or analysis time",()=>{
  expect(sourceEvidence({...edge,source_created_at:new Date('2025-03-02T04:05:06Z'),source_updated_at:'2025-03-03T04:05:06Z',created_at:'2026-01-01'})).toMatchObject({source_created_at:'2025-03-02T04:05:06.000Z',source_updated_at:'2025-03-03T04:05:06.000Z'});
  expect(sourceEvidence({...edge,created_at:'2026-01-01',source_created_at:'not a date'})).toMatchObject({source_created_at:null,source_updated_at:null});
  expect(HISTORY_EVIDENCE_SQL).toContain('m.source_created_at,m.source_updated_at');expect(HISTORY_CONTEXT_SQL).toContain('m.source_created_at,m.source_updated_at');
 });
});

describe('existing relationship projection for Personal inquiry',()=>{
 it('retains source-scoped endpoints and relationship kinds without exposing payloads',()=>{
  const result=sourceObservationLinks([{observation_link_id:'link_1',from_observation_id:'observation_1',to_observation_id:'observation_2',link_kind:'elaborates',payload:{private:'not returned'}},{observation_link_id:'link_2',from_observation_id:'foreign_a',to_observation_id:'foreign_b',link_kind:'related'}],'observation_1');
  expect(result).toEqual({links:[{id:'link_1',from:'observation_1',to:'observation_2',kind:'elaborates'}],links_truncated:false,links_page_truncated:false});expect(HISTORY_LINKS_SQL).toContain('l.workspace_id=$1');expect(HISTORY_LINKS_SQL).toContain('a.workspace_id=l.workspace_id');expect(HISTORY_LINKS_SQL).toContain('b.workspace_id=l.workspace_id');
 });
 it('reports bounded/truncated relationship coverage instead of claiming the full graph',()=>{
  const rows=Array.from({length:41},(_,i)=>({observation_link_id:'link_'+i,from_observation_id:'observation_1',to_observation_id:'other_'+i,link_kind:'related'}));expect(sourceObservationLinks(rows,'observation_1').links).toHaveLength(40);expect(sourceObservationLinks(rows,'observation_1').links_truncated).toBe(true);
 });
});

it('distinguishes a globally bounded relationship page from truncation of this observation',()=>{
 const rows=Array.from({length:2001},(_,i)=>({observation_link_id:'link_'+i,from_observation_id:'elsewhere',to_observation_id:'other',link_kind:'related'}));
 expect(sourceObservationLinks(rows,'observation_1')).toEqual({links:[],links_truncated:false,links_page_truncated:true});
});
