/**
 * Provider-neutral understanding discovery.
 *
 * Evidence export, model execution, validation, and persistence are deliberately
 * separate. A model receives a bounded JSON exchange and returns references into
 * it; only this trusted local module resolves hashes and derives database IDs.
 */
import pg from "pg";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert, readOnlyTransaction, transaction, type DbClient } from "./db.js";

export const UNDERSTANDING_DISCOVERY_PIPELINE_VERSION = "memory-understanding-discovery/0.2.0";
export const UNDERSTANDING_INPUT_SCHEMA = "hhs-understanding-input/0.2.0";
export const UNDERSTANDING_OUTPUT_SCHEMA = "hhs-understanding-output/0.2.0";
export const VERIFIED_NATIVE_EXPORT_CONTAINER = "4cdfcdd3b55e4a391575ac41f08871bcc07c8742cc907a0d3603e25299aade12";
export const MAX_DISCOVERY_BATCH_CONVERSATIONS = 50;

export interface PilotCandidate {
  source_conversation_id: string;
  title: string;
  source_family: string;
  observed_at: string;
  message_count: number;
  content_characters: number;
}

export interface DiscoverySelection extends PilotCandidate {
  conversation_id: string;
  source_version_id: string;
  content_sha256: string;
  immutable_source_locator: string;
  source_container_sha256: string | null;
  capture_version_id: string | null;
  capture_manifest_sha256: string | null;
  capture_locator: string | null;
}

export interface DiscoveryEvidence {
  evidence_ref: string;
  source_conversation_id: string;
  conversation_id: string;
  source_family: string;
  source_version_id: string;
  capture_version_id: string | null;
  message_id: string;
  source_message_id: string;
  message_sequence: number;
  role: string;
  active_path: boolean;
  content_block_id: string;
  block_kind: string;
  representation_kind: string;
  text: string;
  representation_sha256: string;
  source_record_id: string;
  immutable_evidence_locator: string;
  source_record_sha256: string;
  source_version_locator: string;
  source_container_sha256: string | null;
  capture_locator: string | null;
  capture_manifest_sha256: string | null;
  resolution_id: string;
  resolution_expected_sha256: string;
  resolution_observed_sha256: string;
  resolution_exact: boolean;
  source_observed_at: string;
}

export interface DiscoveryExchange {
  schema_version: typeof UNDERSTANDING_INPUT_SCHEMA;
  pipeline_version: typeof UNDERSTANDING_DISCOVERY_PIPELINE_VERSION;
  exchange_id: string;
  evidence_sha256: string;
  created_at: string;
  selection: DiscoverySelection[];
  evidence: DiscoveryEvidence[];
  model_instructions: {
    output_schema_version: typeof UNDERSTANDING_OUTPUT_SCHEMA;
    observation_kinds_are_free_text: true;
    link_kinds_are_free_text: true;
    evidence_refs_are_authoritative: true;
    evidence_excerpts_are_optional: true;
    user_authority_requires_user_evidence: true;
    database_ids_or_hashes_required: false;
    model_metadata_required: false;
  };
}

export interface DiscoveryCitationOutput {
  evidence_ref: string;
  /** Optional model-authored display text. Never used as canonical evidence. */
  excerpt?: string;
  role?: "supporting" | "context" | "contradicting";
}

/** Supplied by the trusted local runner, never by model output. */
export interface TrustedDiscoveryModel {
  provider: string;
  name: string;
  version?: string;
  runner_version: string;
}

export interface DiscoveryObservationOutput {
  observation_ref: string;
  source_conversation_id: string;
  observation_kind: string;
  statement: string;
  payload: Record<string, unknown>;
  attribution: { subject: "user" | "assistant" | "other" | "unresolved"; claim_type: string };
  confidence: number;
  evidence: DiscoveryCitationOutput[];
}

export interface DiscoveryLinkOutput {
  from_observation_ref: string;
  to_observation_ref: string;
  link_kind: string;
  payload?: Record<string, unknown>;
  confidence?: number;
}

export interface DiscoveryOutput {
  schema_version: typeof UNDERSTANDING_OUTPUT_SCHEMA;
  exchange_id: string;
  observations: DiscoveryObservationOutput[];
  links?: DiscoveryLinkOutput[];
}

export interface DiscoveryValidationIssue { record_ref: string; problem: string }
export interface ValidatedDiscoveryObservation extends DiscoveryObservationOutput {
  citations: Array<DiscoveryCitationOutput & {
    evidence_row: DiscoveryEvidence;
    canonical_text: string;
    canonical_text_sha256: string;
  }>;
}
export interface ValidatedDiscoveryLink extends DiscoveryLinkOutput {
  from: ValidatedDiscoveryObservation;
  to: ValidatedDiscoveryObservation;
}
export interface ValidatedDiscoveryOutput {
  output: DiscoveryOutput;
  trusted_model: TrustedDiscoveryModel;
  observations: ValidatedDiscoveryObservation[];
  links: ValidatedDiscoveryLink[];
}

