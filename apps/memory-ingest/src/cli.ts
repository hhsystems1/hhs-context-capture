import { ingestApprovedCapture } from "./ingest.js";
import { proveVerticalSlice } from "./prove.js";
import { readOnlyReport } from "./report.js";
import { loadMemoryConfig } from "./config.js";
import { proveAuditCorrections } from "./corrective-prove.js";
import { approveCandidate, listProposedCandidates, rejectCandidate, showCandidate } from "./review.js";
import { queryApprovedKnowledge } from "./query.js";

import { RECONCILIATION_HELP, runPromotionCommand, runReconciliationCommand, parsePromotionArguments, parseReconciliationArguments } from "./reconciliation-commands.js";
import { resolveCandidatePromotionEvidence } from "./promotion.js";

const command = process.argv[2];
if (process.argv.includes("--help")) {
  console.log(`Usage: cli.ts <ingest|report|prove|prove-corrective|review-list|review-show|review-approve|review-reject|query|reconcile|promote|review-evidence>
${RECONCILIATION_HELP}`);
} else {
if (command === "promote") parsePromotionArguments(process.argv.slice(3));
if (command === "reconcile") parseReconciliationArguments(process.argv.slice(3), process.env.MEMORY_WORKSPACE_ID);
const config = loadMemoryConfig();
const ingestOptions = {
  archiveRoot: config.archiveRoot,
  capturePath: config.approvedCapturePath,
  captureId: config.approvedCaptureId,
  workspaceId: config.workspaceId,
  pipelineVersion: config.pipelineVersion
};

function positional(index: number, name: string): string {
  const value = process.argv[3 + index]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}
function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

if (command === "promote") console.log(JSON.stringify(await runPromotionCommand(process.argv.slice(3)), null, 2));
else if (command === "reconcile") {
  const result = await runReconciliationCommand(process.argv.slice(3), config.workspaceId);
  console.log(JSON.stringify(result, null, 2));
  if ("valid" in result && result.valid === false) process.exitCode = 1;
}
else if (command === "review-evidence") console.log(JSON.stringify(await resolveCandidatePromotionEvidence(config.workspaceId, positional(0, "knowledge_candidate_id"), flag("source-workspace")), null, 2));
else if (command === "ingest") console.log(JSON.stringify(await ingestApprovedCapture(ingestOptions), null, 2));
else if (command === "report") console.log(JSON.stringify(await readOnlyReport(config.workspaceId), null, 2));
else if (command === "prove") console.log(JSON.stringify(await proveVerticalSlice(config), null, 2));
else if (command === "prove-corrective") console.log(JSON.stringify(await proveAuditCorrections(config), null, 2));
else if (command === "review-list") console.log(JSON.stringify({ workspace_id: config.workspaceId, proposed_candidates: await listProposedCandidates(config.workspaceId) }, null, 2));
else if (command === "review-show") console.log(JSON.stringify(await showCandidate(config.workspaceId, positional(0, "knowledge_candidate_id")), null, 2));
else if (command === "review-approve") console.log(JSON.stringify(await approveCandidate({ workspaceId: config.workspaceId, candidateId: positional(0, "knowledge_candidate_id"), reviewerId: flag("reviewer"), rationale: flag("rationale") }), null, 2));
else if (command === "review-reject") console.log(JSON.stringify(await rejectCandidate({ workspaceId: config.workspaceId, candidateId: positional(0, "knowledge_candidate_id"), reviewerId: flag("reviewer"), rationale: flag("rationale") }), null, 2));
else if (command === "query") console.log(JSON.stringify(await queryApprovedKnowledge(config.workspaceId, positional(0, "question")), null, 2));
else throw new Error("Usage: cli.ts <ingest|report|prove|prove-corrective|review-list|review-show|review-approve|review-reject|query|reconcile|promote|review-evidence>");

}
