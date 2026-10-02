import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "@hhs/memory-schema";
import { loadMemoryConfig } from "./config.js";
import { createPool, readOnlyTransaction } from "./db.js";
import { approveCandidate, rejectCandidate } from "./review.js";
import { queryApprovedKnowledge } from "./query.js";
import { archiveTreeSha256, writeAndPersistProofReceipt } from "./proof-receipts.js";

// Live proof for the Phase 1 review/approval/query slice. Machinery is proven
// against candidates in disposable proof pipelines only; candidates in the real
// pipeline are reviewed exclusively by a human through the review CLI.
const HARNESS_REVIEWER = "prove-review-harness";
const PROOF_PIPELINE_PREFIX = "memory-v1.1/1.1.0/";

const config = loadMemoryConfig();
const assertions: Record<string, unknown> = {};

await proveRolePermissionBoundaries();
const { approvedCandidateId, rejectedCandidateId, proofPipeline } = await proveDecisionLifecycle();
await proveQueryAndProvenance();
const receipt = await persistReceipt();
console.log(JSON.stringify({ status: "proved", proof_kind: "review_approval_query", approved_candidate: approvedCandidateId, rejected_candidate: rejectedCandidateId, proof_pipeline: proofPipeline, receipt_directory: receipt.directory, receipt_sha256: receipt.receiptSha256, assertions }, null, 2));

async function proveRolePermissionBoundaries(): Promise<void> {
  await expectRejected("reviewer_cannot_insert_candidates", "reviewer", "insert into memory_v1.knowledge_candidates (workspace_id) values ($1)", /permission denied/i);
  await expectRejected("reviewer_cannot_update_review_events", "reviewer", "update memory_v1.human_review_events set rationale='tampered' where workspace_id=$1", /permission denied/i);
  await expectRejected("reviewer_cannot_delete_approved_knowledge", "reviewer", "delete from memory_v1.approved_knowledge where workspace_id=$1", /permission denied/i);
  await expectRejected("report_reader_cannot_insert_review_events", "reader", "insert into memory_v1.human_review_events (workspace_id) values ($1)", /permission denied|read-only/i);
  await expectRejected("report_reader_cannot_insert_approved_knowledge", "reader", "insert into memory_v1.approved_knowledge (workspace_id) values ($1)", /permission denied|read-only/i);
  await expectRejected("ingest_writer_cannot_insert_review_events", "writer", "insert into memory_v1.human_review_events (workspace_id) values ($1)", /permission denied/i);
  await expectRejected("ingest_writer_cannot_insert_approved_knowledge", "writer", "insert into memory_v1.approved_knowledge (workspace_id) values ($1)", /permission denied/i);
}

async function proveDecisionLifecycle(): Promise<{ approvedCandidateId: string; rejectedCandidateId: string; proofPipeline: string }> {
  const pool = createPool("reader");
  let candidates: Array<{ knowledge_candidate_id: string; pipeline_version: string }>;
  try {
    candidates = await readOnlyTransaction(pool, config.workspaceId, async (client) => (await client.query(`
      select k.knowledge_candidate_id, k.pipeline_version from memory_v1.knowledge_candidates k
      where k.workspace_id=$1 and k.pipeline_version like $2
        and not exists (select 1 from memory_v1.human_review_events e
          where e.workspace_id=k.workspace_id and e.knowledge_candidate_id=k.knowledge_candidate_id)
      order by k.pipeline_version asc, k.knowledge_candidate_id asc limit 2`,
      [config.workspaceId, `${PROOF_PIPELINE_PREFIX}%`])).rows);
  } finally { await pool.end(); }
  if (candidates.length < 2) throw new Error("Proof requires two unreviewed candidates in proof pipelines.");
  const [first, second] = candidates as [typeof candidates[number], typeof candidates[number]];

  const approval = await approveCandidate({ workspaceId: config.workspaceId, candidateId: first.knowledge_candidate_id, reviewerId: HARNESS_REVIEWER, rationale: "Machinery proof: approval path against a disposable proof-pipeline candidate." });
  if (!approval.approved_knowledge_id || !approval.provenance_edge_count) throw new Error("Approval did not create approved knowledge with provenance.");
  assertions.approval_created = { approved_knowledge_id: approval.approved_knowledge_id, provenance_edge_count: approval.provenance_edge_count };

  let doubleDecisionBlocked = false;
  try { await rejectCandidate({ workspaceId: config.workspaceId, candidateId: first.knowledge_candidate_id, reviewerId: HARNESS_REVIEWER, rationale: "Must fail: candidate already approved." }); }
  catch (error) { doubleDecisionBlocked = /already reviewed/i.test(String(error)); }
  if (!doubleDecisionBlocked) throw new Error("Conflicting second decision was not blocked.");
  assertions.conflicting_second_decision_blocked = true;

  let replayBlocked = false;
  try { await approveCandidate({ workspaceId: config.workspaceId, candidateId: first.knowledge_candidate_id, reviewerId: HARNESS_REVIEWER, rationale: "Must fail: replayed approval." }); }
  catch (error) { replayBlocked = /already reviewed/i.test(String(error)); }
  if (!replayBlocked) throw new Error("Replayed approval was not blocked.");
  assertions.replayed_approval_blocked = true;

  const rejection = await rejectCandidate({ workspaceId: config.workspaceId, candidateId: second.knowledge_candidate_id, reviewerId: HARNESS_REVIEWER, rationale: "Machinery proof: rejection path against a disposable proof-pipeline candidate." });
  if (rejection.approved_knowledge_id) throw new Error("Rejection must not create approved knowledge.");
  const pool2 = createPool("reader");
  try {
    const approvedFromRejection = await readOnlyTransaction(pool2, config.workspaceId, async (client) =>
      (await client.query("select count(*)::int as n from memory_v1.approved_knowledge where workspace_id=$1 and knowledge_candidate_id=$2", [config.workspaceId, second.knowledge_candidate_id])).rows[0].n);
    if (approvedFromRejection !== 0) throw new Error("Rejected candidate must have no approved_knowledge row.");
  } finally { await pool2.end(); }
  assertions.rejection_recorded_without_approval = { human_review_event_id: rejection.human_review_event_id };
  return { approvedCandidateId: first.knowledge_candidate_id, rejectedCandidateId: second.knowledge_candidate_id, proofPipeline: first.pipeline_version };
}

