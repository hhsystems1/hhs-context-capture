/**
 * Deterministic reconstruction control-plane read model.
 *
 * Conversation/evidence authority remains memory_v1. Workflow facts are
 * overlaid from persisted discovery observations, validated discovery receipts,
 * and immutable reconciliation/observation lineage. This module performs no writes.
 */
import pg from "pg";
import { sha256 } from "@hhs/memory-schema";
import { createPool, readOnlyTransaction, type DbClient } from "./db.js";
import {
  VERIFIED_NATIVE_EXPORT_CONTAINER,
  validateDiscoveryOutput,
  type DiscoveryExchange,
  type DiscoveryOutput
} from "./understanding-discovery.js";

export const RECONSTRUCTION_INVENTORY_SCHEMA = "hhs-reconstruction-inventory/0.1.0";
export const DEFAULT_RECONSTRUCTION_BATCH_SIZE = 10;
export const EXPECTED_CLEAN_CORPUS_SIZE = 995;

export type EvidenceStatus = "healthy" | "evidence_incomplete";
export type DiscoveryStatus = "unprocessed" | "pilot_discovery_processed" | "discovery_processed";
export type ReconciliationStatus = "not_started" | "awaiting_reconciliation" | "reconciled";

export interface CanonicalInventoryRow {
  source_conversation_id: string;
  conversation_id: string;
  title: string | null;
  source_family: string;
  source_version_id: string;
  capture_version_id: string | null;
  verification_status: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  first_message_at: string | null;
  latest_message_at: string | null;
  source_observed_at: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  evidence_block_count: number;
  canonical_text_representation_count: number;
  nonempty_canonical_text_count: number;
  empty_canonical_text_count: number;
  persisted_observations_count: number;
  reconciled_observations_count: number;
  persisted_links_count: number;
  persisted_first_processed_at: string | null;
  persisted_latest_processed_at: string | null;
}

export interface DiscoveryReceipt {
  receipt_kind: "validated_discovery_pilot";
  exchange_id: string;
  source_conversation_ids: string[];
  observations_by_source: Record<string, number>;
  links_by_source: Record<string, number>;
  first_processed_at: null;
  latest_processed_at: null;
}

export interface ReconstructionInventoryEntry {
  source_conversation_id: string;
  conversation_id: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  chronology_timestamp: string;
  chronology_basis: "source_created_at" | "first_message_at" | "source_observed_at";
  chronological_sequence: number;
  source_family: string;
  source_version_id: string;
  capture_version_id: string | null;
  evidence_block_count: number;
  canonical_text_representation_count: number;
  nonempty_canonical_text_count: number;
  empty_canonical_text_count: number;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  evidence_status: EvidenceStatus;
  verification_status: string;
  discovery_status: DiscoveryStatus;
  observations_count: number;
  reconciled_observations_count: number;
  links_count: number;
  processed: boolean;
  reconciliation_status: ReconciliationStatus;
  evidence_issue: boolean;
  evidence_issue_reason: string[];
  batch_number: number;
  batch_position: number;
  first_processed_at: string | null;
  latest_processed_at: string | null;
  processing_receipt: "validated_pilot_artifact" | "persisted_observations" | null;
}

export interface ReconstructionBatch {
  batch_number: number;
  status: "unprocessed" | "partial" | "complete";
  conversation_count: number;
  processed_count: number;
  remaining_count: number;
  evidence_issue_count: number;
  first_sequence: number;
  last_sequence: number;
}

export interface ReconstructionSummary {
  total_clean_conversations: number;
  discovery_processed: number;
  unprocessed: number;
  awaiting_reconciliation: number;
  observations_awaiting_reconciliation: number;
  reconciled: number;
  evidence_issues: number;
  zero_evidence: number;
  needs_review: number;
  other_evidence_issues: number;
  batches_total: number;
  batches_complete: number;
  batches_partial: number;
  remaining_conversations: number;
  next_batch: number | null;
}

