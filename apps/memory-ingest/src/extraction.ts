/**
 * Knowledge Extraction V1 — refined candidate proposal stage.
 *
 * Replaces (coexists with, for this proof) the fixed 5-message-range candidate
 * behavior: reads ALREADY-INGESTED verified evidence (messages/content blocks)
 * read-only, validates a set of extraction PROPOSALS against that evidence,
 * and persists only validated proposals as status='proposed' knowledge
 * candidates using the existing knowledge_candidates / provenance_edges /
 * candidate_evidence architecture. No schema changes.
 *
 * The interpretation step (deciding what is meaningful) may be performed by an
 * LLM; its output is ALWAYS only a proposal file. This module never trusts a
 * proposal: every supporting quote must be an exact substring of the cited
 * content block's canonical_text whose sha256 matches the ingested evidence,
 * and every extracted item lands as 'proposed' for human review. Nothing is
 * approved automatically.
 *
 * Fine-grained candidate types are carried in proposed_value.extraction_type
 * and mapped onto the existing kind CHECK constraint
 * (claim|idea|entity|relationship|use_case|decision|task|sop):
 *   decision            -> decision   requirement          -> claim
 *   architecture_rule   -> claim      technical_finding    -> claim
 *   sop                 -> sop        task                 -> task
 *   unresolved_question -> idea       proposal             -> idea
 *   entity              -> entity     relationship         -> relationship
 */
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert, readOnlyTransaction, transaction } from "./db.js";

export const EXTRACTION_PIPELINE_VERSION = "memory-extract-v1/0.1.0";

export type ExtractionType =
  | "decision" | "requirement" | "architecture_rule" | "technical_finding"
  | "sop" | "task" | "unresolved_question" | "proposal" | "entity" | "relationship";

/** Who the statement is attributable to. Guards requirement: never promote an
 * assistant suggestion into a Stephen decision. */
export type Attribution = "stephen_directive" | "assistant_finding" | "assistant_suggestion" | "unresolved";

export type Confidence = "high" | "medium" | "low" | "uncertain";

const KIND_MAP: Record<ExtractionType, string> = {
  decision: "decision", requirement: "claim", architecture_rule: "claim",
  technical_finding: "claim", sop: "sop", task: "task",
  unresolved_question: "idea", proposal: "idea", entity: "entity", relationship: "relationship"
};

/** Extraction types that assert Stephen/user authority — they must cite at
 * least one user-role message. */
const USER_AUTHORITY_TYPES: ReadonlySet<ExtractionType> = new Set(["decision", "requirement", "sop"]);

export interface EvidenceCitation {
  /** Message sequence within the conversation. */
  sequence: number;
  /** Exact substring of the cited block's canonical_text proving the claim. */
  quote: string;
  /** Evidence role in the existing candidate_evidence CHECK. */
  role?: "supporting" | "context";
}

export interface ExtractionProposal {
  proposal_id: string;
  extraction_type: ExtractionType;
  statement: string;
  attribution: Attribution;
  confidence: Confidence;
  worth_preserving: string;
  dedup_note?: string;
  evidence: EvidenceCitation[];
}

export interface ExtractionInput {
  source_conversation_id: string;
  extraction_model: string;
  extractor_version: string;
  proposals: ExtractionProposal[];
}

export interface EvidenceBlockRow {
  message_id: string;          // memory_v1 message id
  source_message_id: string;
  sequence: number;
  role: string;
  content_block_id: string;
  source_record_id: string;
  immutable_evidence_locator: string;
  representation_sha256: string;
  canonical_text: string;
  capture_version_id: string;
}

export interface ValidatedCitation extends EvidenceCitation { block: EvidenceBlockRow }
export interface ValidatedProposal extends ExtractionProposal { citations: ValidatedCitation[] }

export interface ValidationIssue { proposal_id: string; problem: string }

