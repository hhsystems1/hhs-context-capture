import { idempotencyKey, sha256 } from "@hhs/memory-schema";
import type { MemoryConfig } from "./config.js";
import { loadApprovedArchive } from "./archive.js";
import { createPool, readOnlyTransaction, transaction } from "./db.js";
import { buildIds, ingestApprovedCapture, quarantineInvalidEvidence, SimulatedFailure, SimulatedInterruption, type IngestOptions } from "./ingest.js";
import { archiveTreeSha256, verifyProofRoot, writeAndPersistProofReceipt, type ProofKind, type StoredProofReceipt } from "./proof-receipts.js";
import { readOnlyReport } from "./report.js";

export async function proveVerticalSlice(config: MemoryConfig): Promise<Record<string, unknown>> {
  const base = options(config, config.pipelineVersion);
  const archive = await loadApprovedArchive(base);
  const treeBefore = await archiveTreeSha256(config.approvedCapturePath);
  const baseIds = buildIds(config.workspaceId, config.pipelineVersion, archive);
  const receipts: StoredProofReceipt[] = [];
  const receipt = async (proofKind: ProofKind, pipelineVersion: string, ingestionRunId: string, assertions: Record<string, unknown>) => {
    const value = await writeAndPersistProofReceipt({ proofRoot: config.proofRoot, proofKind, workspaceId: config.workspaceId, ingestionRunId, pipelineVersion, captureId: config.approvedCaptureId, archiveTreeSha256: treeBefore, assertions });
    receipts.push(value); return value;
  };

  const first = await ingestApprovedCapture(base);
  await receipt("clean_first_ingestion", base.pipelineVersion, first.ingestionRunId, {
    passed: true, replay: first.replay, resumed_from_chunk: first.resumedFromChunk, completed_chunks: first.completedChunks,
    completion_errors: await completionErrors(base)
  });

  const beforeReplay = await immutableGenerationSnapshot(base);
  const replay = await ingestApprovedCapture(base);
  const afterReplay = await immutableGenerationSnapshot(base);
  if (!replay.replay || JSON.stringify(beforeReplay) !== JSON.stringify(afterReplay)) throw new Error("Idempotent replay changed the pipeline generation.");
  await receipt("idempotent_replay", base.pipelineVersion, replay.ingestionRunId, { passed: true, unchanged_generation_snapshot: afterReplay });

  const interrupted = await proveInterruptedResume(config, archive, treeBefore, receipt);
  const isolation = await proveWorkspaceIsolation(config.workspaceId);
  await receipt("workspace_isolation", base.pipelineVersion, baseIds.run, isolation);

  const quarantineId = await quarantineInvalidEvidence(base, false);
  await receipt("invalid_evidence_quarantine", base.pipelineVersion, baseIds.run, { passed: true, quarantine_item_id: quarantineId, fatal: false });

  const failure = await proveFailureCannotComplete(config, archive);
  await receipt("failure_cannot_complete", failure.pipelineVersion, failure.ingestionRunId, failure.assertions);

  const coexistence = await proveChangedPipeline(config, archive, base);
  await receipt("changed_pipeline_coexistence", coexistence.pipelineVersion, coexistence.ingestionRunId, coexistence.assertions);

  const immutable = await proveImmutabilityAndRoles(config.workspaceId, coexistence.pipelineVersion);
  await receipt("database_immutability", coexistence.pipelineVersion, coexistence.ingestionRunId, immutable);

  const integrity = await proveIntegrity(config.workspaceId, [base.pipelineVersion, coexistence.pipelineVersion]);
  await receipt("exact_provenance_resolution", base.pipelineVersion, baseIds.run, integrity);

  const treeAfter = await archiveTreeSha256(config.approvedCapturePath);
  if (treeAfter !== treeBefore) throw new Error("Approved source capture changed during V1.1 proofs.");
  const receiptVerification = await verifyProofRoot(config.proofRoot);
  if (receiptVerification.failures.length || receiptVerification.verified !== receiptVerification.receiptDirectories) throw new Error("Durable proof receipt verification failed.");
  const report = await readOnlyReport(config.workspaceId);
  return {
    status: "passed",
    schema_version: "memory-v1.1/1.1.0",
    archive: { unchanged: true, tree_sha256: treeAfter },
    receipts: receipts.map((item) => ({ proof_kind: item.proofKind, directory: item.directory, receipt_sha256: item.receiptSha256, manifest_sha256: item.manifestSha256 })),
    receipt_verification: receiptVerification,
    proofs: { clean_first_ingestion: first, idempotent_replay: replay, interrupted_run_resume: interrupted, workspace_isolation: isolation, invalid_evidence_quarantine: { passed: true, quarantine_item_id: quarantineId }, failure_cannot_complete: failure.assertions, changed_pipeline_coexistence: coexistence.assertions, database_immutability: immutable, exact_provenance_resolution: integrity },
    report
  };
}