export interface ReconstructionInventorySnapshot {
  schema_version: typeof RECONSTRUCTION_INVENTORY_SCHEMA;
  workspace_id: string;
  generated_at: string;
  batch_size: number;
  corpus_authority: {
    native_export_container_sha256: string;
    source_families: ["native_export", "browser_capture"];
    verification_requirement: "complete";
  };
  processing_receipts: Array<{ receipt_kind: string; exchange_id: string; conversation_count: number }>;
  inventory_sha256: string;
  summary: ReconstructionSummary;
  batches: ReconstructionBatch[];
  conversations: ReconstructionInventoryEntry[];
}

export async function loadReconstructionInventory(
  workspaceId: string,
  receipts: DiscoveryReceipt[],
  generatedAt = new Date().toISOString(),
  batchSize = DEFAULT_RECONSTRUCTION_BATCH_SIZE,
  pool: pg.Pool = createPool("reader"),
  boundedStatusRead = false
): Promise<ReconstructionInventorySnapshot> {
  const ownsPool = arguments.length < 5;
  try {
    const rows = await readOnlyTransaction(pool, workspaceId, async (client) => {
      if (boundedStatusRead) {
        await client.query("set local statement_timeout = '5000ms'");
        await client.query("set local lock_timeout = '2000ms'");
      }
      return loadCanonicalInventoryRows(client, workspaceId);
    });
    return buildReconstructionInventory(workspaceId, rows, receipts, generatedAt, batchSize);
  } finally {
    if (ownsPool) await pool.end();
  }
}

export async function loadCanonicalInventoryRows(client: DbClient, workspaceId: string): Promise<CanonicalInventoryRow[]> {
  const result = await client.query(CANONICAL_INVENTORY_SQL, [workspaceId, VERIFIED_NATIVE_EXPORT_CONTAINER]);
  return result.rows.map((row): CanonicalInventoryRow => ({
    source_conversation_id: String(row.source_conversation_id),
    conversation_id: String(row.conversation_id),
    title: nullableString(row.title), source_family: String(row.source_family),
    source_version_id: String(row.source_version_id), capture_version_id: nullableString(row.capture_version_id),
    verification_status: String(row.verification_status), source_created_at: isoOrNull(row.source_created_at),
    source_updated_at: isoOrNull(row.source_updated_at), first_message_at: isoOrNull(row.first_message_at),
    latest_message_at: isoOrNull(row.latest_message_at), source_observed_at: iso(row.source_observed_at),
    message_count: Number(row.message_count), user_message_count: Number(row.user_message_count),
    assistant_message_count: Number(row.assistant_message_count), evidence_block_count: Number(row.evidence_block_count),
    canonical_text_representation_count: Number(row.canonical_text_representation_count),
    nonempty_canonical_text_count: Number(row.nonempty_canonical_text_count),
    empty_canonical_text_count: Number(row.empty_canonical_text_count),
    persisted_observations_count: Number(row.persisted_observations_count),
    reconciled_observations_count: Number(row.reconciled_observations_count),
    persisted_links_count: Number(row.persisted_links_count),
    persisted_first_processed_at: isoOrNull(row.persisted_first_processed_at),
    persisted_latest_processed_at: isoOrNull(row.persisted_latest_processed_at)
  }));
}

