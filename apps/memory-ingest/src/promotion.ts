import { deterministicId, sha256 } from "@hhs/memory-schema";
import { createPool, transaction, readOnlyTransaction, type DbClient } from "./db.js";
import { immutableRow, loadCandidatePromotionReceipt } from "./review.js";
import { prepareReconciliationInputFromClient, validateReconciliationOutput, RECONCILIATION_OUTPUT_SCHEMA, RECONCILIATION_PIPELINE_VERSION, type ReconciliationDestination, hasSupportingUserEvidence, statementOccursInEvidence, STATEMENT_EVIDENCE_OVERLAP } from "./reconciliation.js";

export const PROMOTION_PIPELINE_VERSION = "memory-promotion/0.2.0";

export const PROMOTION_EXCERPT_LIMIT = 240;
export const PROMOTION_MAX_OBSERVATIONS = 64;
export const PROMOTION_MAX_EDGES_PER_OBSERVATION = 128;
export const PROMOTION_MAX_LINEAGE_BYTES = 262144;

/** Operator-resolved scope. Never accept this request from reconciliation model output. */
export interface PromotionRequest {
  sourceWorkspaceId: string;
  reconciliationId: string;
  destinationWorkspaceId: string;
  destination: ReconciliationDestination;
}

export interface PromotionPackage {
  workspace_id: string;
  pipeline_version: typeof PROMOTION_PIPELINE_VERSION;
  kind: string;
  source_lineage: Array<Record<string, unknown>>;
  source_lineage_sha256: string;
  promoted_value: Record<string, unknown>;
  promoted_value_sha256: string;
  created_at: string;
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  return value;
}

export function assertImmutablePromotionSource(row: Record<string, unknown>): void {
  const { record_sha256: expected, ...body } = row;
  const bodies = [body];
  // Existing provenance writers omit the unused source-family column. SQL
  // materializes it as NULL; accept that exact historical hashing convention.
  if (row.target_record_type === "observation") {
    for (const key of ["source_version_id", "capture_version_id"]) {
      if (body[key] === null) for (const candidate of [...bodies]) {
        const withoutNull = { ...candidate };
        delete withoutNull[key];
        bodies.push(withoutNull);
      }
    }
  }
  if (!bodies.some((candidate) => sha256(normalized(candidate)) === expected)) throw new Error("Promotion source immutable hash mismatch.");
  if (row.payload_sha256 !== undefined && sha256(row.payload) !== row.payload_sha256) throw new Error("Promotion source payload hash mismatch.");
}