/** Pure validation against an evidence index — no DB access, unit-testable. */
export function validateProposals(
  input: ExtractionInput,
  evidenceBySequence: Map<number, EvidenceBlockRow[]>
): { valid: ValidatedProposal[]; issues: ValidationIssue[] } {
  const valid: ValidatedProposal[] = [];
  const issues: ValidationIssue[] = [];
  const seenStatements = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const proposal of input.proposals) {
    const problems: string[] = [];
    if (!proposal.proposal_id || seenIds.has(proposal.proposal_id)) problems.push("missing or duplicate proposal_id");
    seenIds.add(proposal.proposal_id);
    if (!(proposal.extraction_type in KIND_MAP)) problems.push(`unknown extraction_type: ${proposal.extraction_type}`);
    if (!proposal.statement?.trim()) problems.push("empty statement");
    if (!proposal.worth_preserving?.trim()) problems.push("missing worth_preserving rationale");
    if (!["high", "medium", "low", "uncertain"].includes(proposal.confidence)) problems.push(`invalid confidence: ${proposal.confidence}`);
    if (!["stephen_directive", "assistant_finding", "assistant_suggestion", "unresolved"].includes(proposal.attribution)) problems.push(`invalid attribution: ${proposal.attribution}`);
    if (!proposal.evidence?.length) problems.push("no supporting evidence");

    const normalized = proposal.statement?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
    const priorId = seenStatements.get(normalized);
    if (priorId) problems.push(`duplicate statement of ${priorId}`);
    else if (normalized) seenStatements.set(normalized, proposal.proposal_id);

    const citations: ValidatedCitation[] = [];
    for (const citation of proposal.evidence ?? []) {
      const blocks = evidenceBySequence.get(citation.sequence);
      if (!blocks?.length) { problems.push(`sequence ${citation.sequence} not in evidence`); continue; }
      const block = blocks.find((row) => row.canonical_text.includes(citation.quote));
      if (!block) { problems.push(`quote not found verbatim in sequence ${citation.sequence}`); continue; }
      if (sha256(block.canonical_text) !== block.representation_sha256) { problems.push(`representation hash mismatch at sequence ${citation.sequence}`); continue; }
      citations.push({ ...citation, block });
    }

    if (USER_AUTHORITY_TYPES.has(proposal.extraction_type) || proposal.attribution === "stephen_directive") {
      if (!citations.some((c) => c.block.role === "user")) {
        problems.push(`${proposal.extraction_type}/${proposal.attribution} requires at least one user-role evidence message (never promote assistant text to Stephen authority)`);
      }
    }

    if (problems.length) issues.push(...problems.map((problem) => ({ proposal_id: proposal.proposal_id, problem })));
    else valid.push({ ...proposal, citations });
  }
  return { valid, issues };
}

export interface ExtractionRunResult {
  pipeline_version: string;
  extraction_run_id: string;
  conversation_id: string;
  capture_version_id: string;
  candidates: Array<{ knowledge_candidate_id: string; extraction_type: ExtractionType; kind: string; statement: string; sequences: number[]; edges: number }>;
  issues: ValidationIssue[];
  dry_run: boolean;
  replay: boolean;
}

