/** Disposable local operator acceptance data; never uses a real source workspace. */
import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { createPool, transaction } from "../apps/memory-ingest/src/db.js";
import { immutableRow } from "../apps/memory-ingest/src/review.js";
import { immutableInsert } from "../apps/memory-ingest/src/db.js";
import { seedReconciliationFixture, seedLegacyReviewFixture } from "../apps/memory-ingest/src/reconciliation-proof-fixture.js";
import type { ReconciliationInput, ReconciliationOutput } from "../apps/memory-ingest/src/reconciliation.js";

const source = "reconciliation-review-acceptance-source-20261006";
const destination = "reconciliation-review-acceptance-brain-20261006";
const manifestPath = "/tmp/hhs-reconciliation-review-proof.json";

function cli<T>(workspace: string, args: string[]): T {
  return JSON.parse(execFileSync(process.execPath, ["--env-file=.env.memory-v1.local", "--import", "tsx", "apps/memory-ingest/src/cli.ts", ...args],
    { encoding: "utf8", env: { ...process.env, MEMORY_WORKSPACE_ID: workspace } })) as T;
}

if (process.argv.includes("--complete")) {
  const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
  const decision = cli<{ approved_knowledge_id: string }>(destination,["review-approve",manifest.acceptanceCandidateId,"--reviewer","disposable-acceptance-human","--rationale","Machinery acceptance: verified disposable source evidence"]);
  const found = cli<{ matches: Array<Record<string, unknown>> }>(destination,["query","business"]);
  if (!found.matches.some((item) => item.approved_knowledge_id === decision.approved_knowledge_id && item.promotion_receipt_id && item.message_id === null && item.provenance_edge_id === null)) throw new Error("Approved receipt lineage was not retrieved.");
  console.log(JSON.stringify({ complete: true, approved_knowledge_id: decision.approved_knowledge_id, matches: found.matches.length }));
} else {
  const pool = createPool("writer");
  let userObservationId: string;
  let legacyCandidateId: string;
  try {
    const fixture = await transaction(pool,source,async (client) => {
      const seeded = await seedReconciliationFixture(client,source);
      return { ...seeded, legacyCandidateId: await seedLegacyReviewFixture(client,source,seeded.userObservationId) };
    });
    userObservationId = fixture.userObservationId;
    legacyCandidateId = fixture.legacyCandidateId;
    await transaction(pool,destination,(client) => immutableInsert(client,"workspaces","workspace_id",immutableRow("workspace",destination,["acceptance"], {
      workspace_id: destination,name: "Disposable promotion acceptance brain",isolation_key: destination,status: "active",created_at: "2026-10-05T00:00:00.000Z"
    })));
  } finally { await pool.end(); }
  const input = cli<ReconciliationInput>(source,["reconcile","prepare","--observations",userObservationId]);
  if (input.source_workspace_id !== source || input.observations.length !== 1) throw new Error("Prepared source input mismatch.");
  const output: ReconciliationOutput = { schema_version: "hhs-reconciliation-output/0.1.0", source_workspace_id: source,
    reconciliations: ["acceptance-promote","reviewer-rollback-promote"].map((ref) => ({ reconciliation_ref: ref,kind: "decision",statement: "HHS Core 2 is the current business OS.",authority: "user",temporal_status: "current",
      destination: { brain_type: "organization",target_ref: "HHS" },observations: [{ observation_id: userObservationId,relation: "supports" }] })) };
  const outputPath = "/tmp/hhs-reconciliation-acceptance-model-output.json";
  await writeFile(outputPath,JSON.stringify(output));
  const persisted = cli<{ reconciliation_ids: Record<string,string> }>(source,["reconcile","persist","--observations",userObservationId,"--output",outputPath]);
  const ids: Record<string,string> = {};
  for (const ref of ["acceptance-promote","reviewer-rollback-promote"]) {
    const args = ["promote","--source-workspace",source,"--reconciliation-id",persisted.reconciliation_ids[ref]!,"--destination-workspace",destination,"--brain-type","organization","--target-ref","HHS"];
    const first = cli<{ knowledge_candidate_id: string }>(source,args);
    if (!cli<{ replay: boolean }>(source,args).replay) throw new Error("CLI promotion replay failed.");
    ids[ref] = first.knowledge_candidate_id;
  }
  const detail = cli<{ candidate: Record<string,unknown>; promotion_receipt: Record<string,unknown> }>(destination,["review-show",ids["acceptance-promote"]!]);
  if (detail.candidate.chunk_id !== null || !detail.promotion_receipt.source_lineage) throw new Error("CLI review lacks receipt origin.");
  const list = cli<{ proposed_candidates: Array<Record<string,unknown>> }>(destination,["review-list"]);
  if (!list.proposed_candidates.some((item) => item.knowledge_candidate_id === ids["acceptance-promote"])) throw new Error("Candidate absent from operator review list.");
  const evidence = cli<Array<Record<string,unknown>>>(destination,["review-evidence",ids["acceptance-promote"]!,"--source-workspace",source]);
  if (!evidence.some((item) => item.text_value === input.observations[0]!.statement)) throw new Error("Authorized full evidence resolution failed.");
  await writeFile(manifestPath,JSON.stringify({ sourceWorkspaceId: source,destinationWorkspaceId: destination,
    legacyCandidateId,reviewerCandidateId: ids["reviewer-rollback-promote"],acceptanceCandidateId: ids["acceptance-promote"] }));
  console.log(JSON.stringify({ seeded: true,manifest: manifestPath,operatorPreparePersistPromoteReplayReviewEvidence: "passed" }));
}