/** Source-scoped read only. All IDs, versions, hashes, relations and authority come from persisted rows. */
export async function preparePromotionFromClient(client: DbClient, request: PromotionRequest): Promise<PromotionPackage> {
  if (![request.sourceWorkspaceId, request.reconciliationId, request.destinationWorkspaceId, request.destination.target_ref].every((v) => v.trim())) {
    throw new Error("Promotion requires source, reconciliation and destination scope.");
  }
  const source = await client.query("select * from memory_v1.reconciliations where workspace_id=$1 and reconciliation_id=$2", [request.sourceWorkspaceId, request.reconciliationId]);
  if (source.rowCount !== 1) throw new Error("Promotion source reconciliation not found in source workspace.");
  const row = source.rows[0];
  assertImmutablePromotionSource(row);
  if (row.pipeline_version !== RECONCILIATION_PIPELINE_VERSION) throw new Error("Unsupported reconciliation pipeline for promotion.");
  const links = await client.query("select * from memory_v1.reconciliation_observations where workspace_id=$1 and reconciliation_id=$2 and pipeline_version=$3 order by observation_id, observation_pipeline_version, relation", [request.sourceWorkspaceId, request.reconciliationId, row.pipeline_version]);
  if ((links.rowCount ?? 0) > PROMOTION_MAX_OBSERVATIONS) throw new Error("Promotion observation limit exceeded.");
  if (!links.rowCount) throw new Error("Promotion requires persisted observation lineage.");
  const trusted = await prepareReconciliationInputFromClient(client, request.sourceWorkspaceId, links.rows.map((link) => String(link.observation_id)));
  const observations: Array<Record<string, unknown>> = [];
  for (const link of links.rows) {
    assertImmutablePromotionSource(link);
    const expectedLink = deterministicId("reconciliation_observation", request.sourceWorkspaceId, [row.pipeline_version, row.reconciliation_id, link.observation_id, link.observation_pipeline_version, link.relation]);
    if (link.reconciliation_observation_id !== expectedLink) throw new Error("Promotion observation lineage identity mismatch.");
    const result = await client.query("select * from memory_v1.observations where workspace_id=$1 and observation_id=$2 and pipeline_version=$3", [request.sourceWorkspaceId, link.observation_id, link.observation_pipeline_version]);
    if (result.rowCount !== 1) throw new Error("Promotion observation lineage version mismatch.");
    const observation = result.rows[0];
    assertImmutablePromotionSource(observation);
    if (observation.status === "rejected") throw new Error("Promotion cannot use rejected observations.");
    const evidence = await client.query(PROMOTION_EVIDENCE_SQL, [request.sourceWorkspaceId, link.observation_id, link.observation_pipeline_version]);
    if ((evidence.rowCount ?? 0) > PROMOTION_MAX_EDGES_PER_OBSERVATION) throw new Error("Promotion evidence edge limit exceeded.");
    if (!evidence.rowCount) throw new Error("Promotion observation requires exact provenance evidence.");
    const verified = evidence.rows.map(verifyPromotionEvidence);
    const verifiedEvidence = verified.map((item) => item.snapshot);
    const trustedObservation = trusted.observations.find((item) => item.observation_id === observation.observation_id)!;
    trustedObservation.evidence = verified.map((item) => ({ role: String(item.snapshot.role), relation: String(item.snapshot.relation),
      statement_bearing: statementOccursInEvidence(trustedObservation.statement, item.text) }));
    if (trustedObservation.attribution.subject === "user" && !trustedObservation.evidence.some((edge) => edge.role === "user")) {
      throw new Error("Promotion observation attribution mismatch: user subject has no user-authored evidence.");
    }
    observations.push({ observation_id: observation.observation_id, pipeline_version: observation.pipeline_version,
      relation: link.relation, record_sha256: observation.record_sha256,
      statement_excerpt: observation.payload.statement.slice(0,PROMOTION_EXCERPT_LIMIT), statement_length: observation.payload.statement.length, excerpt_limit: PROMOTION_EXCERPT_LIMIT,
      reconciliation_observation_id: link.reconciliation_observation_id, reconciliation_observation_sha256: link.record_sha256,
      evidence: verifiedEvidence });
  }
  const payload = row.payload;
  if (["user", "company"].includes(payload.authority) && !hasSupportingUserEvidence(
    links.rows.map((link) => ({ observation_id: link.observation_id, relation: link.relation })), trusted.observations)) {
    throw new Error(`Promotion user/company authority requires supporting user-authored evidence: select an observation whose verified user citation meets STATEMENT_EVIDENCE_OVERLAP=${STATEMENT_EVIDENCE_OVERLAP} or contains a quoted span from its statement.`);
  }
  const validation = validateReconciliationOutput(trusted, {
    schema_version: RECONCILIATION_OUTPUT_SCHEMA, source_workspace_id: request.sourceWorkspaceId,
    reconciliations: [{ reconciliation_ref: row.reconciliation_id, kind: row.kind,
      statement: payload.statement, authority: payload.authority, temporal_status: payload.temporal_status, destination: payload.destination,
      observations: links.rows.map((link) => ({ observation_id: link.observation_id, relation: link.relation })) }]
  });
  if (!validation.valid) throw new Error(`Promotion source reconciliation invalid: ${validation.issues.map((issue) => issue.problem).join("; ")}`);
  if (payload.temporal_status === "rejected") throw new Error("Promotion cannot use a rejected reconciliation.");
  if (sha256(payload.destination) !== sha256(request.destination)) throw new Error("Promotion destination differs from trusted requested brain scope.");
  const sourceLineage = [{ source_workspace_id: request.sourceWorkspaceId, reconciliation_id: row.reconciliation_id,
    pipeline_version: row.pipeline_version, record_sha256: row.record_sha256, observations,
    destination: { workspace_id: request.destinationWorkspaceId, ...request.destination } }];
  if (Buffer.byteLength(JSON.stringify(sourceLineage),"utf8") > PROMOTION_MAX_LINEAGE_BYTES) throw new Error("Promotion lineage byte limit exceeded.");
  if (payload.statement.length > 10000) throw new Error("Promoted statement length limit exceeded.");
  const promotedValue = { statement: payload.statement, authority: payload.authority, temporal_status: payload.temporal_status,
    destination: { workspace_id: request.destinationWorkspaceId, ...request.destination } };
  return { workspace_id: request.destinationWorkspaceId, pipeline_version: PROMOTION_PIPELINE_VERSION, kind: row.kind,
    source_lineage: sourceLineage, source_lineage_sha256: sha256(sourceLineage), promoted_value: promotedValue,
    promoted_value_sha256: sha256(promotedValue), created_at: String(normalized(row.created_at)) };
}

