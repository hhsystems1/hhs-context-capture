import { afterAll, describe, expect, it } from "vitest";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert } from "./db.js";
import {
  RECONCILIATION_PIPELINE_VERSION,
  prepareReconciliationInputFromClient,
  persistValidatedReconciliation,
  validateReconciliationOutput,
  type ReconciliationOutput
} from "./reconciliation.js";

const enabled =
  process.env.HHS_RUN_RECONCILIATION_DB_PROOF === "1" &&
  Boolean(process.env.MEMORY_DATABASE_URL);

const suite = enabled ? describe : describe.skip;

const WORKSPACE = "reconciliation-layer-rollback-proof";
const OBSERVATION_PIPELINE = "memory-understanding-discovery/0.2.0";
const pool = enabled ? createPool("admin") : undefined;

afterAll(async () => {
  await pool?.end();
});

suite("database-backed reconciliation layer", () => {
  it("reloads observation authority from exact provenance instead of trusting payload", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );
      await client.query("set constraints all deferred");

      const fixture = await seedFixture(client);

      const input = await prepareReconciliationInputFromClient(
        client,
        WORKSPACE,
        [fixture.userObservationId, fixture.assistantObservationId]
      );

      expect(input.observations).toHaveLength(2);

      const user = input.observations.find(
        (item) => item.observation_id === fixture.userObservationId
      )!;

      const assistant = input.observations.find(
        (item) => item.observation_id === fixture.assistantObservationId
      )!;

      expect(user.evidence_roles).toEqual(["user"]);
      expect(assistant.evidence_roles).toEqual(["assistant"]);

      await client.query("rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("rejects unknown observations before reconciliation output is accepted", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );

      await expect(
        prepareReconciliationInputFromClient(
          client,
          WORKSPACE,
          ["observation_does_not_exist"]
        )
      ).rejects.toThrow(/unknown observation/i);

      await client.query("rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("persists reconciliation and observation lineage idempotently, then rolls back", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );
      await client.query("set constraints all deferred");

      const fixture = await seedFixture(client);

      const input = await prepareReconciliationInputFromClient(
        client,
        WORKSPACE,
        [fixture.userObservationId, fixture.assistantObservationId]
      );

      const output: ReconciliationOutput = {
        schema_version: "hhs-reconciliation-output/0.1.0",
        source_workspace_id: WORKSPACE,
        reconciliations: [
          {
            reconciliation_ref: "current-business-os",
            kind: "decision",
            statement: "HHS Core 2 is the current business OS.",
            authority: "user",
            temporal_status: "current",
            destination: {
              brain_type: "organization",
              target_ref: "HHS"
            },
            observations: [
              {
                observation_id: fixture.userObservationId,
                relation: "supports"
              },
              {
                observation_id: fixture.assistantObservationId,
                relation: "supersedes"
              }
            ]
          }
        ]
      };

      const validated = validateReconciliationOutput(input, output);

      expect(validated.issues).toEqual([]);
      expect(validated.valid).toBeDefined();

      const first = await persistValidatedReconciliation(
        client,
        WORKSPACE,
        validated.valid!
      );

      const replay = await persistValidatedReconciliation(
        client,
        WORKSPACE,
        validated.valid!
      );

      expect(first).toMatchObject({
        reconciliations_inserted: 1,
        reconciliation_observations_inserted: 2,
        replay: false
      });

      expect(replay).toMatchObject({
        reconciliations_inserted: 0,
        reconciliation_observations_inserted: 0,
        replay: true
      });

      const rows = await client.query(
        `select r.kind, r.payload,
                count(ro.reconciliation_observation_id)::int as observation_count
         from memory_v1.reconciliations r
         join memory_v1.reconciliation_observations ro
           on (ro.workspace_id,ro.reconciliation_id,ro.pipeline_version) =
              (r.workspace_id,r.reconciliation_id,r.pipeline_version)
         where r.workspace_id=$1
         group by r.kind,r.payload`,
        [WORKSPACE]
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].kind).toBe("decision");
      expect(rows.rows[0].observation_count).toBe(2);
      expect(rows.rows[0].payload.statement).toBe(
        "HHS Core 2 is the current business OS."
      );

      await client.query("rollback");

      const after = await pool!.query(
        "select count(*)::int n from memory_v1.reconciliations where workspace_id=$1",
        [WORKSPACE]
      );

      expect(after.rows[0].n).toBe(0);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
});

async function seedFixture(
  client: import("./db.js").DbClient
): Promise<{
  userObservationId: string;
  assistantObservationId: string;
}> {
  const workspaceRow = immutableRow("workspace", WORKSPACE, ["fixture"], {
    workspace_id: WORKSPACE,
    name: "Reconciliation rollback fixture",
    isolation_key: WORKSPACE,
    status: "active",
    created_at: "2026-10-05T00:00:00.000Z"
  });

  await immutableInsert(
    client,
    "workspaces",
    "workspace_id",
    workspaceRow
  );

  const userMessageId = deterministicId(
    "message",
    WORKSPACE,
    ["user-message"]
  );

  const assistantMessageId = deterministicId(
    "message",
    WORKSPACE,
    ["assistant-message"]
  );

  const userObservationId = deterministicId(
    "observation",
    WORKSPACE,
    ["user-observation"]
  );

  const assistantObservationId = deterministicId(
    "observation",
    WORKSPACE,
    ["assistant-observation"]
  );

  await seedObservationChain(
    client,
    userMessageId,
    userObservationId,
    "user",
    "decision",
    "The user decided HHS Core 2 will be the business OS."
  );

  await seedObservationChain(
    client,
    assistantMessageId,
    assistantObservationId,
    "assistant",
    "architecture",
    "GoHighLevel could serve as the central CRM."
  );

  return {
    userObservationId,
    assistantObservationId
  };
}

async function seedObservationChain(
  client: import("./db.js").DbClient,
  messageId: string,
  observationId: string,
  role: "user" | "assistant",
  observationKind: string,
  statement: string
): Promise<void> {
  const conversationId = deterministicId(
    "conversation",
    WORKSPACE,
    ["fixture-conversation"]
  );

  const sourceSystemId = deterministicId(
    "source_system",
    WORKSPACE,
    ["fixture-system"]
  );

  const sourceAccountId = deterministicId(
    "source_account",
    WORKSPACE,
    ["fixture-account"]
  );

  const ingestionRunId = deterministicId(
    "ingestion_run",
    WORKSPACE,
    ["fixture-run"]
  );

  const sourceVersionId = deterministicId(
    "source_version",
    WORKSPACE,
    ["fixture-version"]
  );

  const conversationRecordId = deterministicId(
    "source_record",
    WORKSPACE,
    ["fixture-conversation-record"]
  );

  const messageRecordId = deterministicId(
    "source_record",
    WORKSPACE,
    [messageId]
  );

  const blockId = deterministicId(
    "content_block",
    WORKSPACE,
    [messageId]
  );

  const textHash = sha256(statement);

  await immutableInsert(
    client,
    "source_systems",
    "source_system_id",
    immutableRow("source_system", WORKSPACE, ["fixture-system"], {
      workspace_id: WORKSPACE,
      source_system_id: sourceSystemId,
      kind: "fixture",
      adapter_contract: "fixture/0.1.0"
    })
  );

  await immutableInsert(
    client,
    "source_accounts",
    "source_account_id",
    immutableRow("source_account", WORKSPACE, ["fixture-account"], {
      workspace_id: WORKSPACE,
      source_account_id: sourceAccountId,
      source_system_id: sourceSystemId,
      opaque_account_reference: "fixture"
    })
  );

  const existingRun = await client.query(
    `select 1 from memory_v1.ingestion_runs
     where workspace_id=$1 and ingestion_run_id=$2`,
    [WORKSPACE, ingestionRunId]
  );

  if (!existingRun.rowCount) {
    await client.query(
      `insert into memory_v1.ingestion_runs
       (workspace_id,ingestion_run_id,source_system_id,source_account_id,
        idempotency_key,status,started_at,input_manifest_sha256,
        checkpoint_key,attempt_count,pipeline_version,
        expected_message_count,expected_content_block_count,expected_chunk_count)
       values ($1,$2,$3,$4,$5,'running',$6,$7,'fixture',1,$8,2,2,0)`,
      [
        WORKSPACE,
        ingestionRunId,
        sourceSystemId,
        sourceAccountId,
        idempotencyKey("ingestion_run", WORKSPACE, ["fixture-run"]),
        "2026-10-05T00:00:00.000Z",
        "c".repeat(64),
        "fixture-source/0.1.0"
      ]
    );
  }

  await immutableInsert(
    client,
    "source_records",
    "source_record_id",
    immutableRow("source_record", WORKSPACE, ["fixture-conversation-record"], {
      workspace_id: WORKSPACE,
      source_record_id: conversationRecordId,
      ingestion_run_id: ingestionRunId,
      source_system_id: sourceSystemId,
      source_account_id: sourceAccountId,
      source_native_id: "fixture-conversation",
      record_kind: "conversation",
      immutable_evidence_locator: "hhs-fixture://conversation",
      source_sha256: sha256("fixture-conversation"),
      observed_at: "2026-10-05T00:00:00.000Z"
    })
  );

  await immutableInsert(
    client,
    "conversations",
    "conversation_id",
    immutableRow("conversation", WORKSPACE, ["fixture-conversation"], {
      workspace_id: WORKSPACE,
      conversation_id: conversationId,
      source_record_id: conversationRecordId,
      capture_version_id: null,
      source_version_id: null,
      source_conversation_id: "fixture-conversation",
      title_representation: {
        representation_kind: "canonical_text",
        value: "Fixture",
        sha256: sha256("Fixture"),
        evidence_locator: "hhs-fixture://title"
      }
    })
  );

  await immutableInsert(
    client,
    "source_versions",
    "source_version_id",
    immutableRow("source_version", WORKSPACE, ["fixture-version"], {
      workspace_id: WORKSPACE,
      source_version_id: sourceVersionId,
      pipeline_version: "fixture-source/0.1.0",
      source_record_id: conversationRecordId,
      conversation_id: conversationId,
      source_family: "native_export",
      content_sha256: sha256({ fixture: true }),
      immutable_source_locator: "hhs-fixture://conversation",
      source_container_sha256: "c".repeat(64),
      verification_status: "complete",
      source_observed_at: "2026-10-05T00:00:00.000Z",
      source_metadata: { fixture: true },
      capture_version_id: null,
      created_at: "2026-10-05T00:00:00.000Z"
    })
  );

  await immutableInsert(
    client,
    "source_records",
    "source_record_id",
    immutableRow("source_record", WORKSPACE, [messageId], {
      workspace_id: WORKSPACE,
      source_record_id: messageRecordId,
      ingestion_run_id: ingestionRunId,
      source_system_id: sourceSystemId,
      source_account_id: sourceAccountId,
      source_native_id: messageId,
      record_kind: "message",
      immutable_evidence_locator: `hhs-fixture://${messageId}`,
      source_sha256: textHash,
      observed_at: "2026-10-05T00:00:00.000Z"
    })
  );

  await immutableInsert(
    client,
    "messages",
    "message_id",
    immutableRow("message", WORKSPACE, [messageId], {
      workspace_id: WORKSPACE,
      message_id: messageId,
      source_record_id: messageRecordId,
      conversation_id: conversationId,
      capture_version_id: null,
      source_version_id: sourceVersionId,
      source_message_id: messageId,
      sequence: role === "user" ? 0 : 1,
      role,
      parent_message_id: null,
      active_path: true,
      representations: []
    })
  );

  await immutableInsert(
    client,
    "content_blocks",
    "content_block_id",
    immutableRow("content_block", WORKSPACE, [messageId], {
      workspace_id: WORKSPACE,
      content_block_id: blockId,
      source_record_id: messageRecordId,
      message_id: messageId,
      capture_version_id: null,
      source_version_id: sourceVersionId,
      sequence: 0,
      block_kind: "text",
      representations: [
        {
          representation_kind: "canonical_text",
          value: statement,
          sha256: textHash,
          evidence_locator: `hhs-fixture://${messageId}`
        }
      ]
    })
  );

  const observationPayload = {
    statement,
    attribution: {
      subject: role,
      claim_type: role === "user" ? "decision" : "proposal"
    },
    confidence: 0.99
  };

  await immutableInsert(
    client,
    "observations",
    "observation_id",
    immutableRow("observation", WORKSPACE, [observationId], {
      workspace_id: WORKSPACE,
      observation_id: observationId,
      pipeline_version: OBSERVATION_PIPELINE,
      observation_kind: observationKind,
      payload: observationPayload,
      payload_sha256: sha256(observationPayload),
      status: "proposed",
      chunk_id: null,
      conversation_id: conversationId,
      created_at: "2026-10-05T00:00:00.000Z"
    })
  );

  await immutableInsert(
    client,
    "provenance_edges",
    "provenance_edge_id",
    immutableRow("provenance_edge", WORKSPACE, [observationId, messageId], {
      workspace_id: WORKSPACE,
      provenance_edge_id: deterministicId(
        "provenance_edge",
        WORKSPACE,
        [observationId, messageId]
      ),
      pipeline_version: OBSERVATION_PIPELINE,
      target_record_type: "observation",
      target_record_id: observationId,
      relation: "quotes",
      source_record_id: messageRecordId,
      source_version_id: sourceVersionId,
      capture_version_id: null,
      conversation_id: conversationId,
      message_id: messageId,
      content_block_id: blockId,
      representation_kind: "canonical_text",
      representation_sha256: textHash,
      created_at: "2026-10-05T00:00:00.000Z"
    })
  );
}

function immutableRow(
  kind: string,
  workspaceId: string,
  natural: unknown,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const body = {
    ...fields,
    idempotency_key: idempotencyKey(kind, workspaceId, natural)
  };

  return {
    ...body,
    record_sha256: sha256(body)
  };
}
