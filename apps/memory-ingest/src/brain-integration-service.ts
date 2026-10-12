import { pathToFileURL } from "node:url";
import { sha256 } from "@hhs/memory-schema";
import { createPool, transaction, type DbClient } from "./db.js";
import { assertLocalDatabaseUrl } from "./config.js";
import { bridgeConfig, bridgeServer, BridgeError, grantFor, exactKeys, safeRef, type BrainGrant, type BridgeConfig } from "./brain-bridge-http.js";
import { prepareReconciliationInputFromClient, validateReconciliationOutput, persistValidatedReconciliation, hasSupportingUserEvidence, RECONCILIATION_OUTPUT_SCHEMA, type ReconciliationKind, type ReconciliationTemporalStatus } from "./reconciliation.js";
import { promoteReconciliationFromClient } from "./promotion.js";

export interface ReconcileInput { conversation: string; observationIds: string[]; statement: string; kind: ReconciliationKind; temporalStatus: ReconciliationTemporalStatus }
export function loadIntegrationConfig(env: Record<string, string | undefined>) {
  if (["MEMORY_DATABASE_URL", "MEMORY_REPORT_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL", "MEMORY_QUERY_SERVICE_TOKENS", "MEMORY_CONTEXT_REVIEW_TOKENS"].some(key => env[key]?.trim())) throw new Error("Integration requires isolated ingest credentials.");
  if (assertLocalDatabaseUrl(env.MEMORY_INGEST_DATABASE_URL ?? "").username !== "memory_v1_ingest_login") throw new Error("Integration requires existing ingest login.");
  return bridgeConfig(env, "MEMORY_CONTEXT_INTEGRATION", 54434);
}
export function parseReconcileInput(body: Record<string, unknown>): ReconcileInput {
  exactKeys(body, ["sourceRef", "destinationWorkspaceId", "targetRef", "conversation", "observationIds", "statement", "kind", "temporalStatus"]);
  if (!safeRef(body.conversation) || !Array.isArray(body.observationIds) || body.observationIds.length < 1 || body.observationIds.length > 8 ||
    body.observationIds.some(id => !safeRef(id)) || new Set(body.observationIds).size !== body.observationIds.length ||
    typeof body.statement !== "string" || !body.statement.trim() || body.statement.length > 10000 ||
    !["claim", "idea", "entity", "relationship", "use_case", "decision", "task", "sop"].includes(String(body.kind)) ||
    !["historical", "current", "unknown", "superseded"].includes(String(body.temporalStatus))) throw new BridgeError(400, "invalid_request");
  return { conversation: body.conversation, observationIds: (body.observationIds as string[]).sort(), statement: body.statement.trim(),
    kind: body.kind as ReconciliationKind, temporalStatus: body.temporalStatus as ReconciliationTemporalStatus };
}
export async function reconcileAndPromoteFromClient(client: DbClient, grant: BrainGrant, input: ReconcileInput) {
  await client.query("set local statement_timeout=10000");
  await client.query("set local lock_timeout=5000");
  const membership = await client.query(`select o.observation_id from memory_v1.observations o
    join memory_v1.conversations c on c.workspace_id=o.workspace_id and c.conversation_id=o.conversation_id
    where o.workspace_id=$1 and c.source_conversation_id=$2 and o.observation_id=any($3::text[]) and o.status <> 'rejected'`,
    [grant.sourceWorkspaceId, input.conversation, input.observationIds]);
  if (membership.rowCount !== input.observationIds.length) throw new BridgeError(404, "source_record_not_found");
  const trusted = await prepareReconciliationInputFromClient(client, grant.sourceWorkspaceId, input.observationIds);
  if (trusted.observations.some(observation => observation.attribution.subject === "user" &&
    !hasSupportingUserEvidence([{ observation_id: observation.observation_id, relation: "supports" }], [observation]))) throw new BridgeError(422, "reconciliation_evidence_invalid");
  const subjects = new Set(trusted.observations.map(o => o.attribution.subject));
  const authority = subjects.size > 1 ? "mixed" : subjects.has("user") ? "user" : subjects.has("assistant") ? "assistant" : "unresolved";
  const destination = { brain_type: "personal" as const, target_ref: grant.targetRef };
  const ref = `rivryn_${sha256({ input, source: grant.sourceWorkspaceId, destination: grant.destinationWorkspaceId, target: destination }).slice(0, 32)}`;
  // Serialize exact replays before the existing immutable insert path; one transaction
  // contains reconciliation and promotion, so a failed promotion leaves no partial write.
  await client.query("select pg_advisory_xact_lock($1::bigint)", [BigInt.asIntN(64, BigInt(`0x${sha256(ref).slice(0, 16)}`)).toString()]);
  const validation = validateReconciliationOutput(trusted, {
    schema_version: RECONCILIATION_OUTPUT_SCHEMA, source_workspace_id: grant.sourceWorkspaceId,
    reconciliations: [{ reconciliation_ref: ref, kind: input.kind, statement: input.statement, authority,
      temporal_status: input.temporalStatus, destination, observations: input.observationIds.map(observation_id => ({ observation_id, relation: "supports" })) }],
  });
  if (!validation.valid) throw new BridgeError(422, "reconciliation_evidence_invalid");
  const persisted = await persistValidatedReconciliation(client, grant.sourceWorkspaceId, validation.valid);
  const reconciliationId = persisted.reconciliation_ids[ref]!;
  const promoted = await promoteReconciliationFromClient(client, { sourceWorkspaceId: grant.sourceWorkspaceId,
    destinationWorkspaceId: grant.destinationWorkspaceId, reconciliationId, destination });
  return { reconciliation_id: reconciliationId, ...promoted, status: "proposed", authority, temporal_status: input.temporalStatus };
}
export async function reconcileAndPromote(grant: BrainGrant, input: ReconcileInput) {
  const pool = createPool("writer");
  try { return await transaction(pool, grant.sourceWorkspaceId, client => reconcileAndPromoteFromClient(client, grant, input)); }
  finally { await pool.end(); }
}
export function createIntegrationService(config: BridgeConfig, run = reconcileAndPromote) {
  return bridgeServer(config, async (method, route, body) => {
    if (method !== "POST" || route !== "/memory/integration/reconcile") throw new BridgeError(404, "unknown_route");
    const input = parseReconcileInput(body);
    return run(grantFor(config, body), input);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadIntegrationConfig(process.env);
  createIntegrationService(config).listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ service: "brain-integration", port: config.port, database_role: "ingest", status: "ready" })));
}
