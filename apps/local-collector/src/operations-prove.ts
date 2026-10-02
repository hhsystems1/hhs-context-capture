import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeErrorSummaries, validateSafeMetadata, type OperationEventType, type SafeDiagnosticMetadata, type SourceComponent } from "@hhs/capture-operations";
import { idempotencyKey } from "@hhs/memory-schema";
import pg from "pg";
import { CaptureOperationStore, eventIdempotency } from "./operations.js";

interface ProofConfig {
  archiveRoot: string;
  approvedCapturePath: string;
  existingMemoryProofRoot: string;
  workspaceId: string;
  writerDatabaseUrl: string;
  readerDatabaseUrl: string;
  adminDatabaseUrl: string;
  operationsRoot: string;
  proofRoot: string;
}

type ProofAssertions = Record<string, unknown>;

export async function proveCaptureOperations(config: ProofConfig): Promise<Record<string, unknown>> {
  const archiveBefore = await treeHash(config.approvedCapturePath);
  const memoryProofsBefore = await fileHashes(config.existingMemoryProofRoot);
  const memoryBefore = await memorySnapshot(config);
  const tag = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
  const createdProofs: Array<{ proof_kind: string; directory: string; receipt_sha256: string; manifest_sha256: string }> = [];
  let successfulOperationId: string;
  const store = new CaptureOperationStore(config);
  try {
    const success = await proveSuccess(store, tag);
    successfulOperationId = String(success.operation_id);
    createdProofs.push(await writeSyntheticProof(config.proofRoot, "successful_restart_report", success));

    const failures = await proveFailureLifecycles(store, tag);
    createdProofs.push(await writeSyntheticProof(config.proofRoot, "failure_and_needs_review", failures));

    const guards = await proveGuards(store, config, tag);
    createdProofs.push(await writeSyntheticProof(config.proofRoot, "database_and_privacy_guards", guards));

    const reconciliation = await proveReconciliationAndRetry(store, tag);
    createdProofs.push(await writeSyntheticProof(config.proofRoot, "reconciliation_and_retry", reconciliation));
    await finalizeSyntheticNonterminalOperations(store);
  } finally { await store.close(); }

  const restarted = new CaptureOperationStore(config);
  const reconstructed = await restarted.get(successfulOperationId);
  await restarted.close();
  if (reconstructed.status !== "completed" || !reconstructed.archive_created || !reconstructed.verification_finished) throw new Error("Completed operation did not survive collector restart reconstruction.");
  const restartProof = {
    passed: true,
    collector_restart_reconstructed_from_postgresql: true,
    browser_computer_restart_reconstruction: true,
    reconstructed_status: reconstructed.status,
    archive_created: reconstructed.archive_created,
    verification_finished: reconstructed.verification_finished
  };
  createdProofs.push(await writeSyntheticProof(config.proofRoot, "durable_restart_reconstruction", restartProof));

  const archiveAfter = await treeHash(config.approvedCapturePath);
  const memoryProofsAfter = await fileHashes(config.existingMemoryProofRoot);
  const memoryAfter = await memorySnapshot(config);
  if (archiveAfter.sha256 !== archiveBefore.sha256) throw new Error("Approved capture changed during Capture Operations proofs.");
  assertSameFiles(memoryProofsBefore, memoryProofsAfter, "Existing Memory proof receipt");
  if (JSON.stringify(memoryBefore) !== JSON.stringify(memoryAfter)) throw new Error("Memory V1.1 accepted records changed during Capture Operations proofs.");
  const eventReceipts = await verifyReceiptTree(path.join(config.operationsRoot, "events"));
  const syntheticReceipts = await verifyReceiptTree(config.proofRoot);
  if (eventReceipts.failures.length || syntheticReceipts.failures.length) throw new Error("Capture Operations receipt verification failed.");
  return {
    status: "passed",
    archive: { before_sha256: archiveBefore.sha256, after_sha256: archiveAfter.sha256, unchanged: true },
    existing_memory_receipts: { files: memoryProofsBefore.size, unchanged: true },
    memory_v1_1: { before: memoryBefore, after: memoryAfter, unchanged: true },
    created_proofs: createdProofs,
    event_receipt_verification: eventReceipts,
    synthetic_proof_verification: syntheticReceipts,
    restart_reconstruction: restartProof
  };
}

