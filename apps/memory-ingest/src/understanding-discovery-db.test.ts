import { afterAll, describe, expect, it } from "vitest";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert } from "./db.js";
import {
  UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  UNDERSTANDING_INPUT_SCHEMA,
  UNDERSTANDING_OUTPUT_SCHEMA,
  VERIFIED_NATIVE_EXPORT_CONTAINER,
  listPilotCandidatesFromClient,
  persistValidatedDiscovery,
  prepareDiscoveryExchange,
  prepareDiscoveryExchangeFromClient,
  validateDiscoveryOutput,
  type DiscoveryEvidence,
  type DiscoveryExchange,
  type DiscoveryOutput,
  type TrustedDiscoveryModel
} from "./understanding-discovery.js";

const enabled = process.env.HHS_RUN_UNDERSTANDING_DB_PROOF === "1" && Boolean(process.env.MEMORY_DATABASE_URL);
const suite = enabled ? describe : describe.skip;
const WORKSPACE = "understanding-layer-rollback-proof";
const SOURCE_PIPELINE = "understanding-fixture-source/0.1.0";
const HELD_UUID = "2b0f1f8b-4a6c-8330-9d3b-8828b0ef00b0";
const TARGET_WORKSPACE = "proof-workspace-5plus2-db";
const TRUSTED_MODEL: TrustedDiscoveryModel = {
  provider: "trusted-fixture-runner", name: "hermes-nemotron", version: "fixture-v1",
  runner_version: "understanding-db-proof/0.2.0"
};
const pool = enabled ? createPool("admin") : undefined;

afterAll(async () => { await pool?.end(); });

