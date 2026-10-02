import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { deterministicId } from "@hhs/memory-schema";
import type { MemoryConfig } from "./config.js";
import { createPool, readOnlyTransaction, transaction } from "./db.js";
import { buildIds, ingestApprovedCapture, quarantineInvalidEvidence, SimulatedInterruption } from "./ingest.js";
import { loadApprovedArchive } from "./archive.js";
import { archiveTreeSha256, verifyProofRoot, writeAndPersistProofReceipt, type ProofKind, type StoredProofReceipt } from "./proof-receipts.js";

export async function proveAuditCorrections(config: MemoryConfig): Promise<Record<string, unknown>> {
  const input = { archiveRoot: config.archiveRoot, capturePath: config.approvedCapturePath, captureId: config.approvedCaptureId, workspaceId: config.workspaceId, pipelineVersion: config.pipelineVersion };
  const archive = await loadApprovedArchive(input);
  const baseIds = buildIds(config.workspaceId, config.pipelineVersion, archive);
  const archiveBefore = await archiveTreeSha256(config.approvedCapturePath);
  const receiptsBefore = await proofFileHashes(config.proofRoot);
  const created: StoredProofReceipt[] = [];
  const receipt = async (proofKind: ProofKind, pipelineVersion: string, ingestionRunId: string, assertions: Record<string, unknown>) => {
    const stored = await writeAndPersistProofReceipt({ proofRoot: config.proofRoot, proofKind, workspaceId: config.workspaceId, ingestionRunId, pipelineVersion, captureId: config.approvedCaptureId, archiveTreeSha256: archiveBefore, assertions });
    created.push(stored);
  };

  const insertProof = await proveCompletedInsertRejected(config.workspaceId);
  await receipt("completed_insert_rejection", config.pipelineVersion, baseIds.run, insertProof);

  const suffix = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
  const fatalPipeline = proofPipeline(config.pipelineVersion, `audit-fatal-${suffix}`);
  const fatalInput = { ...input, pipelineVersion: fatalPipeline };
  const fatalIds = buildIds(config.workspaceId, fatalPipeline, archive);
  let interrupted = false;
  try { await ingestApprovedCapture({ ...fatalInput, interruptAfterChunks: 1 }); }
  catch (error) { if (error instanceof SimulatedInterruption) interrupted = true; else throw error; }
  if (!interrupted) throw new Error("Corrective fatal proof did not create an interrupted source run.");
  const quarantineId = await quarantineInvalidEvidence(fatalInput, true);
  const fatalProof = await proveFatalTerminal(config.workspaceId, fatalIds.run, fatalPipeline, quarantineId);
  await receipt("fatal_quarantine_terminal", fatalPipeline, fatalIds.run, fatalProof);

  const retryPipeline = proofPipeline(config.pipelineVersion, `audit-retry-${suffix}`);
  const retryInput = { ...input, pipelineVersion: retryPipeline, retryOf: { ingestionRunId: fatalIds.run, pipelineVersion: fatalPipeline } };
  const retry = await ingestApprovedCapture(retryInput);
  const retryProof = await proveRetryLineage(config.workspaceId, retry.ingestionRunId, retryPipeline, fatalIds.run, fatalPipeline);
  await receipt("retry_lineage", retryPipeline, retry.ingestionRunId, retryProof);

  const legacyProof = await proveLegacyRepair(config.workspaceId);
  await receipt("legacy_provenance_repair", String(legacyProof.pipeline_version), String(legacyProof.ingestion_run_id), legacyProof);

  const archiveAfter = await archiveTreeSha256(config.approvedCapturePath);
  if (archiveAfter !== archiveBefore) throw new Error("Approved capture changed during corrective proofs.");
  const receiptsAfter = await proofFileHashes(config.proofRoot);
  for (const [relative, digest] of receiptsBefore) if (receiptsAfter.get(relative) !== digest) throw new Error(`Existing proof receipt changed: ${relative}`);
  const verification = await verifyProofRoot(config.proofRoot);
  if (verification.failures.length || verification.verified !== verification.receiptDirectories) throw new Error("Proof-root verification failed after corrective proofs.");
  const captureCount = await scalar(config.workspaceId, "select count(*) from memory_v1.capture_versions where workspace_id=$1");
  if (captureCount !== 1) throw new Error(`Corrective proofs found ${captureCount} capture versions; expected exactly one.`);
  return {
    status: "passed",
    archive: { unchanged: true, before_sha256: archiveBefore, after_sha256: archiveAfter },
    preexisting_receipts: { unchanged: true, file_count: receiptsBefore.size },
    receipt_verification: verification,
    created_receipts: created,
    proofs: { completed_insert_rejection: insertProof, fatal_quarantine_terminal: fatalProof, retry_lineage: retryProof, legacy_provenance_repair: legacyProof },
    capture_versions: captureCount
  };
}