async function proveInterruptedResume(config: MemoryConfig, archive: Awaited<ReturnType<typeof loadApprovedArchive>>, tree: string, persist: (kind: ProofKind, pipeline: string, run: string, assertions: Record<string, unknown>) => Promise<StoredProofReceipt>) {
  const pipelineVersion = proofPipeline(config.pipelineVersion, "resume-safety-proof");
  const input = options(config, pipelineVersion);
  const ids = buildIds(config.workspaceId, pipelineVersion, archive);
  const state = await runState(config.workspaceId, ids.run, pipelineVersion);
  if (state?.status === "completed") {
    const priorReceipts = await proofReceiptCount(config.workspaceId, "interrupted_resume", pipelineVersion);
    if (!priorReceipts) throw new Error("Completed resume proof generation has no prior durable receipt.");
    return { passed: true, replay_verified_from_prior_receipt: true, checkpoint_chunks: 2, resumed_from_chunk: 2, completed_chunks: 6 };
  }
  let interrupted = false;
  try { await ingestApprovedCapture({ ...input, interruptAfterChunks: 2 }); }
  catch (error) { if (error instanceof SimulatedInterruption) interrupted = true; else throw error; }
  if (!interrupted) throw new Error("Interruption proof did not interrupt.");
  const checkpoint = await checkpointState(config.workspaceId, ids.run, pipelineVersion);
  if (checkpoint.completedChunkCount !== 2 || checkpoint.nextMessageSequence !== 10) throw new Error("Interrupted checkpoint was not durable at chunk 2.");
  const prematureCompletionRejected = await attemptCompletion(config.workspaceId, ids.run, pipelineVersion);
  if (!prematureCompletionRejected) throw new Error("Interrupted run was accepted as complete.");
  const resumed = await ingestApprovedCapture(input);
  if (resumed.resumedFromChunk !== 2) throw new Error("Resume did not continue from durable checkpoint 2.");
  const assertions = { passed: true, checkpoint_chunks: 2, checkpoint_next_message: 10, interrupted_completion_rejected: true, resumed_from_chunk: resumed.resumedFromChunk, completed_chunks: resumed.completedChunks, archive_tree_sha256: tree };
  await persist("interrupted_resume", pipelineVersion, ids.run, assertions);
  return assertions;
}

async function proveWorkspaceIsolation(workspaceId: string): Promise<Record<string, unknown>> {
  const pool = createPool("writer");
  const foreignSystem = await readOnlyTransaction(pool, workspaceId, async (client) => String((await client.query("select source_system_id from memory_v1.source_systems where workspace_id=$1 limit 1", [workspaceId])).rows[0]?.source_system_id));
  const other = `workspace_isolation_probe_${sha256(new Date().toISOString()).slice(0, 10)}`;
  let rejected = false; let code = "";
  try {
    await transaction(pool, other, async (client) => {
      const body = { workspace_id: other, name: "Isolation probe", isolation_key: other, status: "active", idempotency_key: idempotencyKey("workspace", other, other) };
      await client.query("insert into memory_v1.workspaces (workspace_id,name,isolation_key,status,idempotency_key,record_sha256) values ($1,$2,$3,$4,$5,$6)", [other, body.name, body.isolation_key, body.status, body.idempotency_key, sha256(body)]);
      await client.query("insert into memory_v1.source_accounts (workspace_id,source_account_id,source_system_id,idempotency_key,record_sha256,opaque_account_reference) values ($1,'probe',$2,$3,$4,'probe')", [other, foreignSystem, "a".repeat(64), "b".repeat(64)]);
    });
  } catch (error) { code = sqlState(error); rejected = code === "23503"; }
  finally { await pool.end(); }
  if (!rejected) throw new Error(`Cross-workspace reference was not rejected by the expected foreign key (${code}).`);
  return { passed: true, database_error: "foreign_key_violation", rolled_back: true };
}