export function buildDiscoveryReceipt(exchange: DiscoveryExchange, output: DiscoveryOutput): DiscoveryReceipt {
  const validation = validateDiscoveryOutput(exchange, output, {
    provider: "trusted-artifact-revalidation", name: "validated-discovery-receipt",
    runner_version: "reconstruction-inventory/0.1.0"
  });
  if (!validation.valid) {
    throw new Error(`Discovery receipt is invalid: ${validation.issues.map((issue) => `${issue.record_ref}: ${issue.problem}`).join("; ")}`);
  }
  const observationsBySource: Record<string, number> = {};
  const sourceByObservationRef = new Map<string, string>();
  for (const observation of validation.valid.observations) {
    observationsBySource[observation.source_conversation_id] = (observationsBySource[observation.source_conversation_id] ?? 0) + 1;
    sourceByObservationRef.set(observation.observation_ref, observation.source_conversation_id);
  }
  const linkSets = new Map<string, Set<number>>();
  validation.valid.links.forEach((link, index) => {
    for (const sourceId of new Set([sourceByObservationRef.get(link.from_observation_ref), sourceByObservationRef.get(link.to_observation_ref)])) {
      if (!sourceId) continue;
      const links = linkSets.get(sourceId) ?? new Set<number>();
      links.add(index); linkSets.set(sourceId, links);
    }
  });
  const linksBySource = Object.fromEntries([...linkSets].map(([sourceId, links]) => [sourceId, links.size]));
  return {
    receipt_kind: "validated_discovery_pilot", exchange_id: exchange.exchange_id,
    source_conversation_ids: exchange.selection.map((item) => item.source_conversation_id),
    observations_by_source: observationsBySource, links_by_source: linksBySource,
    first_processed_at: null, latest_processed_at: null
  };
}

export function buildReconstructionInventory(
  workspaceId: string,
  rows: CanonicalInventoryRow[],
  receipts: DiscoveryReceipt[],
  generatedAt: string,
  batchSize = DEFAULT_RECONSTRUCTION_BATCH_SIZE
): ReconstructionInventorySnapshot {
  if (!workspaceId.trim()) throw new Error("An explicit workspace is required.");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Batch size must be a positive integer.");
  const sourceIds = rows.map((row) => row.source_conversation_id);
  if (new Set(sourceIds).size !== rows.length) throw new Error("Canonical corpus contains duplicate source_conversation_id values.");
  if (rows.length !== EXPECTED_CLEAN_CORPUS_SIZE) {
    throw new Error(`Canonical clean corpus count mismatch: expected ${EXPECTED_CLEAN_CORPUS_SIZE}, observed ${rows.length}.`);
  }
  const rowIds = new Set(sourceIds);
  for (const receipt of receipts) {
    const missing = receipt.source_conversation_ids.filter((id) => !rowIds.has(id));
    if (missing.length) throw new Error(`Discovery receipt references conversations outside the canonical clean corpus: ${missing.join(", ")}`);
  }

  const receiptsBySource = new Map<string, DiscoveryReceipt>();
  for (const receipt of receipts) {
    for (const sourceId of receipt.source_conversation_ids) {
      if (receiptsBySource.has(sourceId)) throw new Error(`Multiple discovery receipts claim ${sourceId}; reconciliation is required.`);
      receiptsBySource.set(sourceId, receipt);
    }
  }

  const ordered = [...rows].sort((a, b) => {
    const aKey = chronology(a).timestamp;
    const bKey = chronology(b).timestamp;
    return aKey.localeCompare(bKey) || a.source_conversation_id.localeCompare(b.source_conversation_id)
      || a.source_version_id.localeCompare(b.source_version_id);
  });
  const conversations = ordered.map((row, index): ReconstructionInventoryEntry => {
    const sequence = index + 1;
    const receipt = receiptsBySource.get(row.source_conversation_id);
    const artifactObservations = receipt?.observations_by_source[row.source_conversation_id] ?? 0;
    const artifactLinks = receipt?.links_by_source[row.source_conversation_id] ?? 0;
    const persisted = row.persisted_observations_count > 0;
    // A reconciliation is distinct from discovery persistence and promotion.
    // Require complete coverage; one reconciled observation cannot certify the rest.
    const reconciled = persisted && row.reconciled_observations_count === row.persisted_observations_count;
    const processed = Boolean(receipt) || persisted;
    const observationsCount = persisted ? row.persisted_observations_count : artifactObservations;
    const linksCount = persisted ? row.persisted_links_count : artifactLinks;
    const reasons: string[] = [];
    if (row.evidence_block_count === 0) reasons.push("zero_evidence_blocks");
    if (row.nonempty_canonical_text_count === 0) reasons.push("zero_nonempty_canonical_text");
    if (row.verification_status !== "complete") reasons.push(`verification_${row.verification_status}`);
    const timing = chronology(row);
    return {
      source_conversation_id: row.source_conversation_id, conversation_id: row.conversation_id, title: row.title,
      created_at: row.source_created_at, updated_at: row.source_updated_at,
      chronology_timestamp: timing.timestamp, chronology_basis: timing.basis,
      chronological_sequence: sequence, source_family: row.source_family,
      source_version_id: row.source_version_id, capture_version_id: row.capture_version_id,
      evidence_block_count: row.evidence_block_count,
      canonical_text_representation_count: row.canonical_text_representation_count,
      nonempty_canonical_text_count: row.nonempty_canonical_text_count,
      empty_canonical_text_count: row.empty_canonical_text_count,
      message_count: row.message_count, user_message_count: row.user_message_count,
      assistant_message_count: row.assistant_message_count,
      evidence_status: reasons.length ? "evidence_incomplete" : "healthy",
      verification_status: row.verification_status,
      discovery_status: receipt ? "pilot_discovery_processed" : persisted ? "discovery_processed" : "unprocessed",
      observations_count: observationsCount, links_count: linksCount, processed,
      reconciled_observations_count: row.reconciled_observations_count,
      reconciliation_status: reconciled ? "reconciled" : processed ? "awaiting_reconciliation" : "not_started",
      evidence_issue: reasons.length > 0, evidence_issue_reason: reasons,
      batch_number: Math.floor(index / batchSize) + 1, batch_position: (index % batchSize) + 1,
      first_processed_at: persisted ? row.persisted_first_processed_at : receipt?.first_processed_at ?? null,
      latest_processed_at: persisted ? row.persisted_latest_processed_at : receipt?.latest_processed_at ?? null,
      processing_receipt: receipt ? "validated_pilot_artifact" : persisted ? "persisted_observations" : null
    };
  });
  const batches = buildBatches(conversations);
  const summary = summarize(conversations, batches);
  const stable: Omit<ReconstructionInventorySnapshot, "generated_at" | "inventory_sha256"> = {
    schema_version: RECONSTRUCTION_INVENTORY_SCHEMA, workspace_id: workspaceId, batch_size: batchSize,
    corpus_authority: {
      native_export_container_sha256: VERIFIED_NATIVE_EXPORT_CONTAINER,
      source_families: ["native_export", "browser_capture"] as ["native_export", "browser_capture"],
      verification_requirement: "complete" as const
    },
    processing_receipts: receipts.map((receipt) => ({ receipt_kind: receipt.receipt_kind,
      exchange_id: receipt.exchange_id, conversation_count: receipt.source_conversation_ids.length })),
    summary, batches, conversations
  };
  return { ...stable, generated_at: generatedAt, inventory_sha256: sha256(stable) };
}

