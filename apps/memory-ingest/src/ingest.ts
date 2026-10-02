import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import type pg from "pg";
import { loadApprovedArchive, type ApprovedArchiveLocation, type CapturedMessage, type ContentBlock, type Representation, type VerifiedArchive } from "./archive.js";
import { deterministicMessageRanges } from "./chunking.js";
import { createPool, immutableInsert, readOnlyTransaction, transaction, type DbClient } from "./db.js";

export class SimulatedInterruption extends Error { constructor() { super("Simulated interruption after committed checkpoint."); } }
export class SimulatedFailure extends Error { constructor() { super("Simulated ingestion failure after committed checkpoint."); } }
export interface IngestOptions extends ApprovedArchiveLocation {
  workspaceId: string;
  pipelineVersion: string;
  retryOf?: { ingestionRunId: string; pipelineVersion: string };
  interruptAfterChunks?: number;
  failAfterChunks?: number;
}
export interface IngestResult {
  workspaceId: string;
  pipelineVersion: string;
  ingestionRunId: string;
  captureVersionId: string;
  replay: boolean;
  resumedFromChunk: number;
  completedChunks: number;
}

export async function ingestApprovedCapture(options: IngestOptions): Promise<IngestResult> {
  const archive = await loadApprovedArchive(options);
  const ids = buildIds(options.workspaceId, options.pipelineVersion, archive);
  const ranges = deterministicMessageRanges(archive.normalized.messages);
  const pool = createPool("writer");
  try {
    const existing = await readOnlyTransaction(pool, options.workspaceId, async (client) =>
      (await client.query("select status from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion])).rows[0]);
    if (existing?.status === "completed") {
      await assertCompletion(pool, options.workspaceId, ids.run, options.pipelineVersion);
      await attestCompletedGeneration(pool, options.workspaceId, ids.run, options.pipelineVersion);
      return result(options, ids, true, ranges.length, ranges.length);
    }

    await persistSourceFoundation(pool, archive, options, ids, ranges.length);
    const checkpoint = await readOnlyTransaction(pool, options.workspaceId, async (client) =>
      (await client.query("select completed_chunk_count from memory_v1.ingestion_checkpoints where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3 and checkpoint_key='message_ranges'", [options.workspaceId, ids.run, options.pipelineVersion])).rows[0]);
    const resumedFromChunk = Number(checkpoint?.completed_chunk_count ?? 0);
    for (let index = resumedFromChunk; index < ranges.length; index++) {
      await persistRange(pool, archive, options, ids, ranges[index]!);
      const completed = index + 1;
      if (options.interruptAfterChunks !== undefined && completed >= options.interruptAfterChunks) {
        await transaction(pool, options.workspaceId, async (client) => {
          await client.query("update memory_v1.ingestion_runs set status='partial',checkpoint_key='message_ranges' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion]);
        });
        throw new SimulatedInterruption();
      }
      if (options.failAfterChunks !== undefined && completed >= options.failAfterChunks) {
        await transaction(pool, options.workspaceId, async (client) => {
          await client.query("update memory_v1.ingestion_runs set status='failed',checkpoint_key='message_ranges',fatal_error_count=fatal_error_count+1 where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion]);
        });
        throw new SimulatedFailure();
      }
    }
    await assertCompletion(pool, options.workspaceId, ids.run, options.pipelineVersion);
    await transaction(pool, options.workspaceId, async (client) => {
      await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion]);
    });
    await assertCompletion(pool, options.workspaceId, ids.run, options.pipelineVersion);
    await attestCompletedGeneration(pool, options.workspaceId, ids.run, options.pipelineVersion);
    return result(options, ids, false, resumedFromChunk, ranges.length);
  } finally { await pool.end(); }
}

async function persistSourceFoundation(pool: pg.Pool, archive: VerifiedArchive, options: IngestOptions, ids: ReturnType<typeof buildIds>, expectedChunks: number): Promise<void> {
  await transaction(pool, options.workspaceId, async (client) => {
    const n = archive.normalized;
    await immutableInsert(client, "workspaces", "workspace_id", immutable("workspace", options.workspaceId, options.workspaceId, { workspace_id: options.workspaceId, name: "HHS Memory Vertical Slice V1", isolation_key: options.workspaceId, status: "active" }));
    const priorSystem = await client.query("select kind from memory_v1.source_systems where workspace_id=$1 and source_system_id=$2", [options.workspaceId, ids.system]);
    if (!priorSystem.rowCount) {
      await immutableInsert(client, "source_systems", "source_system_id", immutable("source_system", options.workspaceId, n.platform.id, { workspace_id: options.workspaceId, source_system_id: ids.system, kind: "ai_conversation_archive", adapter_contract: `${n.platform.id}/${n.capture.adapter_version}` }));
    } else if (priorSystem.rows[0]?.kind !== "ai_conversation_archive") {
      throw new Error("Existing source system is not the ChatGPT conversation archive source.");
    }
    await immutableInsert(client, "source_accounts", "source_account_id", immutable("source_account", options.workspaceId, n.account.opaque_account_reference, { workspace_id: options.workspaceId, source_account_id: ids.account, source_system_id: ids.system, opaque_account_reference: n.account.opaque_account_reference }));
    const inserted = await client.query(`insert into memory_v1.ingestion_runs (
      workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,input_manifest_sha256,
      checkpoint_key,attempt_count,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count,
      retry_of_ingestion_run_id,retry_of_pipeline_version)
      values ($1,$2,$3,$4,$5,'running',now(),$6,'source_foundation',1,$7,$8,$9,$10,$11,$12)
      on conflict (workspace_id,ingestion_run_id) do nothing`,
      [options.workspaceId, ids.run, ids.system, ids.account, idempotencyKey("ingestion_run", options.workspaceId, [n.capture.capture_id, options.pipelineVersion]), archive.manifestSha256, options.pipelineVersion, n.messages.length, blockCount(n.messages), expectedChunks, options.retryOf?.ingestionRunId ?? null, options.retryOf?.pipelineVersion ?? null]);
    if (!inserted.rowCount) {
      const prior = await client.query("select status,input_manifest_sha256,retry_of_ingestion_run_id,retry_of_pipeline_version from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion]);
      if (!prior.rowCount || prior.rows[0]?.input_manifest_sha256 !== archive.manifestSha256) throw new Error("Pipeline generation identity collision.");
      if ((prior.rows[0]?.retry_of_ingestion_run_id ?? null) !== (options.retryOf?.ingestionRunId ?? null)
        || (prior.rows[0]?.retry_of_pipeline_version ?? null) !== (options.retryOf?.pipelineVersion ?? null)) throw new Error("Pipeline generation retry lineage collision.");
      if (!new Set(["running", "partial"]).has(String(prior.rows[0]?.status))) throw new Error(`Pipeline generation cannot resume from ${String(prior.rows[0]?.status)}.`);
      await client.query("update memory_v1.ingestion_runs set status='running',attempt_count=attempt_count+1 where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [options.workspaceId, ids.run, options.pipelineVersion]);
    }

    const priorCapture = await client.query("select manifest_sha256 from memory_v1.capture_versions where workspace_id=$1 and capture_version_id=$2", [options.workspaceId, ids.capture]);
    if (priorCapture.rowCount && priorCapture.rows[0]?.manifest_sha256 !== archive.manifestSha256) throw new Error("Existing capture version does not match the approved archive manifest.");
    if (!priorCapture.rowCount) await insertCaptureFoundation(client, archive, options.workspaceId, ids);
    else await validateExistingCaptureFoundation(client, archive, options.workspaceId, ids);

    await insertResolution(client, options, ids, ids.conversationSource, "capture-manifest.json", archive.manifestSha256, archive.manifestSha256, n.capture.completed_at);
    for (const message of n.messages) {
      const hash = sourceHash(message.representations);
      await insertResolution(client, options, ids, sourceRecordId(options.workspaceId, "message", message.message_id), `message:${message.message_id}:canonical`, hash, sha256(canonicalValue(message.representations)), n.capture.completed_at);
      for (const block of message.content_blocks) {
        const blockHash = sourceHash(block.representations);
        await insertResolution(client, options, ids, sourceRecordId(options.workspaceId, "content_block", blockNatural(message, block)), `message:${message.message_id}:block:${block.block_id}:canonical`, blockHash, sha256(canonicalValue(block.representations)), n.capture.completed_at);
      }
    }
  });
}

async function insertCaptureFoundation(client: DbClient, archive: VerifiedArchive, workspaceId: string, ids: ReturnType<typeof buildIds>): Promise<void> {
  const n = archive.normalized;
  await immutableInsert(client, "source_records", "source_record_id", sourceRecord(archive, workspaceId, ids, "conversation", n.conversation.conversation_id, archive.manifestSha256, "capture-manifest.json#/conversation"));
  for (const message of n.messages) {
    await immutableInsert(client, "source_records", "source_record_id", sourceRecord(archive, workspaceId, ids, "message", message.message_id, sourceHash(message.representations), `normalized/conversation.json#/messages/${message.sequence}`));
    for (const block of message.content_blocks) await immutableInsert(client, "source_records", "source_record_id", sourceRecord(archive, workspaceId, ids, "content_block", blockNatural(message, block), sourceHash(block.representations), `normalized/conversation.json#/messages/${message.sequence}/content_blocks/${block.sequence}`));
  }
  await immutableInsert(client, "capture_versions", "capture_version_id", immutable("capture_version", workspaceId, n.capture.capture_id, {
    workspace_id: workspaceId, capture_version_id: ids.capture, source_record_id: ids.conversationSource, conversation_id: ids.conversation,
    immutable_archive_locator: `hhs-archive://capture/${n.capture.capture_id}`, manifest_sha256: archive.manifestSha256,
    verification_status: "complete", captured_at: n.capture.completed_at
  }));
  await immutableInsert(client, "conversations", "conversation_id", immutable("conversation", workspaceId, n.conversation.conversation_id, {
    workspace_id: workspaceId, conversation_id: ids.conversation, source_record_id: ids.conversationSource, capture_version_id: ids.capture,
    source_conversation_id: n.conversation.conversation_id,
    title_representation: { representation_kind: "canonical_text", value: n.conversation.title, sha256: sha256(n.conversation.title), evidence_locator: `hhs-archive://capture/${n.capture.capture_id}/manifest#/conversation/title` }
  }));
  for (const message of n.messages) {
    const messageId = messageDbId(workspaceId, message);
    await immutableInsert(client, "messages", "message_id", immutable("message", workspaceId, message.message_id, {
      workspace_id: workspaceId, message_id: messageId, source_record_id: sourceRecordId(workspaceId, "message", message.message_id),
      conversation_id: ids.conversation, capture_version_id: ids.capture, source_message_id: message.message_id,
      sequence: message.sequence, role: mapRole(message.role), parent_message_id: message.parent_message_id ? deterministicId("message", workspaceId, message.parent_message_id) : null,
      active_path: true, representations: message.representations.map(mapRepresentation)
    }));
    for (const block of message.content_blocks) await immutableInsert(client, "content_blocks", "content_block_id", immutable("content_block", workspaceId, blockNatural(message, block), {
      workspace_id: workspaceId, content_block_id: blockDbId(workspaceId, message, block), source_record_id: sourceRecordId(workspaceId, "content_block", blockNatural(message, block)),
      message_id: messageId, capture_version_id: ids.capture, sequence: block.sequence, block_kind: block.type, representations: block.representations.map(mapRepresentation)
    }));
  }
  await immutableInsert(client, "verification_results", "verification_result_id", immutable("verification_result", workspaceId, n.capture.capture_id, {
    workspace_id: workspaceId, verification_result_id: deterministicId("verification_result", workspaceId, n.capture.capture_id), capture_version_id: ids.capture,
    ruleset_version: n.verification.ruleset_version, status: "complete", checks: n.verification.checks, warnings: n.verification.warnings ?? []
  }));
}

async function validateExistingCaptureFoundation(client: DbClient, archive: VerifiedArchive, workspaceId: string, ids: ReturnType<typeof buildIds>): Promise<void> {
  const counts = await client.query(`select
    (select count(*) from memory_v1.messages where workspace_id=$1 and capture_version_id=$2) messages,
    (select count(*) from memory_v1.content_blocks where workspace_id=$1 and capture_version_id=$2) blocks,
    (select count(*) from memory_v1.source_records where workspace_id=$1 and record_kind in ('conversation','message','content_block')) sources`, [workspaceId, ids.capture]);
  const row = counts.rows[0];
  if (Number(row?.messages) !== archive.normalized.messages.length || Number(row?.blocks) !== blockCount(archive.normalized.messages)
    || Number(row?.sources) < 1 + archive.normalized.messages.length + blockCount(archive.normalized.messages)) throw new Error("Existing capture foundation is incomplete.");
}

async function persistRange(pool: pg.Pool, archive: VerifiedArchive, options: IngestOptions, ids: ReturnType<typeof buildIds>, range: ReturnType<typeof deterministicMessageRanges>[number]): Promise<void> {
  await transaction(pool, options.workspaceId, async (client) => {
    const natural = [archive.normalized.capture.capture_id, options.pipelineVersion, range.start, range.end];
    const chunkId = deterministicId("message_range_chunk", options.workspaceId, natural);
    await immutableInsert(client, "message_range_chunks", "chunk_id", immutable("message_range_chunk", options.workspaceId, natural, {
      workspace_id: options.workspaceId, chunk_id: chunkId, ingestion_run_id: ids.run, capture_version_id: ids.capture, pipeline_version: options.pipelineVersion,
      start_sequence: range.start, end_sequence: range.end, message_ids: range.messages.map((message) => messageDbId(options.workspaceId, message)), chunk_sha256: range.sha256
    }));
    const candidateId = deterministicId("knowledge_candidate", options.workspaceId, natural);
    const proposedValue = { candidate_type: "message_range", capture_id: archive.normalized.capture.capture_id, pipeline_version: options.pipelineVersion, start_sequence: range.start, end_sequence: range.end, message_ids: range.messages.map((message) => message.message_id), chunk_sha256: range.sha256 };
    await immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", immutable("knowledge_candidate", options.workspaceId, natural, {
      workspace_id: options.workspaceId, knowledge_candidate_id: candidateId, chunk_id: chunkId, pipeline_version: options.pipelineVersion,
      kind: "idea", status: "proposed", proposed_value: proposedValue, proposed_value_sha256: sha256(proposedValue), created_at: archive.normalized.capture.completed_at
    }));
    for (const message of range.messages) for (const block of message.content_blocks) {
      const representation = preferred(block.representations);
      const edgeNatural = [options.pipelineVersion, candidateId, message.message_id, block.block_id, representation.kind, representation.sha256];
      const edgeId = deterministicId("provenance_edge", options.workspaceId, edgeNatural);
      await immutableInsert(client, "provenance_edges", "provenance_edge_id", immutable("provenance_edge", options.workspaceId, edgeNatural, {
        workspace_id: options.workspaceId, provenance_edge_id: edgeId, pipeline_version: options.pipelineVersion,
        target_record_type: "knowledge_candidate", target_record_id: candidateId, relation: "derived_from",
        source_record_id: sourceRecordId(options.workspaceId, "content_block", blockNatural(message, block)), capture_version_id: ids.capture,
        conversation_id: ids.conversation, message_id: messageDbId(options.workspaceId, message), content_block_id: blockDbId(options.workspaceId, message, block),
        representation_kind: representation.kind, representation_sha256: representation.sha256, created_at: archive.normalized.capture.completed_at
      }));
      const evidenceNatural = [options.pipelineVersion, candidateId, edgeId];
      await immutableInsert(client, "candidate_evidence", "candidate_evidence_id", immutable("candidate_evidence", options.workspaceId, evidenceNatural, {
        workspace_id: options.workspaceId, candidate_evidence_id: deterministicId("candidate_evidence", options.workspaceId, evidenceNatural), pipeline_version: options.pipelineVersion,
        knowledge_candidate_id: candidateId, provenance_edge_id: edgeId, role: "supporting"
      }));
    }
    const completedChunkCount = Math.floor(range.end / 5) + 1;
    const checkpointState = { pipeline_version: options.pipelineVersion, next_message_sequence: range.end + 1, completed_chunk_count: completedChunkCount };
    await client.query(`insert into memory_v1.ingestion_checkpoints (workspace_id,checkpoint_id,ingestion_run_id,checkpoint_key,next_message_sequence,completed_chunk_count,state_sha256,updated_at,pipeline_version)
      values ($1,$2,$3,'message_ranges',$4,$5,$6,now(),$7)
      on conflict (workspace_id,checkpoint_id) do update set next_message_sequence=excluded.next_message_sequence,completed_chunk_count=excluded.completed_chunk_count,state_sha256=excluded.state_sha256,updated_at=excluded.updated_at`,
      [options.workspaceId, deterministicId("ingestion_checkpoint", options.workspaceId, [ids.run, options.pipelineVersion]), ids.run, range.end + 1, completedChunkCount, sha256(checkpointState), options.pipelineVersion]);
  });
}

export async function quarantineInvalidEvidence(options: IngestOptions, fatal = false): Promise<string> {
  const archive = await loadApprovedArchive(options);
  const ids = buildIds(options.workspaceId, options.pipelineVersion, archive);
  const expected = "0".repeat(64); const observed = archive.manifestSha256;
  if (expected === observed) throw new Error("Invalid-evidence probe unexpectedly matched.");
  const natural = [archive.normalized.capture.capture_id, options.pipelineVersion, "invalid-evidence-probe", expected, observed];
  const quarantineId = deterministicId("quarantine_item", options.workspaceId, natural);
  const pool = createPool("writer");
  try {
    await transaction(pool, options.workspaceId, async (client) => {
      await immutableInsert(client, "quarantine_items", "quarantine_item_id", immutable("quarantine_item", options.workspaceId, natural, {
        workspace_id: options.workspaceId, quarantine_item_id: quarantineId, ingestion_run_id: ids.run, source_record_id: ids.conversationSource,
        pipeline_version: options.pipelineVersion, reason_code: "evidence_hash_mismatch", payload_sha256: sha256({ locator: "capture-manifest.json", expected, observed }), status: "open", fatal
      }));
    });
    return quarantineId;
  } finally { await pool.end(); }
}

export async function completionErrors(workspaceId: string, ingestionRunId: string, pipelineVersion: string): Promise<string[]> {
  const pool = createPool("writer");
  try { return await readOnlyTransaction(pool, workspaceId, async (client) => (await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [workspaceId, ingestionRunId, pipelineVersion])).rows[0]?.errors ?? []); }
  finally { await pool.end(); }
}

async function assertCompletion(pool: pg.Pool, workspaceId: string, ingestionRunId: string, pipelineVersion: string): Promise<void> {
  const errors = await readOnlyTransaction(pool, workspaceId, async (client) => (await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [workspaceId, ingestionRunId, pipelineVersion])).rows[0]?.errors ?? []);
  if (errors.length) throw new Error(`Ingestion completion invariants failed: ${errors.join(",")}`);
}