async function proveFailureCannotComplete(config: MemoryConfig, archive: Awaited<ReturnType<typeof loadApprovedArchive>>) {
  const pipelineVersion = proofPipeline(config.pipelineVersion, "failure-proof");
  const input = options(config, pipelineVersion);
  const ids = buildIds(config.workspaceId, pipelineVersion, archive);
  const existing = await runState(config.workspaceId, ids.run, pipelineVersion);
  if (!existing) {
    let failed = false;
    try { await ingestApprovedCapture({ ...input, failAfterChunks: 1 }); }
    catch (error) { if (error instanceof SimulatedFailure) failed = true; else throw error; }
    if (!failed) throw new Error("Failure proof did not fail.");
  }
  const pool = createPool("writer"); let rejected = false;
  try {
    await transaction(pool, config.workspaceId, async (client) => {
      await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [config.workspaceId, ids.run, pipelineVersion]);
    });
  } catch (error) { rejected = sqlState(error) === "23514"; }
  finally { await pool.end(); }
  const state = await runState(config.workspaceId, ids.run, pipelineVersion);
  if (!rejected || state?.status === "completed") throw new Error("Failed run was accepted as complete.");
  const fatalQuarantine = await proveFatalQuarantineCannotComplete(config, archive);
  return { pipelineVersion, ingestionRunId: ids.run, assertions: { passed: true, completion_rejected: true, database_error: "check_violation", terminal_status: state?.status, fatal_error_count: state?.fatal_error_count, fatal_quarantine: fatalQuarantine } };
}

async function proveFatalQuarantineCannotComplete(config: MemoryConfig, archive: Awaited<ReturnType<typeof loadApprovedArchive>>) {
  const pipelineVersion = proofPipeline(config.pipelineVersion, "fatal-quarantine-proof");
  const input = options(config, pipelineVersion);
  const ids = buildIds(config.workspaceId, pipelineVersion, archive);
  const existing = await runState(config.workspaceId, ids.run, pipelineVersion);
  if (!existing) {
    try { await ingestApprovedCapture({ ...input, interruptAfterChunks: 1 }); }
    catch (error) { if (!(error instanceof SimulatedInterruption)) throw error; }
    await quarantineInvalidEvidence(input, true);
  }
  const rejected = await attemptCompletion(config.workspaceId, ids.run, pipelineVersion);
  const state = await runState(config.workspaceId, ids.run, pipelineVersion);
  if (!rejected || state?.status !== "quarantined") throw new Error("Fatal-quarantined run was accepted as complete.");
  return { passed: true, pipeline_version: pipelineVersion, terminal_status: state.status, completion_rejected: true };
}

async function proveChangedPipeline(config: MemoryConfig, archive: Awaited<ReturnType<typeof loadApprovedArchive>>, base: IngestOptions) {
  const pipelineVersion = proofPipeline(config.pipelineVersion, "coexistence-proof");
  const input = options(config, pipelineVersion);
  const baseBefore = await immutableGenerationSnapshot(base);
  const result = await ingestApprovedCapture(input);
  const baseAfter = await immutableGenerationSnapshot(base);
  if (JSON.stringify(baseBefore) !== JSON.stringify(baseAfter)) throw new Error("Changed pipeline modified the earlier generation.");
  const alternate = await immutableGenerationSnapshot(input);
  const baseIds = buildIds(config.workspaceId, base.pipelineVersion, archive);
  const alternateIds = buildIds(config.workspaceId, pipelineVersion, archive);
  if (baseIds.run === alternateIds.run || alternate.candidates !== 6 || alternate.edges !== 450) throw new Error("Changed pipeline did not create a separate complete generation.");
  return { pipelineVersion, ingestionRunId: result.ingestionRunId, assertions: { passed: true, earlier_generation_unchanged: true, distinct_ingestion_run: true, pipeline_versions: [base.pipelineVersion, pipelineVersion], alternate_generation: alternate } };
}