async function proveCompletedInsertRejected(workspaceId: string): Promise<Record<string, unknown>> {
  const pool = createPool("writer");
  const probe = deterministicId("ingestion_run", workspaceId, ["incomplete-completed-insert", new Date().toISOString()]);
  let code = "";
  try {
    await transaction(pool, workspaceId, async (client) => {
      const source = (await client.query("select source_system_id,source_account_id,input_manifest_sha256 from memory_v1.ingestion_runs where workspace_id=$1 and status='completed' limit 1", [workspaceId])).rows[0];
      await client.query(`insert into memory_v1.ingestion_runs
        (workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,completed_at,input_manifest_sha256,checkpoint_key,attempt_count,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count,completion_validated_at)
        values ($1,$2,$3,$4,$5,'completed',now(),now(),$6,'complete',1,$7,30,450,6,now())`,
      [workspaceId, probe, source.source_system_id, source.source_account_id, "f".repeat(64), source.input_manifest_sha256, `memory-v1.1/invalid-completed-insert-${Date.now()}`]);
    });
  } catch (error) { code = sqlState(error); }
  finally { await pool.end(); }
  if (code !== "23514") throw new Error(`Incomplete completed INSERT was not rejected (${code || "no error"}).`);
  return { passed: true, direct_insert_rejected: true, database_error: "check_violation", inserted_row_absent: true };
}