/** Must run inside a transaction. Reload source, then switch to destination RLS scope and append atomically. */
export async function promoteReconciliationFromClient(client: DbClient, request: PromotionRequest) {
  await client.query("select set_config('memory_v1.workspace_id',$1,true)", [request.sourceWorkspaceId]);
  const pack = await preparePromotionFromClient(client, request);
  await client.query("select set_config('memory_v1.workspace_id',$1,true)", [request.destinationWorkspaceId]);
  const workspace = await client.query("select status from memory_v1.workspaces where workspace_id=$1", [request.destinationWorkspaceId]);
  if (workspace.rowCount !== 1 || workspace.rows[0].status !== "active") throw new Error("Promotion destination workspace must be active.");
  // Hashes are excluded from identity deliberately: changed content behind the same source/scope collides.
  const natural = [PROMOTION_PIPELINE_VERSION, request.sourceWorkspaceId, request.reconciliationId, request.destination];
  const receiptId = deterministicId("promotion_receipt", pack.workspace_id, natural);
  // promoted_at is DB-issued, write-once, and excluded from the deterministic hash.
  const receipt = immutableRow("promotion_receipt", pack.workspace_id, natural, { ...pack, promotion_receipt_id: receiptId });
  const receiptResult = await promotionImmutableInsert(client, "promotion_receipts", "promotion_receipt_id", receipt);
  const candidateNatural = [PROMOTION_PIPELINE_VERSION, receiptId];
  const candidateId = deterministicId("knowledge_candidate", pack.workspace_id, candidateNatural);
  const candidate = immutableRow("knowledge_candidate", pack.workspace_id, candidateNatural, {
    workspace_id: pack.workspace_id, knowledge_candidate_id: candidateId, pipeline_version: pack.pipeline_version,
    chunk_id: null, promotion_receipt_id: receiptId, kind: pack.kind, status: "proposed",
    proposed_value: pack.promoted_value, proposed_value_sha256: pack.promoted_value_sha256, created_at: pack.created_at
  });
  const candidateResult = await promotionImmutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", candidate);
  return { promotion_receipt_id: receiptId, knowledge_candidate_id: candidateId, replay: receiptResult === "existing" && candidateResult === "existing" };
}

export async function promoteReconciliation(request: PromotionRequest) {
  const pool = createPool("writer");
  try { return await transaction(pool, request.sourceWorkspaceId, (client) => promoteReconciliationFromClient(client, request)); }
  finally { await pool.end(); }
}