async function proveQueryAndProvenance(): Promise<void> {
  const probeTerm = await selectProbeTerm();
  const probe = await queryApprovedKnowledge(config.workspaceId, probeTerm, 5);
  assertions.query_probe_term = probeTerm;
  const anyMatch = probe.matches[0];
  if (!anyMatch) throw new Error("Query returned no matches over approved knowledge.");
  for (const field of ["approved_knowledge_id", "immutable_archive_locator", "conversation_id", "message_id", "provenance_edge_id", "representation_sha256", "text_value", "reviewer_id"] as const) {
    if (!anyMatch[field]) throw new Error(`Query match is missing ${field}.`);
  }
  const expectedLocator = `hhs-archive://capture/${config.approvedCaptureId}`;
  if (anyMatch.immutable_archive_locator !== expectedLocator) throw new Error(`Unexpected archive locator: ${anyMatch.immutable_archive_locator}`);

  const rawHash = createHash("sha256").update(anyMatch.text_value, "utf8").digest("hex");
  const canonicalHash = sha256(anyMatch.text_value);
  const hashMethod = rawHash === anyMatch.representation_sha256 ? "utf8_bytes" : canonicalHash === anyMatch.representation_sha256 ? "canonical_json" : null;
  if (!hashMethod) throw new Error("Returned text does not hash-match its provenance representation_sha256.");

  const archiveDirectory = path.resolve(config.approvedCapturePath);
  for (const file of ["hashes.sha256", "capture-manifest.json", path.join("normalized", "conversation.json")]) {
    if (!(await stat(path.join(archiveDirectory, file))).isFile()) throw new Error(`Immutable archive file missing: ${file}`);
  }
  assertions.query_and_provenance = {
    matches: probe.matches.length,
    trust_scope: probe.trust_scope,
    archive_locator: anyMatch.immutable_archive_locator,
    archive_directory_verified: archiveDirectory,
    text_hash_method: hashMethod,
    text_sha256: anyMatch.representation_sha256
  };
}

async function selectProbeTerm(): Promise<string> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, config.workspaceId, async (client) => {
      const sample = await client.query(`
        select rep->>'value' as text_value
        from memory_v1.approved_knowledge ak
        join memory_v1.candidate_evidence ce on ce.workspace_id=ak.workspace_id and ce.knowledge_candidate_id=ak.knowledge_candidate_id
        join memory_v1.provenance_edges pe on pe.workspace_id=ce.workspace_id and pe.provenance_edge_id=ce.provenance_edge_id
        join memory_v1.content_blocks b on b.workspace_id=pe.workspace_id and b.content_block_id=pe.content_block_id
        cross join lateral jsonb_array_elements(b.representations) as rep
        where rep->>'representation_kind' = pe.representation_kind and rep->>'sha256' = pe.representation_sha256
          and ak.workspace_id=$1 limit 1`, [config.workspaceId]);
      const text = String(sample.rows[0]?.text_value ?? "");
      const term = text.split(/[^A-Za-z]+/).filter((word) => word.length >= 5).sort((a, b) => b.length - a.length)[0];
      if (!term) throw new Error("No probe term available in approved knowledge text.");
      return term;
    });
  } finally { await pool.end(); }
}

async function persistReceipt() {
  const pool = createPool("reader");
  let runId: string;
  try {
    runId = await readOnlyTransaction(pool, config.workspaceId, async (client) =>
      (await client.query("select ingestion_run_id from memory_v1.ingestion_runs where workspace_id=$1 and pipeline_version=$2 order by started_at desc limit 1", [config.workspaceId, config.pipelineVersion])).rows[0]?.ingestion_run_id);
  } finally { await pool.end(); }
  if (!runId) throw new Error("No ingestion run found for the configured pipeline version.");
  return writeAndPersistProofReceipt({
    proofRoot: config.proofRoot,
    proofKind: "review_approval_query",
    workspaceId: config.workspaceId,
    ingestionRunId: runId,
    pipelineVersion: config.pipelineVersion,
    captureId: config.approvedCaptureId,
    archiveTreeSha256: await archiveTreeSha256(config.approvedCapturePath),
    assertions
  });
}

async function expectRejected(name: string, role: "reviewer" | "reader" | "writer", sql: string, expected: RegExp): Promise<void> {
  const pool = createPool(role);
  try {
    let outcome = "unexpected_success";
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [config.workspaceId]);
      await client.query(sql, [config.workspaceId]);
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      outcome = expected.test(String(error)) ? "rejected_as_expected" : `unexpected_error:${String(error)}`;
    } finally { client.release(); }
    if (outcome !== "rejected_as_expected") throw new Error(`${name}: ${outcome}`);
    assertions[name] = "rejected_as_expected";
  } finally { await pool.end(); }
}