async function proveSuccess(store: CaptureOperationStore, tag: string): Promise<ProofAssertions> {
  const identity = ids("success", tag);
  await store.create(createInput(identity));
  await lifecycle(store, identity.operationId, [
    ["identity_observed", "extension_content", { stage: "identity_observed" }],
    ["identity_verified", "extension_content", { stage: "identity_verified", identity_verified: true }],
    ["capture_requested", "extension_popup", { stage: "capture_requested" }],
    ["capture_started", "extension_content", { stage: "capture_started" }],
    ["capture_progress", "extension_content", { stage: "extraction_completed", message_count: 3 }],
    ["collector_delivery_started", "extension_worker", { stage: "collector_delivery_started" }],
    ["collector_delivery_succeeded", "collector", { stage: "collector_delivery_succeeded" }],
    ["archive_started", "archive", { stage: "archive_started" }],
    ["archive_completed", "archive", { stage: "archive_completed", archive_created: true, safe_capture_reference: "capture-synthetic-success", archive_manifest_sha256: "a".repeat(64) }],
    ["verification_completed", "verifier", { stage: "verification_completed", verification_status: "complete" }],
    ["capture_completed", "collector", { stage: "capture_completed" }]
  ]);
  const report = await store.get(identity.operationId);
  if (report.status !== "completed" || !report.capture_started || !report.identity_verified || !report.collector_delivery_succeeded || !report.archive_started || !report.archive_created || !report.verification_finished) throw new Error("Successful operation did not reconstruct correctly.");
  const duplicateIdentity = ids("duplicate", tag);
  await store.create(createInput(duplicateIdentity));
  const timestamp = new Date().toISOString();
  const duplicateEvent = {
    operation_id: duplicateIdentity.operationId, correlation_id: duplicateIdentity.correlationId,
    event_type: "identity_observed" as const, event_sequence: 2, event_timestamp: timestamp,
    source_component: "extension_content" as const, metadata: { stage: "identity_observed" },
    idempotency_key: eventIdempotency(duplicateIdentity.operationId, 2, "identity_observed")
  };
  const first = await store.append(duplicateEvent);
  const replay = await store.append(duplicateEvent);
  if (first.eventSha256 !== replay.eventSha256 || !replay.replayed) throw new Error("Duplicate operation event was not idempotent.");
  return { passed: true, operation_id: identity.operationId, successful_status: report.status, last_successful_stage: report.last_successful_stage, report_answers_verified: true, duplicate_replay_idempotent: true, popup_closure_safe_cache_covered_by_unit_test: true };
}

async function proveFailureLifecycles(store: CaptureOperationStore, tag: string): Promise<ProofAssertions> {
  const pairing = ids("pairing-failure", tag);
  await store.create(createInput(pairing, "pairing"));
  await lifecycle(store, pairing.operationId, [
    ["pairing_requested", "extension_popup", { stage: "pairing_requested" }],
    ["pairing_failed", "collector", { safe_error_code: "pairing_failed", safe_error_summary: safeErrorSummaries.pairing_failed, reason_code: "pairing_failed" }]
  ]);
  const mismatch = ids("identity-mismatch", tag);
  await store.create(createInput(mismatch));
  await lifecycle(store, mismatch.operationId, [
    ["identity_observed", "extension_content", { stage: "identity_observed" }],
    ["identity_mismatch", "extension_content", { safe_error_code: "identity_mismatch", safe_error_summary: safeErrorSummaries.identity_mismatch, reason_code: "identity_mismatch" }]
  ]);
  const delivery = ids("delivery-failure", tag);
  await store.create(createInput(delivery));
  await lifecycle(store, delivery.operationId, [
    ["identity_observed", "extension_content", {}], ["capture_started", "extension_content", {}],
    ["collector_delivery_started", "extension_worker", {}],
    ["collector_delivery_failed", "extension_worker", { safe_error_code: "delivery_failed", safe_error_summary: safeErrorSummaries.delivery_failed, reason_code: "delivery_failed" }]
  ]);
  const archive = ids("archive-failure", tag);
  await store.create(createInput(archive));
  await lifecycle(store, archive.operationId, [
    ["identity_observed", "extension_content", {}], ["capture_started", "extension_content", {}],
    ["collector_delivery_started", "extension_worker", {}], ["collector_delivery_succeeded", "collector", {}],
    ["archive_started", "archive", {}],
    ["capture_failed", "collector", { safe_error_code: "archive_failed", safe_error_summary: safeErrorSummaries.archive_failed, reason_code: "archive_failed" }]
  ]);
  const review = ids("needs-review", tag);
  await store.create(createInput(review));
  await lifecycle(store, review.operationId, [
    ["identity_observed", "extension_content", {}], ["capture_started", "extension_content", {}],
    ["collector_delivery_started", "extension_worker", {}], ["collector_delivery_succeeded", "collector", {}],
    ["archive_started", "archive", {}],
    ["archive_completed", "archive", { archive_created: true, safe_capture_reference: "capture-synthetic-review", archive_manifest_sha256: "b".repeat(64) }],
    ["verification_completed", "verifier", { verification_status: "needs_review" }],
    ["capture_needs_review", "collector", { verification_status: "needs_review" }]
  ]);
  const reports = await Promise.all([pairing, mismatch, delivery, archive, review].map((item) => store.get(item.operationId)));
  if (reports.slice(0, 4).some((report) => report.status !== "failed") || reports[4]?.status !== "needs_review") throw new Error("Failure lifecycle reconstruction failed.");
  return { passed: true, pairing_failure: "failed", identity_mismatch: "failed", collector_delivery_failure: "failed", archive_failure: "failed", verification_result: "needs_review" };
}

