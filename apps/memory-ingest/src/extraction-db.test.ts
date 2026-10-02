import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import type pg from "pg";
import { createPool, immutableInsert, readOnlyTransaction } from "./db.js";

const SOURCE = "claudecode-9ef4d758-4f85-44ce-bb12-9dd89fa6295d";
const enabled = Boolean(process.env.MEMORY_INGEST_DATABASE_URL && process.env.MEMORY_REPORT_DATABASE_URL && process.env.MEMORY_WORKSPACE_ID);
const suite = enabled ? describe : describe.skip;

suite("knowledge extraction database invariants", () => {
  let reader: pg.Pool;
  let writer: pg.Pool;
  const workspaceId = process.env.MEMORY_WORKSPACE_ID ?? "";

  beforeAll(() => { reader = createPool("reader"); writer = createPool("writer"); });
  afterAll(async () => { await Promise.all([reader.end(), writer.end()]); });

  it("dispatches every ordinary completed run to the preserved capture-ingestion validator", async () => {
    const rows = await readOnlyTransaction(reader, workspaceId, async (client) => (await client.query(`
      select r.ingestion_run_id,r.pipeline_version,
             memory_v1.ingestion_completion_errors(r.workspace_id,r.ingestion_run_id,r.pipeline_version) dispatched,
             memory_v1.capture_ingestion_completion_errors(r.workspace_id,r.ingestion_run_id,r.pipeline_version) preserved
      from memory_v1.ingestion_runs r
      where r.workspace_id=$1 and r.status='completed'
        and not exists (
          select 1 from memory_v1.knowledge_extraction_runs x
          where (x.workspace_id,x.extraction_run_id,x.pipeline_version)=(r.workspace_id,r.ingestion_run_id,r.pipeline_version)
        )`, [workspaceId])).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => JSON.stringify(row.dispatched) === JSON.stringify(row.preserved))).toBe(true);
  });

  it("allows sparse evidence and multiple candidates from one message when every citation resolves exactly", async () => {
    await rollbackProbe(writer, workspaceId, async (client) => {
      const probe = await seedProbe(client, workspaceId, true, 2);
      const errors = (await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [workspaceId, probe.runId, probe.pipeline])).rows[0]?.errors ?? [];
      expect(errors).toEqual([]);
      await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, probe.runId, probe.pipeline]);
      const counts = (await client.query(`select
        (select count(*)::int from memory_v1.knowledge_candidates k join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version) where ch.workspace_id=$1 and ch.ingestion_run_id=$2 and ch.pipeline_version=$3) candidates,
        (select count(*)::int from memory_v1.message_range_chunks where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3) evidence_ranges,
        (select expected_message_count from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3) source_messages`, [workspaceId, probe.runId, probe.pipeline])).rows[0];
      expect(counts).toMatchObject({ candidates: 2, evidence_ranges: 1, source_messages: 81 });
    });
  });

  it("refuses extraction completion when cited provenance lacks an exact hash resolution", async () => {
    await rollbackProbe(writer, workspaceId, async (client) => {
      const probe = await seedProbe(client, workspaceId, false, 1);
      const errors = (await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [workspaceId, probe.runId, probe.pipeline])).rows[0]?.errors ?? [];
      expect(errors).toContain("provenance_resolution_invalid");
      await expect(client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, probe.runId, probe.pipeline])).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("does not grant the extraction writer automatic review or approval authority", async () => {
    await rollbackProbe(writer, workspaceId, async (client) => {
      await client.query("savepoint review_permission_probe");
      await expect(client.query("insert into memory_v1.human_review_events default values")).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint review_permission_probe");
      await expect(client.query("insert into memory_v1.approved_knowledge default values")).rejects.toMatchObject({ code: "42501" });
    });
  });
});

