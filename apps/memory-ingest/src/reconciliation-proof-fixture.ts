import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { immutableInsert } from "./db.js";
import { immutableRow } from "./review.js";

const OBSERVATION_PIPELINE = "memory-understanding-discovery/0.2.0";

/** A real native-source message range for legacy approval regression proofs. */
export async function seedLegacyReviewFixture(client: import("./db.js").DbClient, workspaceId: string, observationId: string) {
  const original = (await client.query("select * from memory_v1.provenance_edges where workspace_id=$1 and target_record_id=$2 limit 1", [workspaceId, observationId])).rows[0];
  const source = (await client.query("select ingestion_run_id from memory_v1.source_records where workspace_id=$1 and source_record_id=$2", [workspaceId, original.source_record_id])).rows[0];
  const pipeline = "fixture-source/0.1.0";
  const chunkId = deterministicId("chunk", workspaceId, ["legacy-user-range"]);
  await immutableInsert(client, "message_range_chunks", "chunk_id", immutableRow("chunk",workspaceId,["legacy-user-range"], {
    workspace_id: workspaceId, chunk_id: chunkId, ingestion_run_id: source.ingestion_run_id, pipeline_version: pipeline,
    capture_version_id: null, source_version_id: original.source_version_id, start_sequence: 0, end_sequence: 0,
    message_ids: [original.message_id], chunk_sha256: original.representation_sha256
  }));
  const candidateId = deterministicId("knowledge_candidate",workspaceId,["legacy-review"]);
  const value = { statement: "The user decided HHS Core 2 will be the business OS." };
  await immutableInsert(client,"knowledge_candidates","knowledge_candidate_id",immutableRow("knowledge_candidate",workspaceId,["legacy-review"], {
    workspace_id: workspaceId, knowledge_candidate_id: candidateId, pipeline_version: pipeline, chunk_id: chunkId,
    promotion_receipt_id: null, kind: "decision", status: "proposed", proposed_value: value, proposed_value_sha256: sha256(value), created_at: "2026-10-05T00:00:00.000Z"
  }));
  const fields = { ...original };
  delete fields.record_sha256; delete fields.idempotency_key;
  fields.created_at = fields.created_at.toISOString();
  const edgeId = deterministicId("provenance_edge",workspaceId,["legacy-review"]);
  await immutableInsert(client,"provenance_edges","provenance_edge_id",immutableRow("provenance_edge",workspaceId,["legacy-review"], {
    ...fields, provenance_edge_id: edgeId, pipeline_version: pipeline, target_record_type: "knowledge_candidate", target_record_id: candidateId
  }));
  await immutableInsert(client,"candidate_evidence","candidate_evidence_id",immutableRow("candidate_evidence",workspaceId,["legacy-review"], {
    workspace_id: workspaceId, candidate_evidence_id: deterministicId("candidate_evidence",workspaceId,["legacy-review"]),
    knowledge_candidate_id: candidateId, pipeline_version: pipeline, provenance_edge_id: edgeId, role: "supporting"
  }));
  return candidateId;
}

export async function seedReconciliationFixture(
  client: import("./db.js").DbClient,
  workspaceId: string,
  userStatement = "The user decided HHS Core 2 will be the business OS.",
  userEvidenceText = userStatement
): Promise<{
  userObservationId: string;
  assistantObservationId: string;
}> {
  const workspaceRow = immutableRow("workspace", workspaceId, ["fixture"], {
    workspace_id: workspaceId,
    name: "Reconciliation rollback fixture",
    isolation_key: workspaceId,
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
    workspaceId,
    ["user-message"]
  );

  const assistantMessageId = deterministicId(
    "message",
    workspaceId,
    ["assistant-message"]
  );

  const userObservationId = deterministicId(
    "observation",
    workspaceId,
    ["user-observation"]
  );

  const assistantObservationId = deterministicId(
    "observation",
    workspaceId,
    ["assistant-observation"]
  );

  await seedObservationChain(
    client,
    userMessageId,
    userObservationId,
    "user",
    "decision",
    userStatement,
    workspaceId,
    userEvidenceText
  );

  await seedObservationChain(
    client,
    assistantMessageId,
    assistantObservationId,
    "assistant",
    "architecture",
    "GoHighLevel could serve as the central CRM.",
    workspaceId
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
  statement: string,
  workspaceId: string,
  evidenceText = statement
): Promise<void> {
  const conversationId = deterministicId(
    "conversation",
    workspaceId,
    ["fixture-conversation"]
  );

  const sourceSystemId = deterministicId(
    "source_system",
    workspaceId,
    ["fixture-system"]
  );

  const sourceAccountId = deterministicId(
    "source_account",
    workspaceId,
    ["fixture-account"]
  );

  const ingestionRunId = deterministicId(
    "ingestion_run",
    workspaceId,
    ["fixture-run"]
  );

  const sourceVersionId = deterministicId(
    "source_version",
    workspaceId,
    ["fixture-version"]
  );

  const conversationRecordId = deterministicId(
    "source_record",
    workspaceId,
    ["fixture-conversation-record"]
  );

  const messageRecordId = deterministicId(
    "source_record",
    workspaceId,
    [messageId]
  );

  const blockId = deterministicId(
    "content_block",
    workspaceId,
    [messageId]
  );

  const textHash = sha256(evidenceText);

  await immutableInsert(
    client,
    "source_systems",
    "source_system_id",
    immutableRow("source_system", workspaceId, ["fixture-system"], {
      workspace_id: workspaceId,
      source_system_id: sourceSystemId,
      kind: "fixture",
      adapter_contract: "fixture/0.1.0"
    })
  );

  await immutableInsert(
    client,
    "source_accounts",
    "source_account_id",
    immutableRow("source_account", workspaceId, ["fixture-account"], {
      workspace_id: workspaceId,
      source_account_id: sourceAccountId,
      source_system_id: sourceSystemId,
      opaque_account_reference: "fixture"
    })
  );

  const existingRun = await client.query(
    `select 1 from memory_v1.ingestion_runs
     where workspace_id=$1 and ingestion_run_id=$2`,
    [workspaceId, ingestionRunId]
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
        workspaceId,
        ingestionRunId,
        sourceSystemId,
        sourceAccountId,
        idempotencyKey("ingestion_run", workspaceId, ["fixture-run"]),
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
    immutableRow("source_record", workspaceId, ["fixture-conversation-record"], {
      workspace_id: workspaceId,
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
    immutableRow("conversation", workspaceId, ["fixture-conversation"], {
      workspace_id: workspaceId,
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
    immutableRow("source_version", workspaceId, ["fixture-version"], {
      workspace_id: workspaceId,
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
      source_metadata: { fixture: true, private_account_id: "must-stay-at-source" },
      capture_version_id: null,
      created_at: "2026-10-05T00:00:00.000Z"
    })
  );

  await immutableInsert(
    client,
    "source_records",
    "source_record_id",
    immutableRow("source_record", workspaceId, [messageId], {
      workspace_id: workspaceId,
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
    immutableRow("message", workspaceId, [messageId], {
      workspace_id: workspaceId,
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
    immutableRow("content_block", workspaceId, [messageId], {
      workspace_id: workspaceId,
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
          value: evidenceText,
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
    immutableRow("observation", workspaceId, [observationId], {
      workspace_id: workspaceId,
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
    immutableRow("provenance_edge", workspaceId, [observationId, messageId], {
      workspace_id: workspaceId,
      provenance_edge_id: deterministicId(
        "provenance_edge",
        workspaceId,
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