export function formatReconstructionReport(snapshot: ReconstructionInventorySnapshot): string {
  const s = snapshot.summary;
  const lines = [
    `WORKSPACE: ${snapshot.workspace_id}`,
    `TOTAL CLEAN CONVERSATIONS: ${s.total_clean_conversations}`,
    `DISCOVERY PROCESSED: ${s.discovery_processed}`,
    `UNPROCESSED: ${s.unprocessed}`,
    `AWAITING RECONCILIATION: ${s.awaiting_reconciliation}`,
    `RECONCILED: ${s.reconciled}`,
    `EVIDENCE ISSUES: ${s.evidence_issues}`,
    `BATCHES TOTAL: ${s.batches_total}`,
    `BATCHES COMPLETE: ${s.batches_complete}`,
    `BATCHES PARTIAL: ${s.batches_partial}`,
    `REMAINING CONVERSATIONS: ${s.remaining_conversations}`,
    `INVENTORY SHA256: ${snapshot.inventory_sha256}`,
    `NEXT BATCH: ${s.next_batch === null ? "NONE" : formatBatch(s.next_batch)}`
  ];
  if (s.next_batch !== null) {
    lines.push("", `${formatBatch(s.next_batch)} CONVERSATIONS:`);
    for (const item of snapshot.conversations.filter((row) => row.batch_number === s.next_batch)) {
      lines.push(`${String(item.chronological_sequence).padStart(3, "0")} | ${item.source_conversation_id} | ${item.chronology_timestamp} | ${item.evidence_status} | ${item.title ?? "[untitled]"}`);
    }
  }
  return lines.join("\n");
}