async function proveImmutabilityAndRoles(workspaceId: string, pipelineVersion: string): Promise<Record<string, unknown>> {
  const writer = createPool("writer"); let writerUpdateRejected = false; let writerDeleteRejected = false;
  try {
    try { await transaction(writer, workspaceId, async (client) => { await client.query("update memory_v1.content_blocks set block_kind='mutation_probe' where workspace_id=$1 and content_block_id=(select content_block_id from memory_v1.content_blocks where workspace_id=$1 limit 1)", [workspaceId]); }); }
    catch (error) { writerUpdateRejected = new Set(["42501","55000"]).has(sqlState(error)); }
    try { await transaction(writer, workspaceId, async (client) => { await client.query("delete from memory_v1.knowledge_candidates where workspace_id=$1 and pipeline_version=$2", [workspaceId, pipelineVersion]); }); }
    catch (error) { writerDeleteRejected = new Set(["42501","55000"]).has(sqlState(error)); }
  } finally { await writer.end(); }
  const admin = createPool("admin"); let triggerUpdateRejected = false; let triggerDeleteRejected = false;
  const adminClient = await admin.connect();
  try {
    try { await adminClient.query("begin"); await adminClient.query("update memory_v1.content_blocks set block_kind='mutation_probe' where workspace_id=$1 and content_block_id=(select content_block_id from memory_v1.content_blocks where workspace_id=$1 limit 1)", [workspaceId]); }
    catch (error) { triggerUpdateRejected = sqlState(error) === "55000"; }
    finally { await adminClient.query("rollback"); }
    try { await adminClient.query("begin"); await adminClient.query("delete from memory_v1.knowledge_candidates where workspace_id=$1 and pipeline_version=$2", [workspaceId, pipelineVersion]); }
    catch (error) { triggerDeleteRejected = sqlState(error) === "55000"; }
    finally { await adminClient.query("rollback"); }
  } finally { adminClient.release(); await admin.end(); }
  const reader = createPool("reader"); let readerWriteRejected = false; let readerRole = "";
  const client = await reader.connect();
  try {
    await client.query("begin"); await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    readerRole = String((await client.query("select current_user")).rows[0]?.current_user);
    await client.query("insert into memory_v1.workspaces (workspace_id,name,isolation_key,status,idempotency_key,record_sha256) values ('reader_probe','probe','reader_probe','active',$1,$2)", ["a".repeat(64), "b".repeat(64)]);
  } catch (error) { readerWriteRejected = sqlState(error) === "42501"; }
  finally { await client.query("rollback"); client.release(); await reader.end(); }
  if (!writerUpdateRejected || !writerDeleteRejected || !triggerUpdateRejected || !triggerDeleteRejected || !readerWriteRejected || readerRole !== "memory_v1_report_login") throw new Error("Database immutability or least-privilege role proof failed.");
  return { passed: true, writer_update_rejected: true, writer_delete_rejected: true, immutable_trigger_update_rejected: true, immutable_trigger_delete_rejected: true, report_reader_write_rejected: true, report_reader_role_verified: true };
}

async function proveIntegrity(workspaceId: string, pipelines: string[]): Promise<Record<string, unknown>> {
  const pool = createPool("reader");
  try {
    const rows = await readOnlyTransaction(pool, workspaceId, async (client) => (await client.query(`select r.pipeline_version,
      (select count(*) from memory_v1.provenance_edges p where p.workspace_id=r.workspace_id and p.pipeline_version=r.pipeline_version) edges,
      (select count(*) from memory_v1.provenance_edges p join memory_v1.content_blocks b on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
        join memory_v1.archive_hash_resolutions a on a.workspace_id=b.workspace_id and a.source_record_id=b.source_record_id and a.capture_version_id=b.capture_version_id and a.pipeline_version=p.pipeline_version and a.expected_sha256=p.representation_sha256 and a.exact_match
        where p.workspace_id=r.workspace_id and p.pipeline_version=r.pipeline_version and b.representations @> jsonb_build_array(jsonb_build_object('representation_kind',p.representation_kind,'sha256',p.representation_sha256))) resolved_edges,
      (select count(*) from memory_v1.archive_hash_resolutions a where a.workspace_id=r.workspace_id and a.ingestion_run_id=r.ingestion_run_id and a.pipeline_version=r.pipeline_version and a.exact_match) exact_resolutions,
      cardinality(memory_v1.ingestion_completion_errors(r.workspace_id,r.ingestion_run_id,r.pipeline_version)) completion_errors
      from memory_v1.ingestion_runs r where r.workspace_id=$1 and r.pipeline_version=any($2::text[]) order by r.pipeline_version`, [workspaceId, pipelines])).rows);
    if (rows.length !== pipelines.length || rows.some((row) => Number(row.edges) !== 450 || Number(row.resolved_edges) !== 450 || Number(row.exact_resolutions) !== 481 || Number(row.completion_errors) !== 0)) throw new Error("Exact provenance integrity proof failed.");
    return { passed: true, generations: rows.map((row) => ({ pipeline_version: row.pipeline_version, provenance_edges: Number(row.edges), resolved_edges: Number(row.resolved_edges), exact_archive_hash_resolutions: Number(row.exact_resolutions), completion_errors: Number(row.completion_errors) })) };
  } finally { await pool.end(); }
}