export async function loadEvidence(workspaceId: string, sourceConversationId: string): Promise<{
  conversationId: string; captureVersionId: string; sourceSystemId: string; sourceAccountId: string;
  captureId: string; manifestSha256: string; capturedAt: string; messageCount: number;
  evidenceBySequence: Map<number, EvidenceBlockRow[]>;
}> {
  const pool = createPool("reader");
  try {
    return await readOnlyTransaction(pool, workspaceId, async (client) => {
      const conv = await client.query(
        "select conversation_id, capture_version_id from memory_v1.conversations where workspace_id=$1 and source_conversation_id=$2",
        [workspaceId, sourceConversationId]);
      if (!conv.rowCount) throw new Error(`Conversation not found for source id ${sourceConversationId}`);
      const conversationId = String(conv.rows[0].conversation_id);
      const captureVersionId = String(conv.rows[0].capture_version_id);
      const cap = await client.query(
        "select immutable_archive_locator, manifest_sha256, captured_at, verification_status from memory_v1.capture_versions where workspace_id=$1 and capture_version_id=$2",
        [workspaceId, captureVersionId]);
      if (cap.rows[0]?.verification_status !== "complete") throw new Error("Capture version is not verified complete.");
      const captureId = String(cap.rows[0].immutable_archive_locator).replace("hhs-archive://capture/", "");
      const sys = await client.query(`
        select sr.source_system_id, sr.source_account_id from memory_v1.source_records sr
        join memory_v1.capture_versions cv on cv.workspace_id=sr.workspace_id and cv.source_record_id=sr.source_record_id
        where sr.workspace_id=$1 and cv.capture_version_id=$2`, [workspaceId, captureVersionId]);
      if (!sys.rowCount) throw new Error("Source system for capture not found.");
      const rows = await client.query(`
        select m.message_id, m.source_message_id, m.sequence, m.role,
               b.content_block_id, b.source_record_id, sr.immutable_evidence_locator,
               (select rep->>'sha256' from jsonb_array_elements(b.representations) rep where rep->>'representation_kind'='canonical_text' limit 1) as representation_sha256,
               (select rep->>'value' from jsonb_array_elements(b.representations) rep where rep->>'representation_kind'='canonical_text' limit 1) as canonical_text,
               m.capture_version_id
        from memory_v1.messages m
        join memory_v1.content_blocks b on b.workspace_id=m.workspace_id and b.message_id=m.message_id
        join memory_v1.source_records sr on sr.workspace_id=b.workspace_id and sr.source_record_id=b.source_record_id
        where m.workspace_id=$1 and m.conversation_id=$2
        order by m.sequence, b.sequence`, [workspaceId, conversationId]);
      const evidenceBySequence = new Map<number, EvidenceBlockRow[]>();
      for (const row of rows.rows) {
        if (row.canonical_text === null) continue;
        const entry: EvidenceBlockRow = {
          message_id: row.message_id, source_message_id: row.source_message_id, sequence: Number(row.sequence),
          role: row.role, content_block_id: row.content_block_id, source_record_id: row.source_record_id,
          immutable_evidence_locator: row.immutable_evidence_locator,
          representation_sha256: row.representation_sha256, canonical_text: row.canonical_text,
          capture_version_id: row.capture_version_id
        };
        const list = evidenceBySequence.get(entry.sequence) ?? [];
        list.push(entry);
        evidenceBySequence.set(entry.sequence, list);
      }
      return {
        conversationId, captureVersionId, captureId,
        manifestSha256: String(cap.rows[0].manifest_sha256),
        capturedAt: cap.rows[0].captured_at instanceof Date ? cap.rows[0].captured_at.toISOString() : String(cap.rows[0].captured_at),
        messageCount: Number((await client.query(
          "select count(*)::int count from memory_v1.messages where workspace_id=$1 and conversation_id=$2",
          [workspaceId, conversationId])).rows[0]?.count),
        sourceSystemId: String(sys.rows[0].source_system_id), sourceAccountId: String(sys.rows[0].source_account_id),
        evidenceBySequence
      };
    });
  } finally { await pool.end(); }
}