/** Handles concurrent identical replay without losing collision detection. */
export async function promotionImmutableInsert(client: DbClient, table: "promotion_receipts" | "knowledge_candidates", idColumn: "promotion_receipt_id" | "knowledge_candidate_id", row: Record<string, unknown>): Promise<"inserted" | "existing"> {
  const columns = Object.keys(row);
  const inserted = await client.query(`insert into memory_v1.${table} (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) on conflict do nothing returning record_sha256`, columns.map((key) => Array.isArray(row[key]) ? JSON.stringify(row[key]) : row[key]));
  if (inserted.rowCount) return "inserted";
  const prior = await client.query(`select record_sha256 from memory_v1.${table} where workspace_id=$1 and ${idColumn}=$2`, [row.workspace_id, row[idColumn]]);
  if (prior.rowCount !== 1 || prior.rows[0].record_sha256 !== row.record_sha256) throw new Error(`Immutable idempotency collision in ${table}.`);
  return "existing";
}

const PROMOTION_EVIDENCE_SQL = `
      select p.*, m.role, m.source_message_id, m.sequence,
             b.representations, sr.immutable_evidence_locator, sr.source_sha256,
             sv.immutable_source_locator, sv.source_metadata, sv.verification_status as source_verification, sv.source_family, sv.source_observed_at, conv.source_conversation_id,
             cv.immutable_archive_locator, cv.verification_status as capture_verification,
             b.source_record_id as block_source_record_id, b.message_id as block_message_id,
             b.source_version_id as block_source_version_id, b.capture_version_id as block_capture_version_id,
             m.conversation_id as message_conversation_id, m.source_version_id as message_source_version_id,
             m.capture_version_id as message_capture_version_id
      from memory_v1.provenance_edges p
      join memory_v1.content_blocks b on b.workspace_id=p.workspace_id and b.content_block_id=p.content_block_id
      join memory_v1.messages m on m.workspace_id=p.workspace_id and m.message_id=p.message_id
      join memory_v1.conversations conv on conv.workspace_id=p.workspace_id and conv.conversation_id=p.conversation_id
      join memory_v1.source_records sr on sr.workspace_id=p.workspace_id and sr.source_record_id=p.source_record_id
      left join memory_v1.source_versions sv on sv.workspace_id=p.workspace_id and sv.source_version_id=p.source_version_id
      left join memory_v1.capture_versions cv on cv.workspace_id=p.workspace_id and cv.capture_version_id=p.capture_version_id
      where p.workspace_id=$1 and p.target_record_id=$2 and p.pipeline_version=$3 and p.target_record_type='observation'
      order by p.provenance_edge_id`;

function verifyPromotionEvidence(edge: Record<string, unknown>): { snapshot: Record<string, unknown>; text: string } {
  const { role, source_message_id, sequence, representations, immutable_evidence_locator, source_sha256,
    immutable_source_locator, source_metadata, source_verification, source_family, source_observed_at, source_conversation_id, immutable_archive_locator, capture_verification,
    block_source_record_id, block_message_id, block_source_version_id, block_capture_version_id,
    message_conversation_id, message_source_version_id, message_capture_version_id, ...provenance } = edge;
  assertImmutablePromotionSource(provenance);
  if (block_source_record_id !== edge.source_record_id || block_message_id !== edge.message_id || message_conversation_id !== edge.conversation_id ||
      block_source_version_id !== edge.source_version_id || message_source_version_id !== edge.source_version_id ||
      block_capture_version_id !== edge.capture_version_id || message_capture_version_id !== edge.capture_version_id) {
    throw new Error("Promotion provenance does not resolve exact source lineage.");
  }
  const representation = (representations as Array<Record<string, unknown>>).find((rep: Record<string, unknown>) => rep.representation_kind === edge.representation_kind && rep.sha256 === edge.representation_sha256);
  if (!representation || typeof representation.value !== "string" || sha256(representation.value) !== edge.representation_sha256) throw new Error("Promotion provenance representation hash mismatch.");
  if ((edge.source_version_id ? source_verification : capture_verification) !== "complete") throw new Error("Promotion requires verified source evidence.");
  const snapshot = normalized({ ...provenance, role, source_message_id, sequence,
    text_excerpt: String(representation.value).slice(0, PROMOTION_EXCERPT_LIMIT), text_length: String(representation.value).length, excerpt_limit: PROMOTION_EXCERPT_LIMIT,
    immutable_evidence_locator, source_sha256, immutable_source_locator, immutable_archive_locator,
    source_metadata: { source_family, source_conversation_id, source_observed_at }, source_metadata_sha256: sha256(source_metadata) }) as Record<string, unknown>;
  return { snapshot, text: String(representation.value) };

}

