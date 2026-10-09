import { readFile } from "node:fs/promises";
import { createPool, readOnlyTransaction, transaction } from "./db.js";
import { prepareReconciliationInputFromClient, validateReconciliationOutput, persistValidatedReconciliation } from "./reconciliation.js";
import { promoteReconciliation, type PromotionRequest } from "./promotion.js";

export const RECONCILIATION_HELP = `Operator-resolved arguments only; never derive workspaces or brain bindings from model output.
reconcile <prepare|persist> [--workspace ID] --observations ID,ID [--output FILE]
promote --source-workspace ID --reconciliation-id ID --destination-workspace ID --brain-type personal|organization|project --target-ref REF
review-evidence CANDIDATE_ID --source-workspace ID (explicitly authorized source scope)`;

export function requiredArgument(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required.`);
  if (args.lastIndexOf(`--${name}`) !== index) throw new Error(`--${name} must be supplied exactly once.`);
  return value;
}

export function parsePromotionArguments(args: string[]): PromotionRequest {
  const sourceWorkspaceId = requiredArgument(args, "source-workspace");
  const reconciliationId = requiredArgument(args, "reconciliation-id");
  const destinationWorkspaceId = requiredArgument(args, "destination-workspace");
  const brainType = requiredArgument(args, "brain-type");
  const targetRef = requiredArgument(args, "target-ref");
  if (!["personal", "organization", "project"].includes(brainType)) throw new Error("--brain-type must be personal, organization or project.");
  return { sourceWorkspaceId, reconciliationId, destinationWorkspaceId,
    destination: { brain_type: brainType as PromotionRequest["destination"]["brain_type"], target_ref: targetRef } };
}

export function parseReconciliationArguments(args: string[], defaultWorkspace?: string) {
  const mode = args[0];
  if (mode !== "prepare" && mode !== "persist") throw new Error("reconcile requires prepare or persist.");
  const workspaceId = args.includes("--workspace") ? requiredArgument(args, "workspace") : defaultWorkspace?.trim();
  if (!workspaceId) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");
  const observationIds = requiredArgument(args, "observations").split(",").map((id) => id.trim());
  if (observationIds.some((id) => !id)) throw new Error("--observations requires non-empty observation IDs.");
  const outputPath = mode === "persist" ? requiredArgument(args, "output") : undefined;
  return { mode, workspaceId, observationIds, outputPath };
}

export async function runPromotionCommand(args: string[]) {
  const request = parsePromotionArguments(args); // Validate before any pool exists.
  return promoteReconciliation(request);
}

export async function runReconciliationCommand(args: string[], defaultWorkspace?: string) {
  const request = parseReconciliationArguments(args, defaultWorkspace);
  const output: unknown = request.outputPath ? JSON.parse(await readFile(request.outputPath, "utf8")) : undefined;
  const pool = createPool(request.mode === "prepare" ? "reader" : "writer");
  try {
    if (request.mode === "prepare") return await readOnlyTransaction(pool, request.workspaceId,
      (client) => prepareReconciliationInputFromClient(client, request.workspaceId, request.observationIds));
    return await transaction(pool, request.workspaceId, async (client) => {
      const trusted = await prepareReconciliationInputFromClient(client, request.workspaceId, request.observationIds);
      const result = validateReconciliationOutput(trusted, output);
      if (!result.valid) return { valid: false, issues: result.issues };
      return { valid: true, ...await persistValidatedReconciliation(client, request.workspaceId, result.valid) };
    });
  } finally { await pool.end(); }
}