export async function listPilotCandidates(
  workspaceId: string,
  pool: pg.Pool = createPool("reader")
): Promise<PilotCandidate[]> {
  const ownsPool = arguments.length < 2;
  try {
    return await readOnlyTransaction(pool, workspaceId, (client) => listPilotCandidatesFromClient(client, workspaceId));
  } finally { if (ownsPool) await pool.end(); }
}

/** Client-level form used by rollback-only proofs. */
export async function listPilotCandidatesFromClient(client: DbClient, workspaceId: string): Promise<PilotCandidate[]> {
  const result = await client.query(PILOT_CANDIDATES_SQL, [workspaceId, VERIFIED_NATIVE_EXPORT_CONTAINER]);
  return result.rows.map((row): PilotCandidate => ({
    source_conversation_id: String(row.source_conversation_id),
    title: String(row.title ?? ""), source_family: String(row.source_family),
    observed_at: iso(row.observed_at), message_count: Number(row.message_count),
    content_characters: Number(row.content_characters)
  }));
}

/** Deterministic round-robin across family, month, and coarse length buckets. */
export function suggestDiversePilot(candidates: PilotCandidate[], limit = 20): PilotCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_BATCH_CONVERSATIONS) {
    throw new Error(`Pilot limit must be an integer from 1 to ${MAX_DISCOVERY_BATCH_CONVERSATIONS}.`);
  }
  const buckets = new Map<string, PilotCandidate[]>();
  for (const candidate of [...candidates].sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.source_conversation_id.localeCompare(b.source_conversation_id))) {
    const month = candidate.observed_at.slice(0, 7);
    const length = candidate.content_characters < 5_000 ? "short" : candidate.content_characters < 30_000 ? "medium" : "long";
    const key = `${candidate.source_family}:${month}:${length}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate); buckets.set(key, bucket);
  }
  const result: PilotCandidate[] = [];
  const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  while (result.length < limit && ordered.some(([, bucket]) => bucket.length > 0)) {
    for (const [, bucket] of ordered) {
      const next = bucket.shift();
      if (next) result.push(next);
      if (result.length === limit) break;
    }
  }
  return result;
}

export async function prepareDiscoveryExchange(
  workspaceId: string,
  sourceConversationIds: string[],
  pool: pg.Pool = createPool("reader")
): Promise<DiscoveryExchange> {
  const ownsPool = arguments.length < 3;
  try {
    return await readOnlyTransaction(pool, workspaceId,
      (client) => prepareDiscoveryExchangeFromClient(client, workspaceId, sourceConversationIds));
  } finally { if (ownsPool) await pool.end(); }
}

/** Exposed for rollback-only database proofs; production callers use the read-only wrapper above. */
export async function prepareDiscoveryExchangeFromClient(
  client: DbClient,
  workspaceId: string,
  sourceConversationIds: string[],
  createdAt = new Date().toISOString()
): Promise<DiscoveryExchange> {
  const requested = [...new Set(sourceConversationIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0 || requested.length > MAX_DISCOVERY_BATCH_CONVERSATIONS) {
    throw new Error(`Select between 1 and ${MAX_DISCOVERY_BATCH_CONVERSATIONS} conversations.`);
  }
  const selected = await client.query(AUTHORIZED_SELECTION_SQL, [workspaceId, requested, VERIFIED_NATIVE_EXPORT_CONTAINER]);
  const selectedByUuid = new Map<string, Record<string, unknown>>();
  for (const row of selected.rows as Array<Record<string, unknown>>) {
    const uuid = String(row.source_conversation_id);
    if (selectedByUuid.has(uuid)) throw new Error(`Authorized conversation ${uuid} resolves to multiple source versions.`);
    selectedByUuid.set(uuid, row);
  }
  const missing = requested.filter((id) => !selectedByUuid.has(id));
  if (missing.length) throw new Error(`Conversation is outside the authorized clean corpus: ${missing.join(", ")}`);
  const evidenceResult = await client.query(AUTHORIZED_EVIDENCE_SQL, [workspaceId, requested, VERIFIED_NATIVE_EXPORT_CONTAINER]);
  const evidence = (evidenceResult.rows as Array<Record<string, unknown>>).map(toEvidence);
  if (evidence.some((row) => !row.resolution_exact || row.representation_sha256 !== sha256(row.text)
    || row.resolution_expected_sha256 !== row.representation_sha256 || row.resolution_observed_sha256 !== row.representation_sha256)) {
    throw new Error("Selected evidence contains an unresolved representation or hash mismatch.");
  }
  const evidenceByUuid = new Map<string, DiscoveryEvidence[]>();
  for (const row of evidence) {
    const bucket = evidenceByUuid.get(row.source_conversation_id) ?? [];
    bucket.push(row); evidenceByUuid.set(row.source_conversation_id, bucket);
  }
  const selection = requested.map((id): DiscoverySelection => {
    const row = selectedByUuid.get(id)!;
    const rows = evidenceByUuid.get(id) ?? [];
    return {
      source_conversation_id: String(row.source_conversation_id), conversation_id: String(row.conversation_id),
      title: String(row.title ?? ""), source_family: String(row.source_family), observed_at: iso(row.source_observed_at),
      message_count: Number(row.message_count), content_characters: rows.reduce((sum, item) => sum + item.text.length, 0),
      source_version_id: String(row.source_version_id), content_sha256: String(row.content_sha256),
      immutable_source_locator: String(row.immutable_source_locator),
      source_container_sha256: nullableString(row.source_container_sha256), capture_version_id: nullableString(row.capture_version_id),
      capture_manifest_sha256: nullableString(row.capture_manifest_sha256), capture_locator: nullableString(row.capture_locator)
    };
  });
  const evidenceSha = sha256(evidence);
  const exchangeId = deterministicId("discovery_exchange", workspaceId, {
    pipeline: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    selection: selection.map((item) => ({ uuid: item.source_conversation_id, version: item.source_version_id, content: item.content_sha256 })),
    evidence_sha256: evidenceSha
  });
  return {
    schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: exchangeId, evidence_sha256: evidenceSha, created_at: createdAt, selection, evidence,
    model_instructions: {
      output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
      link_kinds_are_free_text: true, evidence_refs_are_authoritative: true,
      evidence_excerpts_are_optional: true, user_authority_requires_user_evidence: true,
      database_ids_or_hashes_required: false, model_metadata_required: false
    }
  };
}


export interface DiscoveryExchangeChunk {
  chunk_number: number;
  chunk_count: number;
  evidence_characters: number;
  exceeds_target: boolean;
  exchange: DiscoveryExchange;
}

/**
 * Deterministically partitions an exchange without splitting a message.
 * A message that individually exceeds the target remains intact and is
 * explicitly marked exceeds_target.
 */
export function splitDiscoveryExchange(
  exchange: DiscoveryExchange,
  maxEvidenceCharacters: number
): DiscoveryExchangeChunk[] {
  if (!Number.isInteger(maxEvidenceCharacters) || maxEvidenceCharacters < 1) {
    throw new Error("maxEvidenceCharacters must be a positive integer.");
  }
  if (exchange.evidence.length === 0) {
    throw new Error("Cannot split an exchange with no evidence.");
  }

  const messageGroups: DiscoveryEvidence[][] = [];
  for (const row of exchange.evidence) {
    const previous = messageGroups.at(-1);
    const sameMessage = previous
      && previous[0]!.source_conversation_id === row.source_conversation_id
      && previous[0]!.message_id === row.message_id
      && previous[0]!.message_sequence === row.message_sequence;
    if (sameMessage) previous.push(row);
    else messageGroups.push([row]);
  }

  const groupedChunks: DiscoveryEvidence[][] = [];
  let current: DiscoveryEvidence[] = [];
  let currentCharacters = 0;

  for (const group of messageGroups) {
    const groupCharacters = group.reduce(
      (sum, row) => sum + JSON.stringify(row).length,
      0
    );
    if (current.length > 0 && currentCharacters + groupCharacters > maxEvidenceCharacters) {
      groupedChunks.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(...group);
    currentCharacters += groupCharacters;
  }
  if (current.length > 0) groupedChunks.push(current);

  return groupedChunks.map((chunkEvidence, index) => {
    const evidenceSha = sha256(chunkEvidence);
    const sourceIds = new Set(
      chunkEvidence.map((row) => row.source_conversation_id)
    );
    const selection = exchange.selection
      .filter((item) => sourceIds.has(item.source_conversation_id))
      .map((item) => {
        const rows = chunkEvidence.filter(
          (row) => row.source_conversation_id === item.source_conversation_id
        );
        return {
          ...item,
          message_count: new Set(rows.map((row) => row.message_id)).size,
          content_characters: rows.reduce((sum, row) => sum + row.text.length, 0)
        };
      });
    const evidenceCharacters = chunkEvidence.reduce(
      (sum, row) => sum + JSON.stringify(row).length,
      0
    );

    return {
      chunk_number: index + 1,
      chunk_count: groupedChunks.length,
      evidence_characters: evidenceCharacters,
      exceeds_target: evidenceCharacters > maxEvidenceCharacters,
      exchange: {
        ...exchange,
        exchange_id: deterministicId(
          "discovery_exchange_chunk",
          exchange.exchange_id,
          { chunk_number: index + 1, evidence_sha256: evidenceSha }
        ),
        evidence_sha256: evidenceSha,
        selection,
        evidence: chunkEvidence
      }
    };
  });
}

/** Pure validator: no database or model access. */
export function validateDiscoveryOutput(
  exchange: DiscoveryExchange,
  candidate: unknown,
  trustedModel: TrustedDiscoveryModel
): { valid?: ValidatedDiscoveryOutput; issues: DiscoveryValidationIssue[] } {
  const normalizedModel = normalizeTrustedModel(trustedModel);
  const issues: DiscoveryValidationIssue[] = [];
  if (exchange.schema_version !== UNDERSTANDING_INPUT_SCHEMA || exchange.pipeline_version !== UNDERSTANDING_DISCOVERY_PIPELINE_VERSION) {
    issues.push({ record_ref: "exchange", problem: "unsupported or mismatched exchange schema/pipeline version" });
  }
  if (sha256(exchange.evidence) !== exchange.evidence_sha256) {
    issues.push({ record_ref: "exchange", problem: "exchange evidence_sha256 mismatch" });
  }
  const selectionsBySource = new Map<string, DiscoverySelection>();
  for (const selection of exchange.selection) {
    if (selectionsBySource.has(selection.source_conversation_id)) {
      issues.push({ record_ref: "exchange", problem: `duplicate selected conversation ${selection.source_conversation_id}` });
    }
    selectionsBySource.set(selection.source_conversation_id, selection);
  }
  const exchangeEvidenceRefs = new Set<string>();
  for (const row of exchange.evidence) {
    const selection = selectionsBySource.get(row.source_conversation_id);
    if (exchangeEvidenceRefs.has(row.evidence_ref)) {
      issues.push({ record_ref: "exchange", problem: `duplicate evidence_ref ${row.evidence_ref}` });
    }
    exchangeEvidenceRefs.add(row.evidence_ref);
    if (!selection || selection.conversation_id !== row.conversation_id
      || selection.source_version_id !== row.source_version_id
      || selection.capture_version_id !== row.capture_version_id) {
      issues.push({ record_ref: "exchange", problem: `evidence_ref ${row.evidence_ref} does not match its selected conversation/version` });
    }
  }
  if (issues.length) return { issues };
  if (!isRecord(candidate)) return { issues: [{ record_ref: "output", problem: "output must be an object" }] };
  if (candidate.schema_version !== UNDERSTANDING_OUTPUT_SCHEMA) issues.push({ record_ref: "output", problem: "unsupported schema_version" });
  if (candidate.exchange_id !== exchange.exchange_id) issues.push({ record_ref: "output", problem: "exchange_id mismatch" });
  if (!Array.isArray(candidate.observations)) issues.push({ record_ref: "output", problem: "observations must be an array" });
  if (candidate.links !== undefined && !Array.isArray(candidate.links)) issues.push({ record_ref: "output", problem: "links must be an array" });
  if (issues.length) return { issues };

  const output = candidate as unknown as DiscoveryOutput;
  const evidenceByRef = new Map(exchange.evidence.map((row) => [row.evidence_ref, row]));
  const selected = new Set(exchange.selection.map((row) => row.source_conversation_id));
  const validObservations: ValidatedDiscoveryObservation[] = [];
  const observationRefs = new Set<string>();
  const normalizedStatements = new Set<string>();

  for (const item of output.observations) {
    if (!isRecord(item)) { issues.push({ record_ref: "observation", problem: "observation must be an object" }); continue; }
    const ref = typeof item.observation_ref === "string" ? item.observation_ref.trim() : "";
    const recordRef = ref || "observation";
    const local: string[] = [];
    if (!ref || observationRefs.has(ref)) local.push("missing or duplicate observation_ref");
    observationRefs.add(ref);
    if (typeof item.observation_kind !== "string" || !item.observation_kind.trim()) local.push("observation_kind must be non-empty free text");
    if (typeof item.statement !== "string" || !item.statement.trim()) local.push("statement is required");
    if (!isRecord(item.payload)) local.push("payload must be an object");
    if (!selected.has(item.source_conversation_id)) local.push("source conversation is outside this exchange");
    if (!isAttribution(item.attribution)) local.push("attribution subject and free-text claim_type are required");
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) local.push("confidence must be between 0 and 1");
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) local.push("at least one evidence citation is required");
    const normalized = typeof item.statement === "string" ? item.statement.toLowerCase().replace(/\s+/g, " ").trim() : "";
    if (normalized && normalizedStatements.has(normalized)) local.push("duplicate normalized statement");
    normalizedStatements.add(normalized);

    const citations: ValidatedDiscoveryObservation["citations"] = [];
    const seenEvidence = new Set<string>();
    for (const citation of Array.isArray(item.evidence) ? item.evidence : []) {
      if (!isRecord(citation) || typeof citation.evidence_ref !== "string" || !citation.evidence_ref.trim()) {
        local.push("each citation needs a non-empty evidence_ref"); continue;
      }
      const evidenceRef = citation.evidence_ref.trim();
      if (citation.excerpt !== undefined && typeof citation.excerpt !== "string") {
        local.push(`optional excerpt for ${evidenceRef} must be a string`); continue;
      }
      if (citation.role !== undefined && !["supporting", "context", "contradicting"].includes(String(citation.role))) {
        local.push(`invalid evidence role for ${evidenceRef}`); continue;
      }
      const evidenceRow = evidenceByRef.get(evidenceRef);
      if (!evidenceRow) { local.push(`unknown evidence_ref ${evidenceRef}`); continue; }
      if (evidenceRow.source_conversation_id !== item.source_conversation_id) {
        local.push(`evidence_ref ${evidenceRef} belongs to ${evidenceRow.source_conversation_id}, not observation conversation ${String(item.source_conversation_id)}`); continue;
      }
      if (sha256(evidenceRow.text) !== evidenceRow.representation_sha256
        || !evidenceRow.resolution_exact
        || evidenceRow.resolution_expected_sha256 !== evidenceRow.representation_sha256
        || evidenceRow.resolution_observed_sha256 !== evidenceRow.representation_sha256) {
        local.push(`hash resolution mismatch in ${evidenceRef}`); continue;
      }
      const key = `${evidenceRef}:${String(citation.role ?? "supporting")}`;
      if (!seenEvidence.has(key)) citations.push({
        evidence_ref: evidenceRef,
        ...(citation.excerpt === undefined ? {} : { excerpt: citation.excerpt }),
        ...(citation.role === undefined ? {} : { role: citation.role }),
        evidence_row: evidenceRow, canonical_text: evidenceRow.text,
        canonical_text_sha256: evidenceRow.representation_sha256
      });
      seenEvidence.add(key);
    }
    if (claimsUserAuthority(item) && !citations.some((citation) => citation.evidence_row.role === "user")) {
      local.push("user decision/requirement/preference/instruction/commitment requires user-authored evidence");
    }
    if (local.length) issues.push(...local.map((problem) => ({ record_ref: recordRef, problem })));
    else validObservations.push({ ...item, observation_ref: ref, observation_kind: item.observation_kind.trim(), citations });
  }

  const validByRef = new Map(validObservations.map((item) => [item.observation_ref, item]));
  const validLinks: ValidatedDiscoveryLink[] = [];
  for (const [index, link] of (output.links ?? []).entries()) {
    const recordRef = `link[${index}]`;
    const local: string[] = [];
    if (!isRecord(link)) { issues.push({ record_ref: recordRef, problem: "link must be an object" }); continue; }
    const fromRef = typeof link.from_observation_ref === "string" ? link.from_observation_ref.trim() : "";
    const toRef = typeof link.to_observation_ref === "string" ? link.to_observation_ref.trim() : "";
    const from = validByRef.get(fromRef);
    const to = validByRef.get(toRef);
    if (!from) local.push(`from_observation_ref '${fromRef}' is unknown or invalid`);
    if (!to) local.push(`to_observation_ref '${toRef}' is unknown or invalid`);
    if (typeof link.link_kind !== "string" || !link.link_kind.trim()) local.push("link_kind must be non-empty free text");
    if (link.payload !== undefined && !isRecord(link.payload)) local.push("link payload must be an object");
    if (link.confidence !== undefined && (typeof link.confidence !== "number" || !Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1)) local.push("link confidence must be between 0 and 1");
    if (local.length) issues.push(...local.map((problem) => ({ record_ref: recordRef, problem })));
    else validLinks.push({ ...link, from_observation_ref: fromRef, to_observation_ref: toRef,
      link_kind: link.link_kind.trim(), from: from!, to: to! });
  }
  if (issues.length) return { issues };
  return { valid: { output, trusted_model: normalizedModel, observations: validObservations, links: validLinks }, issues: [] };
}

export interface DiscoveryPersistResult {
  observations_inserted: number;
  observation_links_inserted: number;
  provenance_edges_inserted: number;
  replay: boolean;
  observation_ids: Record<string, string>;
}

export async function persistValidatedDiscovery(
  client: DbClient,
  workspaceId: string,
  exchange: DiscoveryExchange,
  validated: ValidatedDiscoveryOutput
): Promise<DiscoveryPersistResult> {
  const result: DiscoveryPersistResult = { observations_inserted: 0, observation_links_inserted: 0, provenance_edges_inserted: 0, replay: false, observation_ids: {} };
  for (const observation of validated.observations) {
    const natural = [UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, exchange.exchange_id, observation.observation_ref];
    const observationId = deterministicId("observation", workspaceId, natural);
    result.observation_ids[observation.observation_ref] = observationId;
    const createdAt = [...observation.citations.map((item) => item.evidence_row.source_observed_at)].sort().at(-1)!;
      const payload = {
      ...observation.payload, statement: observation.statement, attribution: observation.attribution,
      confidence: observation.confidence, emergent: true, approved: false,
      evidence_refs: observation.citations.map((item) => ({
        evidence_ref: item.evidence_ref, role: item.role ?? "supporting",
        untrusted_model_excerpt: item.excerpt ?? null,
        canonical_text: item.canonical_text,
        canonical_text_sha256: item.canonical_text_sha256
      })),
      source_identity: observation.citations.map((item) => ({
        source_conversation_id: item.evidence_row.source_conversation_id,
        source_family: item.evidence_row.source_family, source_version_id: item.evidence_row.source_version_id,
        capture_version_id: item.evidence_row.capture_version_id,
        content_block_id: item.evidence_row.content_block_id, message_id: item.evidence_row.message_id,
        immutable_evidence_locator: item.evidence_row.immutable_evidence_locator,
        representation_sha256: item.evidence_row.representation_sha256
      })),
      discovery_exchange_id: exchange.exchange_id, discovery_model: validated.trusted_model
    };
    const row = immutable("observation", workspaceId, natural, {
      workspace_id: workspaceId, observation_id: observationId,
      pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, observation_kind: observation.observation_kind.trim(),
      payload, payload_sha256: sha256(payload), status: "proposed", chunk_id: null,
      conversation_id: observation.citations[0]!.evidence_row.conversation_id, created_at: createdAt
    });
    if (await immutableInsert(client, "observations", "observation_id", row) === "inserted") result.observations_inserted += 1;
    for (const citation of observation.citations) {
      const evidence = citation.evidence_row;
      const edgeNatural = [UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, observationId, evidence.message_id,
        evidence.content_block_id, evidence.representation_kind, evidence.representation_sha256];
      const version = evidence.capture_version_id === null
        ? { source_version_id: evidence.source_version_id }
        : { capture_version_id: evidence.capture_version_id };
      const edge = immutable("provenance_edge", workspaceId, edgeNatural, {
        workspace_id: workspaceId, provenance_edge_id: deterministicId("provenance_edge", workspaceId, edgeNatural),
        pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
        target_record_type: "observation", target_record_id: observationId, relation: "quotes",
        source_record_id: evidence.source_record_id, ...version, conversation_id: evidence.conversation_id,
        message_id: evidence.message_id, content_block_id: evidence.content_block_id,
        representation_kind: evidence.representation_kind, representation_sha256: evidence.representation_sha256,
        created_at: createdAt
      });
      if (await immutableInsert(client, "provenance_edges", "provenance_edge_id", edge) === "inserted") result.provenance_edges_inserted += 1;
    }
  }
  for (const link of validated.links) {
    const fromId = result.observation_ids[link.from_observation_ref]!;
    const toId = result.observation_ids[link.to_observation_ref]!;
    const payload = { ...(link.payload ?? {}), ...(link.confidence === undefined ? {} : { confidence: link.confidence }) };
    const natural = [UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, exchange.exchange_id, fromId, toId, link.link_kind, payload];
    const createdAt = [link.from.citations[0]!.evidence_row.source_observed_at, link.to.citations[0]!.evidence_row.source_observed_at].sort().at(-1)!;
    const row = immutable("observation_link", workspaceId, natural, {
      workspace_id: workspaceId, observation_link_id: deterministicId("observation_link", workspaceId, natural),
      pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, from_observation_id: fromId,
      to_observation_id: toId, link_kind: link.link_kind.trim(), payload, created_at: createdAt
    });
    if (await immutableInsert(client, "observation_links", "observation_link_id", row) === "inserted") result.observation_links_inserted += 1;
  }
  result.replay = result.observations_inserted + result.observation_links_inserted + result.provenance_edges_inserted === 0;
  return result;
}

/** Reloads trusted evidence before validation; Hermes never receives DB write authority. */
export async function validateAndPersistDiscovery(
  workspaceId: string,
  suppliedExchange: DiscoveryExchange,
  output: unknown,
  trustedModel: TrustedDiscoveryModel
): Promise<DiscoveryPersistResult> {
  const uuids = suppliedExchange.selection.map((item) => item.source_conversation_id);
  const trusted = await prepareDiscoveryExchange(workspaceId, uuids);
  if (trusted.exchange_id !== suppliedExchange.exchange_id || trusted.evidence_sha256 !== suppliedExchange.evidence_sha256
    || sha256(trusted.evidence) !== sha256(suppliedExchange.evidence)) {
    throw new Error("Discovery exchange does not match current trusted database evidence.");
  }
  const validation = validateDiscoveryOutput(trusted, output, trustedModel);
  if (!validation.valid) throw new Error(`Discovery output rejected: ${validation.issues.map((issue) => `${issue.record_ref}: ${issue.problem}`).join("; ")}`);
  const pool = createPool("writer");
  try { return await transaction(pool, workspaceId, (client) => persistValidatedDiscovery(client, workspaceId, trusted, validation.valid!)); }
  finally { await pool.end(); }
}

function claimsUserAuthority(item: DiscoveryObservationOutput): boolean {
  const protectedClaim = /decision|requirement|preference|instruction|commitment|directive/i;
  const statementClaimsUser = /\b(user|stephen|operator)\b.{0,80}\b(decid|requir|prefer|instruct|commit|directive)/i.test(item.statement)
    || /\b(decid|requir|prefer|instruct|commit|directive)\w*\b.{0,80}\b(user|stephen|operator)\b/i.test(item.statement);
  if (statementClaimsUser) return true;
  return item.attribution?.subject === "user"
    && (protectedClaim.test(item.attribution.claim_type) || protectedClaim.test(item.observation_kind));
}

function normalizeTrustedModel(value: TrustedDiscoveryModel): TrustedDiscoveryModel {
  const provider = value.provider?.trim();
  const name = value.name?.trim();
  const runnerVersion = value.runner_version?.trim();
  if (!provider || !name || !runnerVersion) {
    throw new Error("Trusted discovery runner must supply provider, model name, and runner_version.");
  }
  const version = value.version?.trim();
  return { provider, name, ...(version ? { version } : {}), runner_version: runnerVersion };
}

function toEvidence(row: Record<string, unknown>): DiscoveryEvidence {
  const base = {
    source_conversation_id: String(row.source_conversation_id), conversation_id: String(row.conversation_id),
    source_family: String(row.source_family), source_version_id: String(row.source_version_id),
    capture_version_id: nullableString(row.evidence_capture_version_id), message_id: String(row.message_id),
    source_message_id: String(row.source_message_id), message_sequence: Number(row.message_sequence), role: String(row.role),
    active_path: Boolean(row.active_path), content_block_id: String(row.content_block_id), block_kind: String(row.block_kind),
    representation_kind: String(row.representation_kind), text: String(row.text), representation_sha256: String(row.representation_sha256),
    source_record_id: String(row.source_record_id), immutable_evidence_locator: String(row.immutable_evidence_locator),
    source_record_sha256: String(row.source_record_sha256), source_version_locator: String(row.source_version_locator),
    source_container_sha256: nullableString(row.source_container_sha256), capture_locator: nullableString(row.capture_locator),
    capture_manifest_sha256: nullableString(row.capture_manifest_sha256), resolution_id: String(row.resolution_id),
    resolution_expected_sha256: String(row.resolution_expected_sha256), resolution_observed_sha256: String(row.resolution_observed_sha256),
    resolution_exact: row.resolution_exact === true, source_observed_at: iso(row.source_observed_at)
  };
  return { evidence_ref: deterministicId("evidence_ref", "exchange", [base.content_block_id, base.representation_kind, base.representation_sha256]), ...base };
}

function immutable(kind: string, workspaceId: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> {
  const body = { ...fields, idempotency_key: idempotencyKey(kind, workspaceId, natural) };
  return { ...body, record_sha256: sha256(body) };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isAttribution(value: unknown): value is DiscoveryObservationOutput["attribution"] {
  return isRecord(value) && ["user", "assistant", "other", "unresolved"].includes(String(value.subject))
    && typeof value.claim_type === "string" && value.claim_type.trim().length > 0;
}
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }

const AUTHORIZED_SOURCE_PREDICATE = `sv.verification_status='complete' and (
  (sv.source_family='native_export' and sv.source_container_sha256=$3)
  or (sv.source_family='browser_capture' and cv.verification_status='complete')
)`;

const AUTHORIZED_SELECTION_SQL = `
select c.source_conversation_id,c.conversation_id,c.title_representation->>'value' title,
  sv.source_family,sv.source_version_id,sv.content_sha256,sv.immutable_source_locator,
  sv.source_container_sha256,sv.source_observed_at,sv.capture_version_id,
  cv.manifest_sha256 capture_manifest_sha256,cv.immutable_archive_locator capture_locator,
  (select count(*)::int from memory_v1.messages m where m.workspace_id=c.workspace_id and m.conversation_id=c.conversation_id
    and ((m.source_version_id=sv.source_version_id) or (m.capture_version_id=sv.capture_version_id))) message_count
from memory_v1.conversations c
join memory_v1.source_versions sv on sv.workspace_id=c.workspace_id and sv.conversation_id=c.conversation_id
left join memory_v1.capture_versions cv on cv.workspace_id=sv.workspace_id and cv.capture_version_id=sv.capture_version_id
where c.workspace_id=$1 and c.source_conversation_id=any($2::text[]) and ${AUTHORIZED_SOURCE_PREDICATE}
order by array_position($2::text[],c.source_conversation_id)`;

const AUTHORIZED_EVIDENCE_SQL = `
select c.source_conversation_id,c.conversation_id,sv.source_family,sv.source_version_id,
  m.capture_version_id evidence_capture_version_id,m.message_id,m.source_message_id,m.sequence message_sequence,m.role,m.active_path,
  b.content_block_id,b.block_kind,rep->>'representation_kind' representation_kind,rep->>'value' text,
  rep->>'sha256' representation_sha256,b.source_record_id,sr.immutable_evidence_locator,
  sr.source_sha256 source_record_sha256,sv.immutable_source_locator source_version_locator,
  sv.source_container_sha256,cv.immutable_archive_locator capture_locator,cv.manifest_sha256 capture_manifest_sha256,
  a.resolution_id,a.expected_sha256 resolution_expected_sha256,a.observed_sha256 resolution_observed_sha256,
  a.exact_match resolution_exact,sv.source_observed_at
from memory_v1.conversations c
join memory_v1.source_versions sv on sv.workspace_id=c.workspace_id and sv.conversation_id=c.conversation_id
left join memory_v1.capture_versions cv on cv.workspace_id=sv.workspace_id and cv.capture_version_id=sv.capture_version_id
join memory_v1.messages m on m.workspace_id=c.workspace_id and m.conversation_id=c.conversation_id
  and ((m.source_version_id=sv.source_version_id) or (m.capture_version_id=sv.capture_version_id))
join memory_v1.content_blocks b on b.workspace_id=m.workspace_id and b.message_id=m.message_id
  and ((b.source_version_id=sv.source_version_id) or (b.capture_version_id=sv.capture_version_id))
join memory_v1.source_records sr on sr.workspace_id=b.workspace_id and sr.source_record_id=b.source_record_id
join lateral jsonb_array_elements(b.representations) rep on rep->>'representation_kind'='canonical_text'
left join lateral (
  select ar.resolution_id,ar.expected_sha256,ar.observed_sha256,ar.exact_match
  from memory_v1.archive_hash_resolutions ar
  where ar.workspace_id=b.workspace_id and ar.source_record_id=b.source_record_id
    and ar.expected_sha256=rep->>'sha256' and ar.exact_match
    and ((m.source_version_id is not null and ar.source_version_id=m.source_version_id)
      or (m.capture_version_id is not null and ar.capture_version_id=m.capture_version_id))
  order by ar.pipeline_version,ar.resolution_id limit 1
) a on true
where c.workspace_id=$1 and c.source_conversation_id=any($2::text[]) and ${AUTHORIZED_SOURCE_PREDICATE}
order by array_position($2::text[],c.source_conversation_id),m.sequence,b.sequence,b.content_block_id`;

const PILOT_CANDIDATES_SQL = `
select c.source_conversation_id,c.title_representation->>'value' title,sv.source_family,sv.source_observed_at observed_at,
  count(distinct m.message_id)::int message_count,
  coalesce(sum(length(rep->>'value')) filter(where rep->>'representation_kind'='canonical_text'),0)::bigint content_characters
from memory_v1.conversations c
join memory_v1.source_versions sv on sv.workspace_id=c.workspace_id and sv.conversation_id=c.conversation_id
left join memory_v1.capture_versions cv on cv.workspace_id=sv.workspace_id and cv.capture_version_id=sv.capture_version_id
join memory_v1.messages m on m.workspace_id=c.workspace_id and m.conversation_id=c.conversation_id
  and ((m.source_version_id=sv.source_version_id) or (m.capture_version_id=sv.capture_version_id))
left join memory_v1.content_blocks b on b.workspace_id=m.workspace_id and b.message_id=m.message_id
  and ((b.source_version_id=sv.source_version_id) or (b.capture_version_id=sv.capture_version_id))
left join lateral jsonb_array_elements(b.representations) rep on true
where c.workspace_id=$1 and sv.verification_status='complete' and (
  (sv.source_family='native_export' and sv.source_container_sha256=$2)
  or (sv.source_family='browser_capture' and cv.verification_status='complete')
)
group by c.source_conversation_id,c.title_representation,sv.source_family,sv.source_observed_at
order by sv.source_observed_at,c.source_conversation_id`;