async function immutableGenerationSnapshot(input: IngestOptions): Promise<Record<string, number | string>> {
  const pool = createPool("reader");
  try { return await readOnlyTransaction(pool, input.workspaceId, async (client) => {
    const row = (await client.query(`select r.status,r.attempt_count,
      (select count(*) from memory_v1.message_range_chunks where workspace_id=r.workspace_id and ingestion_run_id=r.ingestion_run_id and pipeline_version=r.pipeline_version) chunks,
      (select count(*) from memory_v1.knowledge_candidates where workspace_id=r.workspace_id and pipeline_version=r.pipeline_version) candidates,
      (select count(*) from memory_v1.provenance_edges where workspace_id=r.workspace_id and pipeline_version=r.pipeline_version) edges,
      (select count(*) from memory_v1.candidate_evidence where workspace_id=r.workspace_id and pipeline_version=r.pipeline_version) evidence,
      (select count(*) from memory_v1.archive_hash_resolutions where workspace_id=r.workspace_id and ingestion_run_id=r.ingestion_run_id and pipeline_version=r.pipeline_version) resolutions
      from memory_v1.ingestion_runs r where r.workspace_id=$1 and r.pipeline_version=$2`, [input.workspaceId, input.pipelineVersion])).rows[0];
    return { status: String(row?.status), attempt_count: Number(row?.attempt_count), chunks: Number(row?.chunks), candidates: Number(row?.candidates), edges: Number(row?.edges), evidence: Number(row?.evidence), resolutions: Number(row?.resolutions) };
  }); } finally { await pool.end(); }
}

async function completionErrors(input: IngestOptions): Promise<string[]> {
  const archive = await loadApprovedArchive(input); const ids = buildIds(input.workspaceId, input.pipelineVersion, archive);
  const pool = createPool("reader");
  try { return await readOnlyTransaction(pool, input.workspaceId, async (client) => (await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [input.workspaceId, ids.run, input.pipelineVersion])).rows[0]?.errors ?? []); }
  finally { await pool.end(); }
}
async function checkpointState(workspaceId: string, run: string, pipeline: string) { const pool=createPool("reader"); try{return await readOnlyTransaction(pool,workspaceId,async(client)=>{const row=(await client.query("select completed_chunk_count,next_message_sequence from memory_v1.ingestion_checkpoints where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3",[workspaceId,run,pipeline])).rows[0];return{completedChunkCount:Number(row?.completed_chunk_count),nextMessageSequence:Number(row?.next_message_sequence)};});}finally{await pool.end();} }
async function runState(workspaceId: string, run: string, pipeline: string) { const pool=createPool("reader"); try{return await readOnlyTransaction(pool,workspaceId,async(client)=>(await client.query("select status,fatal_error_count from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3",[workspaceId,run,pipeline])).rows[0]);}finally{await pool.end();} }
async function proofReceiptCount(workspaceId: string, kind: ProofKind, pipeline: string) { const pool=createPool("reader"); try{return await readOnlyTransaction(pool,workspaceId,async(client)=>Number((await client.query("select count(*) count from memory_v1.proof_receipts where workspace_id=$1 and proof_kind=$2 and pipeline_version=$3",[workspaceId,kind,pipeline])).rows[0]?.count));}finally{await pool.end();} }
async function attemptCompletion(workspaceId: string, run: string, pipeline: string): Promise<boolean> { const pool=createPool("writer");try{await transaction(pool,workspaceId,async(client)=>{await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3",[workspaceId,run,pipeline]);});return false;}catch(error){return sqlState(error)==="23514";}finally{await pool.end();} }
function options(config: MemoryConfig, pipelineVersion: string): IngestOptions { return { archiveRoot: config.archiveRoot, capturePath: config.approvedCapturePath, captureId: config.approvedCaptureId, workspaceId: config.workspaceId, pipelineVersion }; }
function proofPipeline(base: string, suffix: string): string { return `${base}/${suffix}`.slice(0, 128); }
function sqlState(error: unknown): string { return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""; }