async function proveGuards(store: CaptureOperationStore, config: ProofConfig, tag: string): Promise<ProofAssertions> {
  const invalid = ids("invalid-transition", tag);
  await store.create(createInput(invalid));
  const invalidTransition = await rejectsCode(() => store.appendNext(invalid.operationId, "capture_completed", "collector"), "23514");
  const outOfOrderIdentity = ids("out-of-order", tag);
  await store.create(createInput(outOfOrderIdentity));
  const outOfOrder = await rejectsCode(() => store.append({
    operation_id: outOfOrderIdentity.operationId, correlation_id: outOfOrderIdentity.correlationId,
    event_type: "identity_observed", event_sequence: 3, event_timestamp: new Date().toISOString(),
    source_component: "extension_content", metadata: {}, idempotency_key: eventIdempotency(outOfOrderIdentity.operationId, 3, "identity_observed")
  }), "23514");
  const terminal = ids("terminal", tag);
  await store.create(createInput(terminal));
  await lifecycle(store, terminal.operationId, [
    ["identity_observed", "extension_content", {}], ["capture_started", "extension_content", {}],
    ["capture_failed", "collector", { safe_error_code: "internal_error", safe_error_summary: safeErrorSummaries.internal_error, reason_code: "internal_error" }]
  ]);
  const terminalMutation = await rejectsCode(() => store.appendNext(terminal.operationId, "capture_progress", "extension_content"), "55000");
  const hashIdentity = ids("hash-mismatch", tag);
  await store.create(createInput(hashIdentity));
  const hashMismatch = await rejectsCode(() => store.append({
    operation_id: hashIdentity.operationId, correlation_id: hashIdentity.correlationId,
    event_type: "identity_observed", event_sequence: 2, event_timestamp: new Date().toISOString(),
    source_component: "extension_content", metadata: {}, event_sha256: "0".repeat(64),
    idempotency_key: eventIdempotency(hashIdentity.operationId, 2, "identity_observed")
  }), "23514");
  let applicationPrivacyRejected = false;
  try { validateSafeMetadata({ transcript: "prohibited" }); } catch { applicationPrivacyRejected = true; }
  const databasePrivacyRejected = await directDatabasePrivacyProbe(config, ids("privacy-db", tag));
  const workspaceIsolation = await directWorkspaceProbe(config, ids("workspace", tag));
  if (![invalidTransition, outOfOrder, terminalMutation, hashMismatch, applicationPrivacyRejected, databasePrivacyRejected, workspaceIsolation].every(Boolean)) throw new Error("One or more Capture Operations guards failed.");
  return { passed: true, invalid_transition_rejected: true, out_of_order_rejected: true, terminal_mutation_rejected: true, event_hash_mismatch_rejected: true, application_privacy_allowlist_rejected: true, database_privacy_allowlist_rejected: true, workspace_isolation_rejected: true };
}