suite("database-backed understanding layer", () => {
  it("has forced RLS, append-only guards, free-text kinds, and empty real tables", async () => {
    const result = await pool!.query(`select
      (select count(*)::int from memory_v1.observations) observations,
      (select count(*)::int from memory_v1.observation_links) links,
      (select count(*)::int from pg_policies where schemaname='memory_v1' and tablename in ('observations','observation_links')) policies,
      (select count(*)::int from pg_trigger where tgrelid in ('memory_v1.observations'::regclass,'memory_v1.observation_links'::regclass)
        and tgname='immutable_row_guard' and not tgisinternal) immutable_guards,
      (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('memory_v1.observations'::regclass,'memory_v1.observation_links'::regclass)) forced_rls,
      (select pg_get_constraintdef(oid) from pg_constraint where conrelid='memory_v1.provenance_edges'::regclass
        and conname='provenance_edges_target_record_type_check') provenance_targets`);
    expect(result.rows[0]).toMatchObject({ observations: 0, links: 0, policies: 2, immutable_guards: 2, forced_rls: true });
    expect(result.rows[0].provenance_targets).toContain("observation");
  });

  it("rejects a held-back UUID before any evidence exchange is produced", async () => {
    await expect(prepareDiscoveryExchange(TARGET_WORKSPACE, [HELD_UUID])).rejects.toThrow(/outside the authorized clean corpus/);
  });

  it("persists arbitrary kinds idempotently with exact provenance, rejects mutation, and rolls back", async () => {
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [WORKSPACE]);
      await client.query("set constraints all deferred");
      const fixture = await seedFixture(client);
      const pilotCandidates = await listPilotCandidatesFromClient(client, WORKSPACE);
      expect(pilotCandidates).toHaveLength(1);
      expect(pilotCandidates[0]).toMatchObject({ source_conversation_id: "fixture-conversation", source_family: "native_export", message_count: 2 });
      const exchange = await prepareDiscoveryExchangeFromClient(client, WORKSPACE, ["fixture-conversation"], "2026-01-06T00:00:00.000Z");
      expect(exchange.evidence).toHaveLength(2);
      expect(exchange.selection[0]).toMatchObject({ source_conversation_id: "fixture-conversation", message_count: 2 });
      const userRef = exchange.evidence.find((item) => item.role === "user")!.evidence_ref;
      const assistantRef = exchange.evidence.find((item) => item.role === "assistant")!.evidence_ref;
      const output = { ...fixture.output, exchange_id: exchange.exchange_id,
        observations: fixture.output.observations.map((item, index) => ({ ...item,
          evidence: item.evidence.map((citation) => ({ ...citation, evidence_ref: index === 0 ? userRef : assistantRef }))
        })) };
      const validated = validateDiscoveryOutput(exchange, output, TRUSTED_MODEL);
      expect(validated.issues).toEqual([]);
      expect(validated.valid).toBeDefined();
      const approvedBefore = Number((await client.query("select count(*) n from memory_v1.approved_knowledge")).rows[0].n);
      const first = await persistValidatedDiscovery(client, WORKSPACE, exchange, validated.valid!);
      const replay = await persistValidatedDiscovery(client, WORKSPACE, exchange, validated.valid!);
      expect(first).toMatchObject({ observations_inserted: 2, observation_links_inserted: 1, provenance_edges_inserted: 2, replay: false });
      expect(replay).toMatchObject({ observations_inserted: 0, observation_links_inserted: 0, provenance_edges_inserted: 0, replay: true });

      const arbitrary = await client.query("select observation_kind from memory_v1.observations where workspace_id=$1 order by observation_kind", [WORKSPACE]);
      const arbitraryLinks = await client.query("select link_kind from memory_v1.observation_links where workspace_id=$1", [WORKSPACE]);
      expect(arbitrary.rows.map((row) => row.observation_kind)).toEqual(["emergent/decision-signal.v7", "unforeseen.topic-shape"]);
      expect(arbitraryLinks.rows[0].link_kind).toBe("model-coherence/novel-link");

      const chain = await client.query(`select count(*)::int n
        from memory_v1.observations o
        join memory_v1.provenance_edges p on (p.workspace_id,p.target_record_id,p.pipeline_version)=(o.workspace_id,o.observation_id,o.pipeline_version)
        join memory_v1.content_blocks b on b.workspace_id=p.workspace_id and b.content_block_id=p.content_block_id
        join memory_v1.messages m on m.workspace_id=p.workspace_id and m.message_id=p.message_id
        join memory_v1.conversations c on c.workspace_id=p.workspace_id and c.conversation_id=p.conversation_id
        join memory_v1.source_versions sv on sv.workspace_id=p.workspace_id and sv.source_version_id=p.source_version_id
        join memory_v1.source_records sr on sr.workspace_id=p.workspace_id and sr.source_record_id=p.source_record_id
        join memory_v1.archive_hash_resolutions a on a.workspace_id=p.workspace_id and a.source_record_id=p.source_record_id
          and a.source_version_id=p.source_version_id and a.expected_sha256=p.representation_sha256 and a.exact_match
        where o.workspace_id=$1 and sv.immutable_source_locator<>'' and sr.immutable_evidence_locator<>''
          and a.expected_sha256=a.observed_sha256`, [WORKSPACE]);
      expect(chain.rows[0].n).toBe(2);
      expect(Number((await client.query("select count(*) n from memory_v1.approved_knowledge")).rows[0].n)).toBe(approvedBefore);

      await client.query("savepoint immutable_probe");
      await expect(client.query("update memory_v1.observations set status='reviewed' where workspace_id=$1", [WORKSPACE])).rejects.toThrow(/append-only/);
      await client.query("rollback to savepoint immutable_probe");
      await client.query("rollback");
      const after = await pool!.query("select count(*)::int n from memory_v1.observations where workspace_id=$1", [WORKSPACE]);
      expect(after.rows[0].n).toBe(0);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  });
});