async function attestCompletedGeneration(pool: pg.Pool, workspaceId: string, ingestionRunId: string, pipelineVersion: string): Promise<void> {
  await transaction(pool, workspaceId, async (client) => {
    const run = await client.query("select expected_content_block_count from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, ingestionRunId, pipelineVersion]);
    // A valid capture may contain messages but no extracted content blocks. Its
    // completion contract still passes, but the legacy provenance attestation
    // aggregates provenance edges and cannot hash an empty set.
    if (Number(run.rows[0]?.expected_content_block_count ?? 0) === 0) return;
    await client.query("select memory_v1.attest_completed_generation($1,$2,$3)", [workspaceId, ingestionRunId, pipelineVersion]);
  });
}

export function buildIds(workspaceId: string, pipelineVersion: string, archive: VerifiedArchive) {
  const n = archive.normalized;
  return {
    system: deterministicId("source_system", workspaceId, n.platform.id),
    account: deterministicId("source_account", workspaceId, n.account.opaque_account_reference),
    run: deterministicId("ingestion_run", workspaceId, [n.capture.capture_id, pipelineVersion]),
    conversationSource: sourceRecordId(workspaceId, "conversation", n.conversation.conversation_id),
    capture: deterministicId("capture_version", workspaceId, n.capture.capture_id),
    conversation: deterministicId("conversation", workspaceId, n.conversation.conversation_id)
  };
}

function result(options: IngestOptions, ids: ReturnType<typeof buildIds>, replay: boolean, resumedFromChunk: number, completedChunks: number): IngestResult {
  return { workspaceId: options.workspaceId, pipelineVersion: options.pipelineVersion, ingestionRunId: ids.run, captureVersionId: ids.capture, replay, resumedFromChunk, completedChunks };
}
function sourceRecord(archive: VerifiedArchive, workspaceId: string, ids: ReturnType<typeof buildIds>, kind: "conversation"|"message"|"content_block", nativeId: string, sourceSha: string, locator: string) {
  return immutable("source_record", workspaceId, [kind, nativeId], { workspace_id: workspaceId, source_record_id: sourceRecordId(workspaceId, kind, nativeId), ingestion_run_id: ids.run, source_system_id: ids.system, source_account_id: ids.account, source_native_id: nativeId, record_kind: kind, immutable_evidence_locator: `hhs-archive://capture/${archive.normalized.capture.capture_id}/${locator}`, source_sha256: sourceSha, observed_at: archive.normalized.capture.completed_at });
}
async function insertResolution(client: DbClient, options: IngestOptions, ids: ReturnType<typeof buildIds>, sourceRecord: string, locator: string, expected: string, observed: string, at: string) {
  const resolutionId = deterministicId("archive_hash_resolution", options.workspaceId, [options.pipelineVersion, sourceRecord, locator, expected]);
  const prior = await client.query("select expected_sha256,observed_sha256 from memory_v1.archive_hash_resolutions where workspace_id=$1 and resolution_id=$2", [options.workspaceId, resolutionId]);
  if (prior.rowCount) {
    if (prior.rows[0]?.expected_sha256 !== expected || prior.rows[0]?.observed_sha256 !== observed) throw new Error(`Hash-resolution collision for ${resolutionId}.`);
    return;
  }
  await client.query("insert into memory_v1.archive_hash_resolutions (workspace_id,resolution_id,source_record_id,capture_version_id,locator,expected_sha256,observed_sha256,resolved_at,pipeline_version,ingestion_run_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [options.workspaceId, resolutionId, sourceRecord, ids.capture, locator, expected, observed, at, options.pipelineVersion, ids.run]);
}
function immutable(kind: string, workspaceId: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> { const body = { ...fields, idempotency_key: idempotencyKey(kind, workspaceId, natural) }; return { ...body, record_sha256: sha256(body) }; }
function blockCount(messages: CapturedMessage[]): number { return messages.reduce((total, message) => total + message.content_blocks.length, 0); }
function sourceRecordId(workspaceId: string, kind: string, nativeId: string): string { return deterministicId("source_record", workspaceId, [kind, nativeId]); }
function messageDbId(workspaceId: string, message: CapturedMessage): string { return deterministicId("message", workspaceId, message.message_id); }
function blockNatural(message: CapturedMessage, block: ContentBlock): string { return `${message.message_id}:block:${block.block_id}`; }
function blockDbId(workspaceId: string, message: CapturedMessage, block: ContentBlock): string { return deterministicId("content_block", workspaceId, blockNatural(message, block)); }
function mapRepresentation(item: Representation) { return { representation_kind: item.kind, value: item.value, sha256: item.sha256, evidence_locator: item.evidence_locator }; }
function preferred(items: Representation[]): Representation { const item = items.find((entry) => entry.kind === "canonical_text") ?? items[0]; if (!item) throw new Error("Source representation is missing."); return item; }
function canonicalValue(items: Representation[]): string { return preferred(items).value; }
function sourceHash(items: Representation[]): string { return preferred(items).sha256; }
function mapRole(role: string): string { return role === "system" ? "system_visible" : new Set(["user","assistant","tool","system_visible"]).has(role) ? role : "unknown"; }