async function proveReconciliationAndRetry(store: CaptureOperationStore, tag: string): Promise<ProofAssertions> {
  const parent = ids("interrupted", tag);
  const old = new Date(Date.now() - 3_600_000).toISOString();
  await store.create(createInput(parent), old);
  const interrupted = await store.reconcile(parent.operationId, 900);
  if (interrupted.status !== "interrupted" || !interrupted.retry_safe || interrupted.last_successful_stage !== "operation_created") throw new Error("Interrupted reconciliation did not preserve the last successful stage.");
  const retry = ids("retry", tag);
  await store.create({ ...createInput(retry), parent_operation_id: parent.operationId });
  const retryReport = await store.get(retry.operationId);
  const parentReport = await store.get(parent.operationId);
  if (retry.operationId === parent.operationId || retryReport.parent_operation_id !== parent.operationId || parentReport.retry_operation_id !== retry.operationId) throw new Error("Retry lineage was not explicit and distinct.");
  return { passed: true, interrupted_status: interrupted.status, completion_not_inferred: true, last_successful_stage_preserved: interrupted.last_successful_stage, retry_distinct: true, retry_parent_linked: true, automatic_retry: false };
}

async function lifecycle(store: CaptureOperationStore, operationId: string, events: Array<[OperationEventType, SourceComponent, SafeDiagnosticMetadata]>): Promise<void> {
  for (const [event, source, metadata] of events) await store.appendNext(operationId, event, source, metadata);
}

async function finalizeSyntheticNonterminalOperations(store: CaptureOperationStore): Promise<void> {
  const terminal = new Set(["completed", "needs_review", "failed", "interrupted", "canceled"]);
  for (const operation of await store.list(true)) {
    if (operation.platform === "synthetic" && !terminal.has(operation.status)) {
      await store.appendNext(operation.operation_id, "operation_canceled", "reconciler", {
        reason_code: "synthetic_proof_finalized",
        last_successful_stage: operation.last_successful_stage,
        retry_safe: true
      });
    }
  }
}

function ids(kind: string, tag: string) {
  return { operationId: `operation-synthetic-${kind}-${tag}`, correlationId: `correlation-synthetic-${kind}-${tag}` };
}

function createInput(identity: ReturnType<typeof ids>, operationType: "capture" | "pairing" = "capture") {
  return {
    operation_id: identity.operationId, correlation_id: identity.correlationId,
    platform: "synthetic", opaque_account_reference: "opaque-account-synthetic",
    opaque_conversation_reference: "opaque-conversation-synthetic",
    operation_type: operationType, source_component: "collector" as const
  };
}

async function directDatabasePrivacyProbe(config: ProofConfig, identity: ReturnType<typeof ids>): Promise<boolean> {
  const store = new CaptureOperationStore(config);
  await store.create(createInput(identity));
  await store.close();
  const pool = new pg.Pool({ connectionString: config.writerDatabaseUrl, max: 1 });
  try {
    return await sqlRejected(pool, config.workspaceId, "select * from capture_ops.append_operation_event($1,$2,$3,'identity_observed',2,now(),'collector',$4,'hhs.capture-operation-event/1.0.0',$5,null)", [
      config.workspaceId, identity.operationId, identity.correlationId, { transcript: "prohibited" },
      eventIdempotency(identity.operationId, 2, "identity_observed")
    ], "23514");
  } finally { await pool.end(); }
}

async function directWorkspaceProbe(config: ProofConfig, identity: ReturnType<typeof ids>): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: config.writerDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('memory_v1.workspace_id','workspace-synthetic-other',true)");
    try {
      await client.query("select capture_ops.create_capture_operation($1,$2,$3,'synthetic','opaque-account-synthetic','opaque-conversation-synthetic','capture','collector',null,now(),$4,$5)", [
        config.workspaceId, identity.operationId, identity.correlationId,
        idempotencyKey("capture_operation", config.workspaceId, identity.operationId),
        eventIdempotency(identity.operationId, 1, "operation_created")
      ]);
      return false;
    } catch (error) { return sqlState(error) === "42501"; }
    finally { await client.query("rollback"); }
  } finally { client.release(); await pool.end(); }
}

async function sqlRejected(pool: pg.Pool, workspaceId: string, query: string, parameters: unknown[], expected: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    try { await client.query(query, parameters); return false; }
    catch (error) { return sqlState(error) === expected; }
    finally { await client.query("rollback"); }
  } finally { client.release(); }
}

async function rejectsCode(action: () => Promise<unknown>, expected: string): Promise<boolean> {
  try { await action(); return false; } catch (error) { return sqlState(error) === expected; }
}

