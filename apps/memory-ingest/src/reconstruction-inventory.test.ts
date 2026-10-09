import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "./db.js";
import { sha256 } from "@hhs/memory-schema";
import {
  DEFAULT_RECONSTRUCTION_BATCH_SIZE,
  EXPECTED_CLEAN_CORPUS_SIZE,
  buildDiscoveryReceipt,
  buildReconstructionInventory,
  loadCanonicalInventoryRows,
  type CanonicalInventoryRow,
  type DiscoveryReceipt
} from "./reconstruction-inventory.js";
import {
  UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  UNDERSTANDING_INPUT_SCHEMA,
  UNDERSTANDING_OUTPUT_SCHEMA,
  type DiscoveryEvidence,
  type DiscoveryExchange,
  type DiscoveryOutput
} from "./understanding-discovery.js";

const WORKSPACE = "proof-workspace-5plus2-db";
const HELD_UUID = "2b0f1f8b-4a6c-8330-9d3b-8828b0ef00b0";

function canonicalRows(): CanonicalInventoryRow[] {
  return Array.from({ length: EXPECTED_CLEAN_CORPUS_SIZE }, (_, index) => {
    const number = index + 1;
    const id = `clean-${String(number).padStart(4, "0")}`;
    return {
      source_conversation_id: id, conversation_id: `conversation-${id}`, title: `Conversation ${number}`,
      source_family: number > 976 ? "browser_capture" : "native_export",
      source_version_id: `version-${id}`, capture_version_id: number > 976 ? `capture-${id}` : null,
      verification_status: "complete", source_created_at: number > 976 ? null : `2025-01-${String(Math.ceil(number / 40)).padStart(2, "0")}T00:00:${String(number % 60).padStart(2, "0")}.000Z`,
      source_updated_at: null, first_message_at: null,
      latest_message_at: null, source_observed_at: number > 976 ? `2026-08-${String(number - 976).padStart(2, "0")}T00:00:00.000Z` : "2026-01-06T18:36:45.000Z",
      message_count: 2, user_message_count: 1, assistant_message_count: 1,
      evidence_block_count: number === 995 ? 0 : 2,
      canonical_text_representation_count: number === 995 ? 0 : 2,
      nonempty_canonical_text_count: number === 995 ? 0 : 2,
      empty_canonical_text_count: 0, persisted_observations_count: 0, reconciled_observations_count: 0, persisted_links_count: 0,
      persisted_first_processed_at: null, persisted_latest_processed_at: null
    };
  });
}

function pilotReceipt(): DiscoveryReceipt {
  const ids = ["clean-0012", "clean-0200", "clean-0500", "clean-0980", "clean-0995"];
  return {
    receipt_kind: "validated_discovery_pilot", exchange_id: "pilot-exchange", source_conversation_ids: ids,
    observations_by_source: { "clean-0012": 4, "clean-0200": 3, "clean-0500": 4, "clean-0980": 6 },
    links_by_source: { "clean-0012": 3, "clean-0200": 2, "clean-0500": 4, "clean-0980": 3 },
    first_processed_at: null, latest_processed_at: null
  };
}

/** A receipt of arbitrary size; membership is whatever its exchange selected. */
function receiptFor(exchangeId: string, ids: string[], observations = 2, links = 1): DiscoveryReceipt {
  return {
    receipt_kind: "validated_discovery_pilot", exchange_id: exchangeId, source_conversation_ids: ids,
    observations_by_source: Object.fromEntries(ids.map((id) => [id, observations])),
    links_by_source: Object.fromEntries(ids.map((id) => [id, links])),
    first_processed_at: null, latest_processed_at: null
  };
}

function batchMembers(batchNumber: number, batchSize = DEFAULT_RECONSTRUCTION_BATCH_SIZE): string[] {
  return buildReconstructionInventory(WORKSPACE, canonicalRows(), [], "2026-08-31T00:00:00.000Z", batchSize)
    .conversations.filter((row) => row.batch_number === batchNumber).map((row) => row.source_conversation_id);
}