function chronology(row: CanonicalInventoryRow): { timestamp: string; basis: ReconstructionInventoryEntry["chronology_basis"] } {
  if (row.source_created_at) return { timestamp: row.source_created_at, basis: "source_created_at" };
  if (row.first_message_at) return { timestamp: row.first_message_at, basis: "first_message_at" };
  if (row.source_observed_at) return { timestamp: row.source_observed_at, basis: "source_observed_at" };
  throw new Error(`Conversation ${row.source_conversation_id} has no deterministic chronology timestamp.`);
}

function buildBatches(conversations: ReconstructionInventoryEntry[]): ReconstructionBatch[] {
  const grouped = new Map<number, ReconstructionInventoryEntry[]>();
  for (const row of conversations) {
    const batch = grouped.get(row.batch_number) ?? [];
    batch.push(row); grouped.set(row.batch_number, batch);
  }
  return [...grouped].map(([batchNumber, rows]) => {
    const processed = rows.filter((row) => row.processed).length;
    return {
      batch_number: batchNumber, status: processed === 0 ? "unprocessed" : processed === rows.length ? "complete" : "partial",
      conversation_count: rows.length, processed_count: processed, remaining_count: rows.length - processed,
      evidence_issue_count: rows.filter((row) => row.evidence_issue).length,
      first_sequence: rows[0]!.chronological_sequence, last_sequence: rows.at(-1)!.chronological_sequence
    };
  });
}

function summarize(conversations: ReconstructionInventoryEntry[], batches: ReconstructionBatch[]): ReconstructionSummary {
  const evidenceIssues = conversations.filter((row) => row.evidence_issue);
  return {
    total_clean_conversations: conversations.length,
    discovery_processed: conversations.filter((row) => row.processed).length,
    unprocessed: conversations.filter((row) => !row.processed).length,
    awaiting_reconciliation: conversations.filter((row) => row.reconciliation_status === "awaiting_reconciliation").length,
    observations_awaiting_reconciliation: conversations.filter((row) => row.reconciliation_status === "awaiting_reconciliation")
      .reduce((sum, row) => sum + row.observations_count - row.reconciled_observations_count, 0),
    reconciled: conversations.filter((row) => row.reconciliation_status === "reconciled").length,
    evidence_issues: evidenceIssues.length,
    zero_evidence: evidenceIssues.filter((row) => row.evidence_block_count === 0).length,
    needs_review: conversations.filter((row) => row.verification_status === "needs_review").length,
    other_evidence_issues: evidenceIssues.filter((row) => row.evidence_block_count > 0).length,
    batches_total: batches.length, batches_complete: batches.filter((batch) => batch.status === "complete").length,
    batches_partial: batches.filter((batch) => batch.status === "partial").length,
    remaining_conversations: conversations.filter((row) => !row.processed).length,
    next_batch: batches.find((batch) => batch.status !== "complete")?.batch_number ?? null
  };
}