async function seedFixture(client: import("./db.js").DbClient): Promise<{ exchange: DiscoveryExchange; output: DiscoveryOutput }> {
  const systemId = deterministicId("source_system", WORKSPACE, "fixture");
  const accountId = deterministicId("source_account", WORKSPACE, "fixture");
  const runId = deterministicId("ingestion_run", WORKSPACE, "fixture");
  const conversationId = deterministicId("conversation", WORKSPACE, "fixture");
  const versionId = deterministicId("source_version", WORKSPACE, "fixture");
  const conversationRecordId = deterministicId("source_record", WORKSPACE, "conversation");
  await immutableInsert(client, "workspaces", "workspace_id", row("workspace", "fixture", {
    workspace_id: WORKSPACE, name: "Understanding rollback fixture", isolation_key: WORKSPACE, status: "active", created_at: "2026-01-06T00:00:00.000Z"
  }));
  await immutableInsert(client, "source_systems", "source_system_id", row("source_system", "fixture", {
    workspace_id: WORKSPACE, source_system_id: systemId, kind: "fixture", adapter_contract: "fixture/0.1.0"
  }));
  await immutableInsert(client, "source_accounts", "source_account_id", row("source_account", "fixture", {
    workspace_id: WORKSPACE, source_account_id: accountId, source_system_id: systemId, opaque_account_reference: "fixture"
  }));
  await client.query(`insert into memory_v1.ingestion_runs
    (workspace_id,ingestion_run_id,source_system_id,source_account_id,idempotency_key,status,started_at,input_manifest_sha256,
     checkpoint_key,attempt_count,pipeline_version,expected_message_count,expected_content_block_count,expected_chunk_count)
    values ($1,$2,$3,$4,$5,'running',$6,$7,'fixture',1,$8,2,2,0)`,
  [WORKSPACE, runId, systemId, accountId, idempotencyKey("ingestion_run", WORKSPACE, "fixture"),
    "2026-01-06T00:00:00.000Z", VERIFIED_NATIVE_EXPORT_CONTAINER, SOURCE_PIPELINE]);
  await immutableInsert(client, "source_records", "source_record_id", row("source_record", "conversation", {
    workspace_id: WORKSPACE, source_record_id: conversationRecordId, ingestion_run_id: runId, source_system_id: systemId,
    source_account_id: accountId, source_native_id: "fixture-conversation", record_kind: "conversation",
    immutable_evidence_locator: "hhs-fixture://conversation", source_sha256: sha256("fixture-conversation"), observed_at: "2026-01-06T00:00:00.000Z"
  }));
  await immutableInsert(client, "conversations", "conversation_id", row("conversation", "fixture", {
    workspace_id: WORKSPACE, conversation_id: conversationId, source_record_id: conversationRecordId,
    capture_version_id: null, source_version_id: null, source_conversation_id: "fixture-conversation",
    title_representation: { representation_kind: "canonical_text", value: "Fixture", sha256: sha256("Fixture"), evidence_locator: "hhs-fixture://title" }
  }));
  await immutableInsert(client, "source_versions", "source_version_id", row("source_version", "fixture", {
    workspace_id: WORKSPACE, source_version_id: versionId, pipeline_version: SOURCE_PIPELINE,
    source_record_id: conversationRecordId, conversation_id: conversationId, source_family: "native_export",
    content_sha256: sha256({ fixture: true }), immutable_source_locator: "hhs-fixture://conversation",
    source_container_sha256: VERIFIED_NATIVE_EXPORT_CONTAINER, verification_status: "complete",
    source_observed_at: "2026-01-06T00:00:00.000Z", source_metadata: { fixture: true }, capture_version_id: null,
    created_at: "2026-01-06T00:00:00.000Z"
  }));

  const specs = [
    { role: "user", text: "I require source-linked observations and prefer flexible categories." },
    { role: "assistant", text: "A novel topic shape may connect the requirement to provenance." }
  ];
  const evidence: DiscoveryEvidence[] = [];
  for (const [sequence, spec] of specs.entries()) {
    const messageId = deterministicId("message", WORKSPACE, sequence);
    const blockId = deterministicId("content_block", WORKSPACE, sequence);
    const sourceRecordId = deterministicId("source_record", WORKSPACE, sequence);
    const hash = sha256(spec.text);
    const locator = `hhs-fixture://conversation/messages/${sequence}`;
    await immutableInsert(client, "source_records", "source_record_id", row("source_record", sequence, {
      workspace_id: WORKSPACE, source_record_id: sourceRecordId, ingestion_run_id: runId, source_system_id: systemId,
      source_account_id: accountId, source_native_id: `fixture-message-${sequence}`, record_kind: "message",
      immutable_evidence_locator: locator, source_sha256: hash, observed_at: "2026-01-06T00:00:00.000Z"
    }));
    await immutableInsert(client, "messages", "message_id", row("message", sequence, {
      workspace_id: WORKSPACE, message_id: messageId, source_record_id: sourceRecordId, conversation_id: conversationId,
      capture_version_id: null, source_version_id: versionId, source_message_id: `fixture-message-${sequence}`,
      sequence, role: spec.role, parent_message_id: null, active_path: true, representations: []
    }));
    await immutableInsert(client, "content_blocks", "content_block_id", row("content_block", sequence, {
      workspace_id: WORKSPACE, content_block_id: blockId, source_record_id: sourceRecordId, message_id: messageId,
      capture_version_id: null, source_version_id: versionId, sequence: 0, block_kind: "text",
      representations: [{ representation_kind: "canonical_text", value: spec.text, sha256: hash, evidence_locator: locator }]
    }));
    const resolutionId = deterministicId("archive_hash_resolution", WORKSPACE, sequence);
    await client.query(`insert into memory_v1.archive_hash_resolutions
      (workspace_id,resolution_id,source_record_id,capture_version_id,locator,expected_sha256,observed_sha256,resolved_at,pipeline_version,ingestion_run_id,source_version_id)
      values ($1,$2,$3,null,$4,$5,$5,$6,$7,$8,$9)`,
    [WORKSPACE, resolutionId, sourceRecordId, locator, hash, "2026-01-06T00:00:00.000Z", SOURCE_PIPELINE, runId, versionId]);
    evidence.push({
      evidence_ref: `fixture-${sequence}`, source_conversation_id: "fixture-conversation", conversation_id: conversationId,
      source_family: "native_export", source_version_id: versionId, capture_version_id: null,
      message_id: messageId, source_message_id: `fixture-message-${sequence}`, message_sequence: sequence,
      role: spec.role, active_path: true, content_block_id: blockId, block_kind: "text",
      representation_kind: "canonical_text", text: spec.text, representation_sha256: hash,
      source_record_id: sourceRecordId, immutable_evidence_locator: locator, source_record_sha256: hash,
      source_version_locator: "hhs-fixture://conversation", source_container_sha256: VERIFIED_NATIVE_EXPORT_CONTAINER,
      capture_locator: null, capture_manifest_sha256: null, resolution_id: resolutionId,
      resolution_expected_sha256: hash, resolution_observed_sha256: hash, resolution_exact: true,
      source_observed_at: "2026-01-06T00:00:00.000Z"
    });
  }
  const exchange: DiscoveryExchange = {
    schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: "fixture-exchange", evidence_sha256: sha256(evidence), created_at: "2026-01-06T00:00:00.000Z",
    selection: [{ source_conversation_id: "fixture-conversation", conversation_id: conversationId, title: "Fixture",
      source_family: "native_export", observed_at: "2026-01-06T00:00:00.000Z", message_count: 2,
      content_characters: evidence.reduce((sum, item) => sum + item.text.length, 0), source_version_id: versionId,
      content_sha256: sha256({ fixture: true }), immutable_source_locator: "hhs-fixture://conversation",
      source_container_sha256: VERIFIED_NATIVE_EXPORT_CONTAINER, capture_version_id: null,
      capture_manifest_sha256: null, capture_locator: null }], evidence,
    model_instructions: { output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
      link_kinds_are_free_text: true, evidence_refs_are_authoritative: true, evidence_excerpts_are_optional: true,
      user_authority_requires_user_evidence: true, database_ids_or_hashes_required: false,
      model_metadata_required: false }
  };
  const output: DiscoveryOutput = {
    schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: exchange.exchange_id,
    observations: [
      { observation_ref: "a", source_conversation_id: "fixture-conversation", observation_kind: "emergent/decision-signal.v7",
        statement: "The user requires source-linked observations.", payload: { theme: "provenance" },
        attribution: { subject: "user", claim_type: "requirement" }, confidence: 0.99,
        evidence: [{ evidence_ref: "fixture-0", excerpt: "require source-linked observations" }] },
      { observation_ref: "b", source_conversation_id: "fixture-conversation", observation_kind: "unforeseen.topic-shape",
        statement: "A topic shape may connect the requirement to provenance.", payload: { unresolved: true },
        attribution: { subject: "assistant", claim_type: "hypothesis" }, confidence: 0.6,
        evidence: [{ evidence_ref: "fixture-1", excerpt: "topic shape may connect" }] }
    ], links: [{ from_observation_ref: "a", to_observation_ref: "b", link_kind: "model-coherence/novel-link", payload: { provisional: true } }]
  };
  return { exchange, output };
}

function row(kind: string, natural: unknown, fields: Record<string, unknown>): Record<string, unknown> {
  const body = { ...fields, idempotency_key: idempotencyKey(kind, WORKSPACE, natural) };
  return { ...body, record_sha256: sha256(body) };
}