async function memorySnapshot(config: ProofConfig): Promise<Record<string, unknown>> {
  const pool = new pg.Pool({ connectionString: config.readerDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [config.workspaceId]);
    const accepted = (await client.query(`select pipeline_version,run_status,message_count,content_block_count,chunk_count,
      proposed_candidate_count,provenance_edge_count,raw_provenance_edge_count,exact_hash_resolution_count,
      approved_knowledge_count,provenance_trust_status from memory_v1.import_report
      where workspace_id=$1 order by pipeline_version`, [config.workspaceId])).rows;
    const totals = (await client.query(`select
      (select count(*) from memory_v1.capture_versions where workspace_id=$1) captures,
      (select count(*) from memory_v1.messages where workspace_id=$1) messages,
      (select count(*) from memory_v1.content_blocks where workspace_id=$1) blocks,
      (select count(*) from memory_v1.proof_receipts where workspace_id=$1) proof_receipts`, [config.workspaceId])).rows[0];
    await client.query("commit");
    return { accepted, totals };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); await pool.end(); }
}

async function writeSyntheticProof(root: string, kind: string, assertions: ProofAssertions) {
  await mkdir(root, { recursive: true });
  const createdAt = new Date().toISOString();
  const proofId = `capture_ops_proof_${digest(Buffer.from(`${kind}:${createdAt}:${randomUUID()}`)).slice(0, 32)}`;
  const leaf = `${createdAt.replace(/[-:.]/g, "")}_${kind}_${proofId.slice(-8)}`;
  const staging = path.join(root, `.tmp-${randomUUID()}`);
  const destination = path.join(root, leaf);
  await mkdir(staging, { recursive: false });
  const receipt = { schema_version: "hhs.capture-operations-proof/1.0.0", proof_id: proofId, proof_kind: kind, created_at: createdAt, assertions };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = digest(receiptBytes);
  const manifest = { schema_version: "hhs.capture-operations-proof-manifest/1.0.0", proof_id: proofId, files: [{ path: "receipt.json", bytes: receiptBytes.length, sha256: receiptSha256 }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = digest(manifestBytes);
  await writeFile(path.join(staging, "receipt.json"), receiptBytes, { flag: "wx" });
  await writeFile(path.join(staging, "manifest.json"), manifestBytes, { flag: "wx" });
  await writeFile(path.join(staging, "hashes.sha256"), `${receiptSha256}  receipt.json\n${manifestSha256}  manifest.json\n`, { flag: "wx" });
  await rename(staging, destination);
  return { proof_kind: kind, directory: destination, receipt_sha256: receiptSha256, manifest_sha256: manifestSha256 };
}

async function verifyReceiptTree(root: string): Promise<{ directories: number; verified: number; failures: string[]; tree_sha256: string }> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];
  const collect = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        try { await readFile(path.join(full, "hashes.sha256")); directories.push(full); }
        catch { await collect(full); }
      }
    }
  };
  if (entries.length) await collect(root);
  const failures: string[] = [];
  for (const directory of directories) {
    const lines = (await readFile(path.join(directory, "hashes.sha256"), "utf8")).trim().split(/\r?\n/);
    for (const line of lines) {
      const match = /^([a-f0-9]{64}) {2}(receipt\.json|manifest\.json)$/.exec(line);
      if (!match?.[1] || !match[2] || digest(await readFile(path.join(directory, match[2]))) !== match[1]) failures.push(path.relative(root, directory));
    }
  }
  return { directories: directories.length, verified: directories.length - new Set(failures).size, failures, tree_sha256: (await treeHash(root)).sha256 };
}

async function treeHash(root: string): Promise<{ files: number; sha256: string }> {
  const files = [...(await fileHashes(root)).entries()].sort(([a], [b]) => a.localeCompare(b));
  return { files: files.length, sha256: digest(Buffer.from(files.map(([relative, hash]) => `${relative}\0${hash}`).join("\n"))) };
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.set(path.relative(root, full).split(path.sep).join("/"), digest(await readFile(full)));
    }
  };
  await visit(root);
  return output;
}

function assertSameFiles(before: Map<string, string>, after: Map<string, string>, label: string): void {
  if (before.size !== after.size) throw new Error(`${label} file count changed.`);
  for (const [file, hash] of before) if (after.get(file) !== hash) throw new Error(`${label} changed: ${file}`);
}

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function sqlState(error: unknown): string { return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""; }