async function proveFatalTerminal(workspaceId: string, run: string, pipeline: string, quarantineId: string): Promise<Record<string, unknown>> {
  const pool = createPool("writer");
  try {
    await transaction(pool, workspaceId, async (client) => {
      await client.query("update memory_v1.quarantine_items set status='released' where workspace_id=$1 and quarantine_item_id=$2", [workspaceId, quarantineId]);
    });
    const resumeCode = await rejectedUpdate(pool, workspaceId, run, pipeline, "running");
    const completionCode = await rejectedUpdate(pool, workspaceId, run, pipeline, "completed");
    const row = await readOnlyTransaction(pool, workspaceId, async (client) => (await client.query("select status,fatal_error_count from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, run, pipeline])).rows[0]);
    if (row?.status !== "quarantined" || Number(row?.fatal_error_count) < 1 || resumeCode !== "55000" || completionCode !== "55000") throw new Error("Fatal quarantine was not terminal after evidence release.");
    return { passed: true, evidence_status_transition: "open_to_released", terminal_status: row.status, fatal_error_count: Number(row.fatal_error_count), resume_rejected: true, completion_rejected: true, database_error: "object_not_in_prerequisite_state" };
  } finally { await pool.end(); }
}

async function rejectedUpdate(pool: ReturnType<typeof createPool>, workspaceId: string, run: string, pipeline: string, status: "running" | "completed"): Promise<string> {
  try {
    await transaction(pool, workspaceId, async (client) => {
      if (status === "completed") await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, run, pipeline]);
      else await client.query("update memory_v1.ingestion_runs set status='running' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, run, pipeline]);
    });
    return "";
  } catch (error) { return sqlState(error); }
}

async function proveRetryLineage(workspaceId: string, run: string, pipeline: string, parentRun: string, parentPipeline: string): Promise<Record<string, unknown>> {
  const pool = createPool("reader");
  try {
    const row = await readOnlyTransaction(pool, workspaceId, async (client) => (await client.query(`select r.status,r.retry_of_ingestion_run_id,r.retry_of_pipeline_version,
      cardinality(memory_v1.ingestion_completion_errors(r.workspace_id,r.ingestion_run_id,r.pipeline_version)) completion_errors,
      (select count(*) from memory_v1.trusted_provenance_edges p where p.workspace_id=r.workspace_id and p.ingestion_run_id=r.ingestion_run_id and p.pipeline_version=r.pipeline_version) trusted_edges,
      (select count(*) from memory_v1.archive_hash_resolutions a where a.workspace_id=r.workspace_id and a.ingestion_run_id=r.ingestion_run_id and a.pipeline_version=r.pipeline_version and a.exact_match) exact_resolutions
      from memory_v1.ingestion_runs r where r.workspace_id=$1 and r.ingestion_run_id=$2 and r.pipeline_version=$3`, [workspaceId, run, pipeline])).rows[0]);
    if (row?.status !== "completed" || row.retry_of_ingestion_run_id !== parentRun || row.retry_of_pipeline_version !== parentPipeline || Number(row.completion_errors) !== 0 || Number(row.trusted_edges) !== 450 || Number(row.exact_resolutions) !== 481) throw new Error("Corrected retry lineage or trusted provenance proof failed.");
    return { passed: true, distinct_run_identity: run !== parentRun, parent_ingestion_run_id: parentRun, parent_pipeline_version: parentPipeline, status: row.status, completion_errors: 0, trusted_provenance_edges: 450, exact_archive_hash_resolutions: 481 };
  } finally { await pool.end(); }
}

async function proveLegacyRepair(workspaceId: string): Promise<Record<string, unknown>> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      const row = (await client.query(`select r.ingestion_run_id,r.pipeline_version,a.trust_status,
        (select count(*) from memory_v1.provenance_edges p where p.workspace_id=r.workspace_id and p.pipeline_version=r.pipeline_version) raw_edges,
        (select count(*) from memory_v1.legacy_provenance_repairs x where x.workspace_id=r.workspace_id and x.pipeline_version=r.pipeline_version) repairs,
        (select count(*) from memory_v1.trusted_provenance_edges p where p.workspace_id=r.workspace_id and p.ingestion_run_id=r.ingestion_run_id and p.pipeline_version=r.pipeline_version) trusted_edges,
        (select count(*) from memory_v1.trusted_provenance_edges p join memory_v1.content_blocks b on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id) where p.workspace_id=r.workspace_id and p.ingestion_run_id=r.ingestion_run_id and p.pipeline_version=r.pipeline_version and p.source_record_id=b.source_record_id and p.archive_resolution_id is not null) exact_block_edges,
        (select count(*) from memory_v1.trusted_knowledge_candidates k where k.workspace_id=r.workspace_id and k.pipeline_version=r.pipeline_version) trusted_candidates
        from memory_v1.ingestion_runs r join memory_v1.provenance_generation_attestations a using(workspace_id,ingestion_run_id,pipeline_version)
        where r.workspace_id=$1 and r.pipeline_version='memory-v1/legacy'`, [workspaceId])).rows[0];
      const excluded = Number((await client.query(`select count(*) from memory_v1.provenance_generation_attestations a where a.workspace_id=$1 and a.trust_status in ('retired','quarantined') and (exists(select 1 from memory_v1.trusted_provenance_edges p where (p.workspace_id,p.ingestion_run_id,p.pipeline_version)=(a.workspace_id,a.ingestion_run_id,a.pipeline_version)) or exists(select 1 from memory_v1.trusted_knowledge_candidates k join memory_v1.message_range_chunks ch on (ch.workspace_id,ch.chunk_id,ch.pipeline_version)=(k.workspace_id,k.chunk_id,k.pipeline_version) where (ch.workspace_id,ch.ingestion_run_id,ch.pipeline_version)=(a.workspace_id,a.ingestion_run_id,a.pipeline_version)))`, [workspaceId])).rows[0]?.count);
      if (row?.trust_status !== "repaired" || Number(row.raw_edges) !== 450 || Number(row.repairs) !== 450 || Number(row.trusted_edges) !== 450 || Number(row.exact_block_edges) !== 450 || Number(row.trusted_candidates) !== 6 || excluded !== 0) throw new Error("Legacy repair overlay did not produce exactly trusted block-level provenance.");
      return { passed: true, ingestion_run_id: row.ingestion_run_id, pipeline_version: row.pipeline_version, resolution: "immutable_repair_overlay", trust_status: row.trust_status, raw_historical_edges_preserved: 450, repair_records: 450, trusted_exact_block_edges: 450, trusted_candidates: 6, retired_or_quarantined_records_exposed_as_trusted: 0 };
    });
  } finally { await pool.end(); }
}

async function scalar(workspaceId: string, query: string): Promise<number> {
  const pool = createPool("reader");
  try { return await readOnlyTransaction(pool, workspaceId, async (client) => Number((await client.query(query, [workspaceId])).rows[0]?.count)); }
  finally { await pool.end(); }
}

async function proofFileHashes(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.set(path.relative(root, full).split(path.sep).join("/"), createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  };
  await visit(root);
  return result;
}

function proofPipeline(base: string, suffix: string): string { return `${base}/${suffix}`.slice(0, 128); }
function sqlState(error: unknown): string { return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""; }