function formatBatch(value: number): string { return `BATCH ${String(value).padStart(3, "0")}`; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function isoOrNull(value: unknown): string | null { return value === null || value === undefined ? null : iso(value); }

export const CANONICAL_INVENTORY_SQL = `
with clean as (
  select c.source_conversation_id,c.conversation_id,c.title_representation->>'value' title,
    sv.source_family,sv.source_version_id,sv.capture_version_id,sv.verification_status,
    nullif(sv.source_metadata->>'source_create_time','') source_created_at,
    nullif(sv.source_metadata->>'source_update_time','') source_updated_at,
    sv.source_observed_at
  from memory_v1.conversations c
  join memory_v1.source_versions sv on sv.workspace_id=c.workspace_id and sv.conversation_id=c.conversation_id
  left join memory_v1.capture_versions cv on cv.workspace_id=sv.workspace_id and cv.capture_version_id=sv.capture_version_id
  where c.workspace_id=$1 and sv.verification_status='complete' and (
    (sv.source_family='native_export' and sv.source_container_sha256=$2)
    or (sv.source_family='browser_capture' and cv.verification_status='complete')
  )
), message_stats as (
  select cl.source_version_id,count(distinct m.message_id)::int message_count,
    count(distinct m.message_id) filter(where m.role='user')::int user_message_count,
    count(distinct m.message_id) filter(where m.role='assistant')::int assistant_message_count,
    min(m.source_created_at) first_message_at,max(coalesce(m.source_updated_at,m.source_created_at)) latest_message_at
  from clean cl left join memory_v1.messages m on m.workspace_id=$1 and m.conversation_id=cl.conversation_id
    and (m.source_version_id=cl.source_version_id or m.capture_version_id=cl.capture_version_id)
  group by cl.source_version_id
), block_stats as (
  select cl.source_version_id,count(distinct b.content_block_id)::int evidence_block_count,
    count(*) filter(where rep->>'representation_kind'='canonical_text')::int canonical_text_representation_count,
    count(*) filter(where rep->>'representation_kind'='canonical_text' and length(rep->>'value')>0)::int nonempty_canonical_text_count,
    count(*) filter(where rep->>'representation_kind'='canonical_text' and length(rep->>'value')=0)::int empty_canonical_text_count
  from clean cl left join memory_v1.content_blocks b on b.workspace_id=$1
    and (b.source_version_id=cl.source_version_id or b.capture_version_id=cl.capture_version_id)
  left join lateral jsonb_array_elements(b.representations) rep on true
  group by cl.source_version_id
), observation_stats as (
  select cl.conversation_id,count(distinct o.observation_id)::int persisted_observations_count,
    count(distinct o.observation_id) filter(where exists (
      select 1 from memory_v1.reconciliation_observations ro
      join memory_v1.reconciliations r
        on r.workspace_id=ro.workspace_id and r.reconciliation_id=ro.reconciliation_id
        and r.pipeline_version=ro.pipeline_version
      where ro.workspace_id=$1 and ro.workspace_id=o.workspace_id
        and ro.observation_id=o.observation_id and ro.observation_pipeline_version=o.pipeline_version
        and r.payload->>'temporal_status' is distinct from 'rejected'
    ))::int reconciled_observations_count,
    min(o.created_at) persisted_first_processed_at,max(o.created_at) persisted_latest_processed_at
  from clean cl left join memory_v1.observations o on o.workspace_id=$1 and o.conversation_id=cl.conversation_id
  group by cl.conversation_id
), link_stats as (
  select cl.conversation_id,count(distinct l.observation_link_id)::int persisted_links_count
  from clean cl
  left join memory_v1.observations o on o.workspace_id=$1 and o.conversation_id=cl.conversation_id
  left join memory_v1.observation_links l on l.workspace_id=$1
    and (l.from_observation_id=o.observation_id or l.to_observation_id=o.observation_id)
  group by cl.conversation_id
)
select cl.*,ms.message_count,ms.user_message_count,ms.assistant_message_count,ms.first_message_at,ms.latest_message_at,
  bs.evidence_block_count,bs.canonical_text_representation_count,bs.nonempty_canonical_text_count,bs.empty_canonical_text_count,
  os.persisted_observations_count,os.reconciled_observations_count,
  os.persisted_first_processed_at,os.persisted_latest_processed_at,ls.persisted_links_count
from clean cl join message_stats ms using(source_version_id) join block_stats bs using(source_version_id)
join observation_stats os using(conversation_id) join link_stats ls using(conversation_id)`;