/** Full evidence is read only under an explicitly operator-authorized source scope. */
export async function resolvePromotionEvidenceFromClient(client: DbClient, sourceWorkspaceId: string, receipt: Record<string, unknown>) {
  const lineage = receipt.source_lineage as Array<Record<string, unknown>>;
  const resolved: Array<Record<string, unknown>> = [];
  if (sha256(lineage) !== receipt.source_lineage_sha256) throw new Error("Receipt lineage hash mismatch.");
  for (const source of lineage) {
    if (source.source_workspace_id !== sourceWorkspaceId) throw new Error("Receipt evidence is outside the authorized source workspace.");
    const reconciliation = await client.query("select * from memory_v1.reconciliations where workspace_id=$1 and reconciliation_id=$2 and pipeline_version=$3", [sourceWorkspaceId, source.reconciliation_id, source.pipeline_version]);
    if (reconciliation.rowCount !== 1 || reconciliation.rows[0].record_sha256 !== source.record_sha256) throw new Error("Source reconciliation hash mismatch or source inaccessible.");
    assertImmutablePromotionSource(reconciliation.rows[0]);
    for (const observation of source.observations as Array<Record<string, unknown>>) {
      const persisted = await client.query("select * from memory_v1.observations where workspace_id=$1 and observation_id=$2 and pipeline_version=$3", [sourceWorkspaceId, observation.observation_id, observation.pipeline_version]);
      if (persisted.rowCount !== 1 || persisted.rows[0].record_sha256 !== observation.record_sha256) throw new Error("Source observation hash mismatch or source inaccessible.");
      assertImmutablePromotionSource(persisted.rows[0]);
      const edges = await client.query(PROMOTION_EVIDENCE_SQL, [sourceWorkspaceId, observation.observation_id, observation.pipeline_version]);
      const verified = edges.rows.map(verifyPromotionEvidence);
      for (const expected of observation.evidence as Array<Record<string, unknown>>) {
        const actual = verified.find((item) => item.snapshot.provenance_edge_id === expected.provenance_edge_id);
        if (!actual || sha256(actual.snapshot) !== sha256(expected)) throw new Error("Source evidence hash mismatch or source inaccessible.");
        resolved.push({ source_workspace_id: sourceWorkspaceId, observation_id: observation.observation_id,
          provenance_edge_id: expected.provenance_edge_id, representation_sha256: expected.representation_sha256, text_value: actual.text });
      }
    }
  }
  return resolved;
}

export async function resolveCandidatePromotionEvidence(destinationWorkspaceId: string, candidateId: string, authorizedSourceWorkspaceId: string) {
  const pool = createPool("reader");
  try {
    const receipt = await readOnlyTransaction(pool, destinationWorkspaceId, async (client) => {
      const candidate = await client.query("select * from memory_v1.knowledge_candidates where workspace_id=$1 and knowledge_candidate_id=$2", [destinationWorkspaceId, candidateId]);
      if (candidate.rowCount !== 1) throw new Error("Candidate not found in destination workspace.");
      const value = await loadCandidatePromotionReceipt(client,destinationWorkspaceId,candidate.rows[0]);
      if (!value) throw new Error("Candidate has no promotion receipt.");
      return value;
    });
    return await readOnlyTransaction(pool, authorizedSourceWorkspaceId, (client) => resolvePromotionEvidenceFromClient(client, authorizedSourceWorkspaceId, receipt));
  } finally { await pool.end(); }
}