async function rollbackProbe(pool: pg.Pool, workspaceId: string, callback: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    await client.query("set constraints all deferred");
    await callback(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function seedProbe(client: pg.PoolClient, workspaceId: string, resolved: boolean, candidateCount: number): Promise<{ runId: string; pipeline: string }> {
  const source = (await client.query(`
    select c.conversation_id,cv.capture_version_id,cv.manifest_sha256,cv.captured_at,
           sr.source_system_id,sr.source_account_id,
           (select count(*)::int from memory_v1.messages where workspace_id=c.workspace_id and conversation_id=c.conversation_id) message_count
    from memory_v1.conversations c
    join memory_v1.capture_versions cv on cv.workspace_id=c.workspace_id and cv.capture_version_id=c.capture_version_id
    join memory_v1.source_records sr on sr.workspace_id=cv.workspace_id and sr.source_record_id=cv.source_record_id
    where c.workspace_id=$1 and c.source_conversation_id=$2`, [workspaceId, SOURCE])).rows[0];
  const evidence = (await client.query(`
    select m.message_id,m.sequence,b.content_block_id,b.source_record_id,sr.immutable_evidence_locator,
           (select rep->>'sha256' from jsonb_array_elements(b.representations) rep where rep->>'representation_kind'='canonical_text' limit 1) representation_sha256
    from memory_v1.messages m
    join memory_v1.content_blocks b on b.workspace_id=m.workspace_id and b.message_id=m.message_id
    join memory_v1.source_records sr on sr.workspace_id=b.workspace_id and sr.source_record_id=b.source_record_id
    where m.workspace_id=$1 and m.conversation_id=$2 and m.sequence=80
      and exists (select 1 from jsonb_array_elements(b.representations) rep where rep->>'representation_kind'='canonical_text')
    order by b.sequence limit 1`, [workspaceId, source.conversation_id])).rows[0];
  const nonce = randomUUID();
  const pipeline = `memory-extract-proof/${nonce}`;
  const runNatural = [source.capture_version_id, pipeline, nonce];
  const runId = deterministicId("ingestion_run", workspaceId, runNatural);
  await client.query(`insert into memory_v1.ingestion_runs (
    workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,input_manifest_sha256,
    checkpoint_key,attempt_count,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count)
    values ($1,$2,$3,$4,$5,'running',now(),$6,'extraction-proof',1,$7,$8,$9,1)`,
    [workspaceId, runId, source.source_system_id, source.source_account_id, idempotencyKey("ingestion_run", workspaceId, runNatural),
     source.manifest_sha256, pipeline, source.message_count, candidateCount]);
  await immutableInsert(client, "knowledge_extraction_runs", "extraction_run_id", immutable("knowledge_extraction_run", workspaceId, runNatural, {
    workspace_id: workspaceId, extraction_run_id: runId, pipeline_version: pipeline,
    source_capture_version_id: source.capture_version_id, conversation_id: source.conversation_id,
    extraction_input_sha256: sha256({ nonce }), extraction_model: "proof", extractor_version: "proof",
    expected_candidate_count: candidateCount, expected_evidence_count: candidateCount,
    expected_evidence_range_count: 1, created_at: date(source.captured_at)
  }));
  const chunkNatural = [source.capture_version_id, pipeline, "evidence", [80]];
  const chunkId = deterministicId("message_range_chunk", workspaceId, chunkNatural);
  await immutableInsert(client, "message_range_chunks", "chunk_id", immutable("message_range_chunk", workspaceId, chunkNatural, {
    workspace_id: workspaceId, chunk_id: chunkId, ingestion_run_id: runId, capture_version_id: source.capture_version_id,
    pipeline_version: pipeline, start_sequence: 80, end_sequence: 80, message_ids: [evidence.message_id],
    chunk_sha256: sha256({ message_id: evidence.message_id, block_id: evidence.content_block_id, sha256: evidence.representation_sha256 })
  }));
  for (let index=0; index<candidateCount; index++) {
    const candidateNatural = [source.capture_version_id, pipeline, `candidate-${index}`];
    const candidateId = deterministicId("knowledge_candidate", workspaceId, candidateNatural);
    const proposedValue = { candidate_type: "technical_finding", statement: `Proof candidate ${index}`, source_sequences: [80] };
    await immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", immutable("knowledge_candidate", workspaceId, candidateNatural, {
      workspace_id: workspaceId, knowledge_candidate_id: candidateId, chunk_id: chunkId, pipeline_version: pipeline,
      kind: "claim", status: "proposed", proposed_value: proposedValue, proposed_value_sha256: sha256(proposedValue), created_at: date(source.captured_at)
    }));
    const edgeNatural = [pipeline,candidateId,evidence.message_id,evidence.content_block_id,"canonical_text",evidence.representation_sha256];
    const edgeId = deterministicId("provenance_edge", workspaceId, edgeNatural);
    await immutableInsert(client, "provenance_edges", "provenance_edge_id", immutable("provenance_edge", workspaceId, edgeNatural, {
      workspace_id: workspaceId, provenance_edge_id: edgeId, pipeline_version: pipeline,
      target_record_type: "knowledge_candidate", target_record_id: candidateId, relation: "quotes",
      source_record_id: evidence.source_record_id, capture_version_id: source.capture_version_id,
      conversation_id: source.conversation_id, message_id: evidence.message_id, content_block_id: evidence.content_block_id,
      representation_kind: "canonical_text", representation_sha256: evidence.representation_sha256, created_at: date(source.captured_at)
    }));
    const evidenceNatural = [pipeline,candidateId,edgeId];
    await immutableInsert(client, "candidate_evidence", "candidate_evidence_id", immutable("candidate_evidence", workspaceId, evidenceNatural, {
      workspace_id: workspaceId, candidate_evidence_id: deterministicId("candidate_evidence", workspaceId, evidenceNatural),
      pipeline_version: pipeline, knowledge_candidate_id: candidateId, provenance_edge_id: edgeId, role: "supporting"
    }));
  }
  if (resolved) {
    const resolutionNatural = [pipeline,evidence.source_record_id,evidence.immutable_evidence_locator,evidence.representation_sha256];
    await client.query(`insert into memory_v1.archive_hash_resolutions (
      workspace_id,resolution_id,source_record_id,capture_version_id,locator,expected_sha256,observed_sha256,resolved_at,pipeline_version,ingestion_run_id)
      values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
      [workspaceId,deterministicId("archive_hash_resolution",workspaceId,resolutionNatural),evidence.source_record_id,
       source.capture_version_id,evidence.immutable_evidence_locator,evidence.representation_sha256,date(source.captured_at),pipeline,runId]);
  }
  return { runId, pipeline };
}

function immutable(kind: string, workspaceId: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> {
  const body = { ...fields, idempotency_key: idempotencyKey(kind, workspaceId, natural) };
  return { ...body, record_sha256: sha256(body) };
}

function date(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