export async function runExtraction(options: {
  workspaceId: string; input: ExtractionInput; dryRun: boolean;
}): Promise<ExtractionRunResult> {
  const { workspaceId, input } = options;
  const evidence = await loadEvidence(workspaceId, input.source_conversation_id);
  const { valid, issues } = validateProposals(input, evidence.evidenceBySequence);
  if (issues.length) {
    return { pipeline_version: EXTRACTION_PIPELINE_VERSION, extraction_run_id: "", conversation_id: evidence.conversationId, capture_version_id: evidence.captureVersionId, candidates: [], issues, dry_run: options.dryRun, replay: false };
  }

  const runNatural = [evidence.captureId, EXTRACTION_PIPELINE_VERSION, input.extractor_version];
  const runId = deterministicId("ingestion_run", workspaceId, runNatural);
  const inputSha = sha256({ source_conversation_id: input.source_conversation_id, extraction_model: input.extraction_model, extractor_version: input.extractor_version, proposals: input.proposals });

  const candidates: ExtractionRunResult["candidates"] = [];
  const plans = valid.map((proposal) => {
    const sequences = [...new Set(proposal.citations.map((c) => c.sequence))].sort((a, b) => a - b);
    const start = sequences[0]!;
    const end = sequences.at(-1)!;
    const chunkNatural = [evidence.captureId, EXTRACTION_PIPELINE_VERSION, "extraction_evidence", sequences];
    const chunkId = deterministicId("message_range_chunk", workspaceId, chunkNatural);
    const candidateNatural = [evidence.captureId, EXTRACTION_PIPELINE_VERSION, "extracted", proposal.proposal_id];
    const candidateId = deterministicId("knowledge_candidate", workspaceId, candidateNatural);
    return { proposal, sequences, start, end, chunkNatural, chunkId, candidateNatural, candidateId };
  });
  const ranges = [...new Map(plans.map((plan) => [plan.chunkId, {
    chunkId: plan.chunkId, chunkNatural: plan.chunkNatural, sequences: plan.sequences,
    start: plan.start, end: plan.end
  }])).values()];
  const expectedEvidenceCount = plans.reduce((total, plan) => total + uniqueEdgeCitations(plan.proposal.citations).length, 0);
  let replay = false;

  if (!options.dryRun) {
    const pool = createPool("writer");
    try {
      await transaction(pool, workspaceId, async (client) => {
        // Extraction runs use the ordinary guarded lifecycle but carry an
        // immutable extension row selecting extraction-specific invariants.
        const priorRun = await client.query("select status,input_manifest_sha256 from memory_v1.ingestion_runs where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
        if (priorRun.rowCount) {
          const priorExtraction = await client.query("select extraction_input_sha256 from memory_v1.knowledge_extraction_runs where workspace_id=$1 and extraction_run_id=$2 and pipeline_version=$3", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
          if (priorRun.rows[0]?.input_manifest_sha256 !== evidence.manifestSha256 || priorExtraction.rows[0]?.extraction_input_sha256 !== inputSha) {
            throw new Error("Extraction run identity collision: source or proposals changed for same extractor version. Bump extractor_version.");
          }
          if (priorRun.rows[0]?.status === "completed") { replay = true; return; }
          if (!new Set(["running", "partial"]).has(String(priorRun.rows[0]?.status))) throw new Error(`Extraction run cannot resume from ${String(priorRun.rows[0]?.status)}.`);
          if (priorRun.rows[0]?.status === "partial") await client.query("update memory_v1.ingestion_runs set status='running',attempt_count=attempt_count+1 where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
        } else {
          await client.query(`insert into memory_v1.ingestion_runs (
            workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,input_manifest_sha256,
            checkpoint_key,attempt_count,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count)
            values ($1,$2,$3,$4,$5,'running',now(),$6,'extraction',1,$7,$8,$9,$10)`,
            [workspaceId, runId, evidence.sourceSystemId, evidence.sourceAccountId,
             idempotencyKey("ingestion_run", workspaceId, runNatural), evidence.manifestSha256, EXTRACTION_PIPELINE_VERSION,
             evidence.messageCount, expectedEvidenceCount, ranges.length]);
        }
        await immutableInsert(client, "knowledge_extraction_runs", "extraction_run_id", immutable("knowledge_extraction_run", workspaceId, runNatural, {
          workspace_id: workspaceId, extraction_run_id: runId, pipeline_version: EXTRACTION_PIPELINE_VERSION,
          source_capture_version_id: evidence.captureVersionId, conversation_id: evidence.conversationId,
          extraction_input_sha256: inputSha, extraction_model: input.extraction_model, extractor_version: input.extractor_version,
          expected_candidate_count: plans.length, expected_evidence_count: expectedEvidenceCount,
          expected_evidence_range_count: ranges.length, created_at: evidence.capturedAt
        }));
        for (const range of ranges) {
          const blocks = range.sequences.flatMap((sequence) => evidence.evidenceBySequence.get(sequence) ?? []);
          await immutableInsert(client, "message_range_chunks", "chunk_id", immutable("message_range_chunk", workspaceId, range.chunkNatural, {
            workspace_id: workspaceId, chunk_id: range.chunkId, ingestion_run_id: runId, capture_version_id: evidence.captureVersionId,
            pipeline_version: EXTRACTION_PIPELINE_VERSION, start_sequence: range.start, end_sequence: range.end,
            message_ids: [...new Set(blocks.map((block) => block.message_id))],
            chunk_sha256: sha256(blocks.map((block) => ({ sequence: block.sequence, message_id: block.message_id, block_id: block.content_block_id, sha256: block.representation_sha256 })))
          }));
        }
        const citedBlocks = new Map<string, EvidenceBlockRow>();
        for (const plan of plans) for (const citation of plan.proposal.citations) {
          citedBlocks.set(`${citation.block.source_record_id}:${citation.block.representation_sha256}`, citation.block);
        }
        for (const block of citedBlocks.values()) {
          const resolutionNatural = [EXTRACTION_PIPELINE_VERSION, block.source_record_id, block.immutable_evidence_locator, block.representation_sha256];
          const resolutionId = deterministicId("archive_hash_resolution", workspaceId, resolutionNatural);
          const prior = await client.query("select expected_sha256,observed_sha256,ingestion_run_id from memory_v1.archive_hash_resolutions where workspace_id=$1 and resolution_id=$2 and pipeline_version=$3", [workspaceId, resolutionId, EXTRACTION_PIPELINE_VERSION]);
          if (prior.rowCount) {
            if (prior.rows[0]?.expected_sha256 !== block.representation_sha256 || prior.rows[0]?.observed_sha256 !== block.representation_sha256 || prior.rows[0]?.ingestion_run_id !== runId) throw new Error(`Extraction hash-resolution collision for ${resolutionId}.`);
          } else {
            await client.query(`insert into memory_v1.archive_hash_resolutions (
              workspace_id,resolution_id,source_record_id,capture_version_id,locator,expected_sha256,observed_sha256,resolved_at,pipeline_version,ingestion_run_id)
              values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
              [workspaceId, resolutionId, block.source_record_id, evidence.captureVersionId, block.immutable_evidence_locator,
               block.representation_sha256, evidence.capturedAt, EXTRACTION_PIPELINE_VERSION, runId]);
          }
        }
        for (const plan of plans) {
          const { proposal } = plan;
          const proposedValue = {
            candidate_type: proposal.extraction_type,
            statement: proposal.statement,
            attribution: proposal.attribution,
            confidence: proposal.confidence,
            worth_preserving: proposal.worth_preserving,
            dedup_note: proposal.dedup_note ?? null,
            source_sequences: plan.sequences,
            supporting_evidence: proposal.citations.map((c) => ({
              sequence: c.sequence, message_id: c.block.message_id, source_message_id: c.block.source_message_id,
              content_block_id: c.block.content_block_id, representation_sha256: c.block.representation_sha256,
              quote: c.quote, role: c.role ?? "supporting"
            })),
            extraction_model: input.extraction_model,
            extractor_version: input.extractor_version,
            pipeline_version: EXTRACTION_PIPELINE_VERSION,
            capture_id: evidence.captureId,
            extraction_stage: "knowledge-extraction-v1"
          };
          await immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", immutable("knowledge_candidate", workspaceId, plan.candidateNatural, {
            workspace_id: workspaceId, knowledge_candidate_id: plan.candidateId, chunk_id: plan.chunkId,
            pipeline_version: EXTRACTION_PIPELINE_VERSION, kind: KIND_MAP[proposal.extraction_type], status: "proposed",
            proposed_value: proposedValue, proposed_value_sha256: sha256(proposedValue), created_at: evidence.capturedAt
          }));
          for (const citation of uniqueEdgeCitations(proposal.citations)) {
            const edgeNatural = [EXTRACTION_PIPELINE_VERSION, plan.candidateId, citation.block.message_id, citation.block.content_block_id, "canonical_text", citation.block.representation_sha256];
            const edgeId = deterministicId("provenance_edge", workspaceId, edgeNatural);
            await immutableInsert(client, "provenance_edges", "provenance_edge_id", immutable("provenance_edge", workspaceId, edgeNatural, {
              workspace_id: workspaceId, provenance_edge_id: edgeId, pipeline_version: EXTRACTION_PIPELINE_VERSION,
              target_record_type: "knowledge_candidate", target_record_id: plan.candidateId, relation: "quotes",
              source_record_id: citation.block.source_record_id, capture_version_id: evidence.captureVersionId,
              conversation_id: evidence.conversationId, message_id: citation.block.message_id, content_block_id: citation.block.content_block_id,
              representation_kind: "canonical_text", representation_sha256: citation.block.representation_sha256, created_at: evidence.capturedAt
            }));
            const evidenceNatural = [EXTRACTION_PIPELINE_VERSION, plan.candidateId, edgeId];
            await immutableInsert(client, "candidate_evidence", "candidate_evidence_id", immutable("candidate_evidence", workspaceId, evidenceNatural, {
              workspace_id: workspaceId, candidate_evidence_id: deterministicId("candidate_evidence", workspaceId, evidenceNatural),
              pipeline_version: EXTRACTION_PIPELINE_VERSION, knowledge_candidate_id: plan.candidateId, provenance_edge_id: edgeId,
              role: citation.role ?? "supporting"
            }));
          }
        }
        const completion = await client.query("select memory_v1.ingestion_completion_errors($1,$2,$3) errors", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
        const completionErrors = (completion.rows[0]?.errors ?? []) as string[];
        if (completionErrors.length) throw new Error(`Knowledge extraction completion invariants failed: ${completionErrors.join(",")}`);
        await client.query("update memory_v1.ingestion_runs set status='completed',completed_at=now(),completion_validated_at=now(),checkpoint_key='complete' where workspace_id=$1 and ingestion_run_id=$2 and pipeline_version=$3", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
        await client.query("select memory_v1.attest_completed_generation($1,$2,$3)", [workspaceId, runId, EXTRACTION_PIPELINE_VERSION]);
      });
    } finally { await pool.end(); }
  }

  for (const plan of plans) {
    candidates.push({
      knowledge_candidate_id: plan.candidateId, extraction_type: plan.proposal.extraction_type,
      kind: KIND_MAP[plan.proposal.extraction_type], statement: plan.proposal.statement,
      sequences: plan.sequences, edges: uniqueEdgeCitations(plan.proposal.citations).length
    });
  }
  return { pipeline_version: EXTRACTION_PIPELINE_VERSION, extraction_run_id: runId, conversation_id: evidence.conversationId, capture_version_id: evidence.captureVersionId, candidates, issues: [], dry_run: options.dryRun, replay };
}

function immutable(kind: string, workspaceId: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> {
  const body = { ...fields, idempotency_key: idempotencyKey(kind, workspaceId, natural) };
  return { ...body, record_sha256: sha256(body) };
}

function uniqueEdgeCitations(citations: ValidatedCitation[]): ValidatedCitation[] {
  return [...new Map(citations.map((citation) => [
    `${citation.block.message_id}:${citation.block.content_block_id}:${citation.block.representation_sha256}`,
    citation
  ])).values()];
}
