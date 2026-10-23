import { describe, it, expect } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import { splitDiscoveryExchange, validateDiscoveryOutput, persistValidatedDiscovery,
  UNDERSTANDING_INPUT_SCHEMA, UNDERSTANDING_OUTPUT_SCHEMA, UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  type DiscoveryEvidence, type DiscoveryExchange, type DiscoveryOutput } from "./understanding-discovery.js";
import { createEvidenceFragment, fragmentProof } from "./discovery-fragments.js";
import type { DbClient } from "./db.js";
// @ts-expect-error Existing native ESM provider adapter has no TypeScript declaration; exercise its real runtime projection.
import { modelDiscoveryExchange, restoreModelEvidenceRefs } from "../../../scripts/reconstruction-provider.mjs";
const MODEL = { provider: "fixture", name: "fixture", runner_version: "fixture/1" };
function evidence(text: string, id = "block"): DiscoveryEvidence {
  const hash = sha256(text);
  return { evidence_ref: "ev-" + id, source_conversation_id: "source", conversation_id: "conversation",
    source_family: "native_export", source_version_id: "version", capture_version_id: null,
    message_id: "original-message", source_message_id: "original-source-message", message_sequence: 4,
    role: "assistant", active_path: true, content_block_id: id, block_kind: "text",
    representation_kind: "canonical_text", text, representation_sha256: hash, source_record_id: "record-" + id,
    immutable_evidence_locator: "fixture://block/" + id, source_record_sha256: hash, source_version_locator: "fixture://source",
    source_container_sha256: null, capture_locator: null, capture_manifest_sha256: null,
    resolution_id: "resolution-" + id, resolution_expected_sha256: hash, resolution_observed_sha256: hash,
    resolution_exact: true, source_observed_at: "2026-01-01T00:00:00Z" };
}
function exchange(rows: DiscoveryEvidence[]): DiscoveryExchange {
  return { schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: "parent-exchange", evidence_sha256: sha256(rows), created_at: "2026-01-01T00:00:00Z",
    selection: [{ source_conversation_id: "source", title: "Fixture", source_family: "native_export",
      observed_at: "2026-01-01T00:00:00Z", message_count: 1, content_characters: rows.reduce((n,r) => n+r.text.length,0),
      conversation_id: "conversation", source_version_id: "version", content_sha256: "c".repeat(64),
      immutable_source_locator: "fixture://source", source_container_sha256: null, capture_version_id: null,
      capture_manifest_sha256: null, capture_locator: null }],
    evidence: rows, model_instructions: { output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA,
      observation_kinds_are_free_text: true, link_kinds_are_free_text: true, evidence_refs_are_authoritative: true,
      evidence_excerpts_are_optional: true, user_authority_requires_user_evidence: true,
      database_ids_or_hashes_required: false, model_metadata_required: false } };
}
function candidate(input: DiscoveryExchange, refs: string[]): DiscoveryOutput {
  return { schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: input.exchange_id, links: [],
    observations: refs.map((ref,i) => ({ observation_ref: "o"+i, source_conversation_id: "source",
      observation_kind: "assistant_output", statement: "Assistant supplied historical idea " + i + " for " + ref + ".",
      payload: {}, attribution: { subject: "assistant", claim_type: "proposal" }, confidence: 0.7,
      evidence: [{ evidence_ref: ref }] })) };
}
const large = () => exchange([evidence("alpha 🙂 beta\n".repeat(3000))]);
describe("canonical evidence-preserving subdivision", () => {
  it("subdivides one message between content blocks without changing any evidence row", () => {
    const input = exchange([evidence("one".repeat(800), "a"), evidence("two".repeat(800), "b"), evidence("three".repeat(800), "c")]);
    const before = JSON.stringify(input);
    expect(splitDiscoveryExchange(input, 6000)).toHaveLength(1);
    const chunks = splitDiscoveryExchange(input, 6000, { subdivideMessages: true });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap(c=>c.exchange.evidence)).toEqual(input.evidence);
    expect(chunks.every(c=>!c.exchange.evidence_fragments)).toBe(true);
    expect(chunks.every(c=>c.exchange.evidence.every(r=>r.message_id==="original-message"))).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(splitDiscoveryExchange(input,6000,{subdivideMessages:true})).toEqual(chunks);
  });
  it("fragments a single row deterministically with exact coverage and Unicode-safe absolute offsets", () => {
    const input=large(), before=JSON.stringify(input);
    const chunks=splitDiscoveryExchange(input,6000,{subdivideMessages:true});
    const fragments=chunks.flatMap(c=>c.exchange.evidence_fragments ?? []);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.map(f=>f.fragment_text).join("")).toBe(input.evidence[0]!.text);
    expect(fragments[0]!.start_offset).toBe(0);
    for(let i=1;i<fragments.length;i++)expect(fragments[i]!.start_offset).toBe(fragments[i-1]!.end_offset);
    expect(new Set(chunks.map(c=>c.exchange.exchange_id)).size).toBe(chunks.length);
    for(const chunk of chunks) {
      expect(chunk.exchange.evidence[0]).toEqual(input.evidence[0]);
      const projected=modelDiscoveryExchange(chunk.exchange);
      expect(projected.evidence.every((r: any)=>r.derived_fragment && r.text.length < input.evidence[0]!.text.length)).toBe(true);
      expect(validateDiscoveryOutput(chunk.exchange,restoreModelEvidenceRefs(candidate(chunk.exchange,projected.evidence.map((r:any)=>r.evidence_ref)),chunk.exchange),MODEL).issues).toEqual([]);
    }
    expect(splitDiscoveryExchange(input,6000,{subdivideMessages:true})).toEqual(chunks);
    const children=splitDiscoveryExchange(chunks[0]!.exchange,3000,{subdivideMessages:true});
    expect(children.flatMap(c=>c.exchange.evidence_fragments ?? []).map(f=>f.fragment_text).join(""))
      .toBe(chunks[0]!.exchange.evidence_fragments!.map(f=>f.fragment_text).join(""));
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["fragment_text","start_offset","end_offset","fragment_sha256","parent_evidence_ref","fragment_ref"])("rejects tampered fragment %s", field => {
    const child=structuredClone(splitDiscoveryExchange(large(),6000,{subdivideMessages:true})[0]!.exchange);
    const f=child.evidence_fragments![0]!;
    Object.assign(f,{[field]:field.includes("offset") ? -1 : "forged"});
    expect(validateDiscoveryOutput(child,candidate(child,["ev-block"]),MODEL).issues.some(i=>i.problem.includes("fragment"))).toBe(true);
  });
  it("rejects an exact but unissued range and altered parent evidence", () => {
    const input=large(), child=splitDiscoveryExchange(input,6000,{subdivideMessages:true})[0]!.exchange;
    const output=candidate(child,["ev-block"]);
    output.observations[0]!.evidence[0]!.fragment=fragmentProof(createEvidenceFragment(input.evidence[0]!,0,5));
    expect(validateDiscoveryOutput(child,output,MODEL).issues.some(i=>i.problem.includes("issued"))).toBe(true);
    const forged=structuredClone(child); forged.evidence[0]!.text="changed";
    forged.evidence_sha256=sha256(forged.evidence);
    expect(validateDiscoveryOutput(forged,candidate(forged,["ev-block"]),MODEL).issues.length).toBeGreaterThan(0);
  });
  it("merges fragment observations against original evidence and persists original provenance idempotently", async () => {
    const input=large(), chunks=splitDiscoveryExchange(input,6000,{subdivideMessages:true});
    const merged=candidate(input,[]);
    chunks.forEach((chunk,index)=>{
      const projected=modelDiscoveryExchange(chunk.exchange);
      const normalized=restoreModelEvidenceRefs(candidate(chunk.exchange,projected.evidence.map((r:any)=>r.evidence_ref)),chunk.exchange);
      normalized.observations.forEach((o:any,i:number)=>merged.observations.push({...o,observation_ref:"part"+index+"_"+i,statement:o.statement+" Processing part "+index+"."}));
    });
    const checked=validateDiscoveryOutput(input,merged,MODEL);
    expect(checked.issues).toEqual([]);
    const stored=new Map<string,Record<string,unknown>>();
    const client={ query:async(sql:string,values:unknown[])=>{
      const table=sql.match(/memory_v1\.(\w+)/)![1]!;
      if(sql.startsWith("select")) {const row=stored.get(table+":"+values[1]);return {rowCount:row?1:0,rows:row?[{record_sha256:row.record_sha256}]:[]};}
      const columns=sql.match(/\(([^)]+)\)/)![1]!.split(",");
      const row=Object.fromEntries(columns.map((c,i)=>[c,values[i]]));
      stored.set(table+":"+(row.observation_id ?? row.provenance_edge_id),row);
      expect(["observations","provenance_edges"]).toContain(table);
      return {rowCount:1,rows:[]};
    }} as unknown as DbClient;
    const first=await persistValidatedDiscovery(client,"scope",input,checked.valid!);
    const replay=await persistValidatedDiscovery(client,"scope",input,checked.valid!);
    expect(first.observations_inserted).toBe(merged.observations.length);
    expect(replay.replay).toBe(true);
    for(const [key,row] of stored) {
      if(key.startsWith("provenance_edges:"))expect(row).toMatchObject({message_id:"original-message",content_block_id:"block",representation_sha256:input.evidence[0]!.representation_sha256});
      else expect((row.payload as any).evidence_refs[0]).toMatchObject({evidence_ref:"ev-block",canonical_text:input.evidence[0]!.text,fragment:{parent_evidence_ref:"ev-block"}});
    }
  });
});