describe("reconstruction inventory control plane", () => {
  it("contains exactly 995 unique clean conversations and excludes held identities", () => {
    const snapshot = buildReconstructionInventory(WORKSPACE, canonicalRows(), [pilotReceipt()], "2026-08-31T00:00:00.000Z");
    expect(snapshot.summary.total_clean_conversations).toBe(995);
    expect(new Set(snapshot.conversations.map((row) => row.source_conversation_id)).size).toBe(995);
    expect(snapshot.conversations.some((row) => row.source_conversation_id === HELD_UUID)).toBe(false);
  });

  it("orders and batches deterministically regardless of query row order", () => {
    const rows = canonicalRows();
    const first = buildReconstructionInventory(WORKSPACE, rows, [pilotReceipt()], "2026-08-31T00:00:00.000Z");
    const replay = buildReconstructionInventory(WORKSPACE, [...rows].reverse(), [pilotReceipt()], "2026-09-01T00:00:00.000Z");
    expect(replay.inventory_sha256).toBe(first.inventory_sha256);
    expect(replay.conversations.map((row) => [row.source_conversation_id, row.chronological_sequence, row.batch_number, row.batch_position]))
      .toEqual(first.conversations.map((row) => [row.source_conversation_id, row.chronological_sequence, row.batch_number, row.batch_position]));
    expect(first.batch_size).toBe(DEFAULT_RECONSTRUCTION_BATCH_SIZE);
    expect(first.batches).toHaveLength(100);
    expect(first.batches[0]).toMatchObject({ conversation_count: 10, first_sequence: 1, last_sequence: 10 });
    expect(first.batches.at(-1)).toMatchObject({ conversation_count: 5, first_sequence: 991, last_sequence: 995 });
  });

  it("marks only the five receipt conversations as pilot processed and awaiting reconciliation", () => {
    const snapshot = buildReconstructionInventory(WORKSPACE, canonicalRows(), [pilotReceipt()], "2026-08-31T00:00:00.000Z");
    const processed = snapshot.conversations.filter((row) => row.processed);
    expect(processed).toHaveLength(5);
    expect(processed.every((row) => row.discovery_status === "pilot_discovery_processed")).toBe(true);
    expect(processed.every((row) => row.reconciliation_status === "awaiting_reconciliation")).toBe(true);
    expect(processed.every((row) => row.first_processed_at === null && row.latest_processed_at === null)).toBe(true);
    expect(snapshot.summary).toMatchObject({ discovery_processed: 5, unprocessed: 990,
      awaiting_reconciliation: 5, observations_awaiting_reconciliation: 17, reconciled: 0 });
  });

  it("keeps persisted discovery observations awaiting trusted reconciliation", () => {
    const rows = canonicalRows();
    rows[0] = {
      ...rows[0]!,
      persisted_observations_count: 2,
      persisted_links_count: 1,
      persisted_first_processed_at: "2026-09-04T00:00:00.000Z",
      persisted_latest_processed_at: "2026-09-04T00:00:00.000Z"
    };
    const snapshot = buildReconstructionInventory(WORKSPACE, rows, [], "2026-09-04T00:00:00.000Z");
    expect(snapshot.conversations[0]).toMatchObject({
      discovery_status: "discovery_processed",
      reconciliation_status: "awaiting_reconciliation",
      processing_receipt: "persisted_observations"
    });
    expect(snapshot.summary).toMatchObject({
      discovery_processed: 1,
      awaiting_reconciliation: 1,
      observations_awaiting_reconciliation: 2,
      reconciled: 0
    });
  });

  it("requires trusted reconciliation coverage of every persisted observation", () => {
    for (const covered of [0, 1, 2]) {
      const rows = canonicalRows();
      rows[0] = { ...rows[0]!, persisted_observations_count: 2, reconciled_observations_count: covered };
      const snapshot = buildReconstructionInventory(WORKSPACE, rows, [], "2026-09-04T00:00:00.000Z");
      expect(snapshot.conversations[0]!.reconciliation_status).toBe(covered === 2 ? "reconciled" : "awaiting_reconciliation");
      expect(snapshot.summary.reconciled).toBe(covered === 2 ? 1 : 0);
      expect(snapshot.summary.awaiting_reconciliation).toBe(covered === 2 ? 0 : 1);
    }
    const empty = buildReconstructionInventory(WORKSPACE, canonicalRows(), [], "2026-09-04T00:00:00.000Z");
    expect(empty.conversations[0]!.reconciliation_status).toBe("not_started");
  });

  it.each([
    [3, 1, 2],
    [3, 3, 0],
    [3, 0, 3]
  ])("counts only uncovered observations: %i observations, %i reconciled => %i awaiting", (observations, covered, awaiting) => {
    const rows = canonicalRows();
    rows[0] = { ...rows[0]!, persisted_observations_count: observations, reconciled_observations_count: covered };
    const snapshot = buildReconstructionInventory(WORKSPACE, rows, [], "2026-09-04T00:00:00.000Z");
    expect(snapshot.conversations[0]).toMatchObject({ observations_count: observations, reconciled_observations_count: covered });
    expect(snapshot.summary.observations_awaiting_reconciliation).toBe(awaiting);
  });

  it("loads coverage only through same-workspace immutable reconciliation lineage with both pipeline identities", async () => {
    const row = { ...canonicalRows()[0]!, persisted_observations_count: "2", reconciled_observations_count: "2" };
    const query = vi.fn(async () => ({ rows: [row] }));
    const loaded = await loadCanonicalInventoryRows({ query } as unknown as DbClient, WORKSPACE);
    expect(loaded[0]).toMatchObject({ persisted_observations_count: 2, reconciled_observations_count: 2 });
    const [sql, parameters] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(parameters[0]).toBe(WORKSPACE);
    expect(sql).toContain("c.workspace_id=$1");
    expect(sql).toContain("o.workspace_id=$1 and o.conversation_id=cl.conversation_id");
    expect(sql).toContain("from memory_v1.reconciliation_observations ro");
    expect(sql).toContain("join memory_v1.reconciliations r");
    expect(sql).toContain("r.workspace_id=ro.workspace_id and r.reconciliation_id=ro.reconciliation_id");
    expect(sql).toContain("r.pipeline_version=ro.pipeline_version");
    expect(sql).toContain("ro.workspace_id=$1 and ro.workspace_id=o.workspace_id");
    expect(sql).toContain("ro.observation_id=o.observation_id and ro.observation_pipeline_version=o.pipeline_version");
    expect(sql).toContain("count(distinct o.observation_id) filter(where exists");
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it.each([
    ["rejected", 0, "awaiting_reconciliation"],
    ["current", 1, "reconciled"]
  ] as const)("excludes rejected reconciliation coverage while retaining non-rejected coverage: %s", async (status, covered, expected) => {
    // Mock only the DB aggregate; assert the rejection filter in the actual SQL
    // so removing it cannot leave this read-model regression passing.
    const reconciliation = { payload: { temporal_status: status } };
    const row = { ...canonicalRows()[0]!, persisted_observations_count: 1,
      reconciled_observations_count: reconciliation.payload.temporal_status === "rejected" ? 0 : 1 };
    const query = vi.fn(async (sql: string) => {
      expect(sql).toMatch(/ro\.observation_pipeline_version=o\.pipeline_version\s+and r\.payload->>'temporal_status' is distinct from 'rejected'/);
      // Coverage retains all existing relations, including contradiction/context.
      expect(sql).not.toMatch(/\bro\.relation\s*(?:=|in\b)/i);
      return { rows: [row] };
    });
    const loaded = await loadCanonicalInventoryRows({ query } as unknown as DbClient, WORKSPACE);
    const rows = canonicalRows();
    rows[0] = loaded[0]!;
    const snapshot = buildReconstructionInventory(WORKSPACE, rows, [], "2026-09-04T00:00:00.000Z");
    expect(snapshot.conversations[0]).toMatchObject({ discovery_status: "discovery_processed", reconciliation_status: expected });
    expect(snapshot.summary.reconciled).toBe(covered);
    expect(snapshot.summary.awaiting_reconciliation).toBe(1 - covered);
  });

  it("surfaces zero evidence without excluding or fabricating completeness", () => {
    const snapshot = buildReconstructionInventory(WORKSPACE, canonicalRows(), [pilotReceipt()], "2026-08-31T00:00:00.000Z");
    const broken = snapshot.conversations.find((row) => row.source_conversation_id === "clean-0995")!;
    expect(broken).toMatchObject({ evidence_status: "evidence_incomplete", evidence_issue: true,
      evidence_issue_reason: ["zero_evidence_blocks", "zero_nonempty_canonical_text"] });
    expect(snapshot.summary).toMatchObject({ evidence_issues: 1, zero_evidence: 1, needs_review: 0 });
  });

  it("rejects duplicate corpus IDs and receipts outside the clean corpus", () => {
    const rows = canonicalRows();
    expect(() => buildReconstructionInventory(WORKSPACE, [...rows, rows[0]!], [], "2026-08-31T00:00:00.000Z"))
      .toThrow(/duplicate source_conversation_id/);
    expect(() => buildReconstructionInventory(WORKSPACE, rows, [{ ...pilotReceipt(), source_conversation_ids: [HELD_UUID] }], "2026-08-31T00:00:00.000Z"))
      .toThrow(/outside the canonical clean corpus/);
  });

  it("creates a pilot receipt only after the existing discovery validator accepts it", () => {
    const fixture = discoveryFixture();
    const receipt = buildDiscoveryReceipt(fixture.exchange, fixture.output);
    expect(receipt).toMatchObject({ receipt_kind: "validated_discovery_pilot", source_conversation_ids: ["fixture-source"],
      observations_by_source: { "fixture-source": 1 } });
    expect(() => buildDiscoveryReceipt(fixture.exchange, { ...fixture.output, exchange_id: "invented" })).toThrow(/receipt is invalid/);
  });

  it("derives receipt membership from the validated exchange at any conversation count", () => {
    for (const size of [1, 5, 10, 17]) {
      const ids = Array.from({ length: size }, (_, index) => `fixture-source-${index + 1}`);
      const fixture = discoveryFixture(ids);
      const receipt = buildDiscoveryReceipt(fixture.exchange, fixture.output);
      expect(receipt.source_conversation_ids).toEqual(ids);
      expect(Object.values(receipt.observations_by_source).reduce((sum, count) => sum + count, 0)).toBe(size);
    }
  });

  it("accepts validated receipts of any size, not only the original five", () => {
    const rows = canonicalRows();
    for (const size of [3, 5, 10, 25]) {
      const ids = rows.slice(0, size).map((row) => row.source_conversation_id);
      const snapshot = buildReconstructionInventory(WORKSPACE, rows, [receiptFor(`exchange-${size}`, ids)], "2026-08-31T00:00:00.000Z");
      expect(snapshot.summary.discovery_processed).toBe(size);
      expect(snapshot.summary.unprocessed).toBe(EXPECTED_CLEAN_CORPUS_SIZE - size);
      expect(snapshot.processing_receipts).toEqual([
        { receipt_kind: "validated_discovery_pilot", exchange_id: `exchange-${size}`, conversation_count: size }
      ]);
    }
  });

  it("layers multiple non-overlapping receipts without double counting", () => {
    const rows = canonicalRows();
    const batchOne = batchMembers(1);
    const pilot = pilotReceipt();
    expect(batchOne.some((id) => pilot.source_conversation_ids.includes(id))).toBe(false);
    const snapshot = buildReconstructionInventory(WORKSPACE, rows, [pilot, receiptFor("batch-001-exchange", batchOne, 4, 2)], "2026-08-31T00:00:00.000Z");
    expect(snapshot.summary.discovery_processed).toBe(15);
    expect(snapshot.summary.unprocessed).toBe(980);
    expect(snapshot.summary.awaiting_reconciliation).toBe(15);
    expect(snapshot.summary.reconciled).toBe(0);
    expect(snapshot.summary.observations_awaiting_reconciliation).toBe(17 + 40);
    expect(snapshot.processing_receipts.map((receipt) => receipt.conversation_count)).toEqual([5, 10]);
    expect(snapshot.conversations.filter((row) => row.processed)).toHaveLength(15);
  });

  it("separates receipt size from batch size", () => {
    const rows = canonicalRows();
    const spansTwoBatches = rows.slice(0, 40).map((row) => row.source_conversation_id);
    const snapshot = buildReconstructionInventory(WORKSPACE, rows, [receiptFor("wide-exchange", spansTwoBatches)], "2026-08-31T00:00:00.000Z", 7);
    expect(snapshot.batch_size).toBe(7);
    expect(snapshot.summary.discovery_processed).toBe(40);
    expect(new Set(snapshot.conversations.filter((row) => row.processed).map((row) => row.batch_number)).size).toBeGreaterThan(1);
  });

  it("rejects overlapping receipt claims instead of silently merging or double counting", () => {
    const rows = canonicalRows();
    const shared = "clean-0200";
    expect(() => buildReconstructionInventory(WORKSPACE, rows,
      [pilotReceipt(), receiptFor("overlapping-exchange", [shared, "clean-0201"])], "2026-08-31T00:00:00.000Z"))
      .toThrow(new RegExp(`Multiple discovery receipts claim ${shared}`));
  });

  it("keeps corpus, ordering and batch assignment identical however many receipts are supplied", () => {
    const rows = canonicalRows();
    const identity = (snapshot: ReturnType<typeof buildReconstructionInventory>) =>
      snapshot.conversations.map((row) => [row.source_conversation_id, row.chronological_sequence, row.batch_number, row.batch_position]);
    const none = buildReconstructionInventory(WORKSPACE, rows, [], "2026-08-31T00:00:00.000Z");
    const two = buildReconstructionInventory(WORKSPACE, rows, [pilotReceipt(), receiptFor("batch-001-exchange", batchMembers(1))], "2026-08-31T00:00:00.000Z");
    expect(two.summary.total_clean_conversations).toBe(EXPECTED_CLEAN_CORPUS_SIZE);
    expect(identity(two)).toEqual(identity(none));
    expect(two.batches.map((batch) => [batch.batch_number, batch.first_sequence, batch.last_sequence]))
      .toEqual(none.batches.map((batch) => [batch.batch_number, batch.first_sequence, batch.last_sequence]));
  });

  it("completes a batch and advances next_batch when that batch's receipt is supplied", () => {
    const rows = canonicalRows();
    const before = buildReconstructionInventory(WORKSPACE, rows, [], "2026-08-31T00:00:00.000Z");
    expect(before.batches[0]).toMatchObject({ batch_number: 1, status: "unprocessed" });
    expect(before.summary.next_batch).toBe(1);

    const after = buildReconstructionInventory(WORKSPACE, rows, [receiptFor("batch-001-exchange", batchMembers(1))], "2026-08-31T00:00:00.000Z");
    expect(after.batches[0]).toMatchObject({ batch_number: 1, status: "complete", processed_count: 10, remaining_count: 0 });
    expect(after.summary.next_batch).toBe(2);
    expect(after.summary.batches_complete).toBe(1);

    const batchOne = after.conversations.filter((row) => row.batch_number === 1);
    expect(batchOne.every((row) => row.discovery_status === "pilot_discovery_processed")).toBe(true);
    expect(batchOne.every((row) => row.processing_receipt === "validated_pilot_artifact")).toBe(true);
    expect(batchOne.every((row) => row.reconciliation_status === "awaiting_reconciliation")).toBe(true);
    expect(after.summary.reconciled).toBe(0);
  });
});

/** Bounded validator-passing fixture over an arbitrary number of conversations. */
function discoveryFixture(sourceIds: string[] = ["fixture-source"]): { exchange: DiscoveryExchange; output: DiscoveryOutput } {
  const evidence = sourceIds.map((sourceId): DiscoveryEvidence => {
    const text = `A bounded fixture supports one provisional finding for ${sourceId}.`;
    const hash = sha256(text);
    return {
      evidence_ref: `${sourceId}-evidence`, source_conversation_id: sourceId, conversation_id: `${sourceId}-conversation`,
      source_family: "native_export", source_version_id: `${sourceId}-version`, capture_version_id: null,
      message_id: `${sourceId}-message`, source_message_id: `${sourceId}-source-message`, message_sequence: 0,
      role: "assistant", active_path: true, content_block_id: `${sourceId}-block`, block_kind: "text",
      representation_kind: "canonical_text", text, representation_sha256: hash,
      source_record_id: `${sourceId}-record`, immutable_evidence_locator: "fixture://message", source_record_sha256: hash,
      source_version_locator: "fixture://conversation", source_container_sha256: "a".repeat(64), capture_locator: null,
      capture_manifest_sha256: null, resolution_id: `${sourceId}-resolution`, resolution_expected_sha256: hash,
      resolution_observed_sha256: hash, resolution_exact: true, source_observed_at: "2026-01-01T00:00:00.000Z"
    };
  });
  const exchange: DiscoveryExchange = {
    schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: "fixture-exchange", evidence_sha256: sha256(evidence), created_at: "2026-01-01T00:00:00.000Z",
    selection: sourceIds.map((sourceId, index) => ({ source_conversation_id: sourceId, conversation_id: `${sourceId}-conversation`,
      title: `Fixture ${index + 1}`, source_family: "native_export", observed_at: "2026-01-01T00:00:00.000Z", message_count: 1,
      content_characters: evidence[index]!.text.length, source_version_id: `${sourceId}-version`, content_sha256: "b".repeat(64),
      immutable_source_locator: "fixture://conversation", source_container_sha256: "a".repeat(64),
      capture_version_id: null, capture_manifest_sha256: null, capture_locator: null })), evidence,
    model_instructions: { output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
      link_kinds_are_free_text: true, evidence_refs_are_authoritative: true, evidence_excerpts_are_optional: true,
      user_authority_requires_user_evidence: true, database_ids_or_hashes_required: false, model_metadata_required: false }
  };
  const output: DiscoveryOutput = {
    schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: exchange.exchange_id,
    observations: sourceIds.map((sourceId, index) => ({ observation_ref: `o${index + 1}`, source_conversation_id: sourceId,
      observation_kind: "free kind", statement: `The assistant offers a provisional finding for ${sourceId}.`, payload: {},
      attribution: { subject: "assistant" as const, claim_type: "finding" }, confidence: 0.8,
      evidence: [{ evidence_ref: `${sourceId}-evidence` }] })), links: []
  };
  return { exchange, output };
}
