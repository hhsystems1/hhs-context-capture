import path from "node:path";
import { loadApprovedArchive } from "../../memory-ingest/src/archive.js";
import { ingestApprovedCapture } from "../../memory-ingest/src/ingest.js";
import { prepareDiscoveryExchange } from "../../memory-ingest/src/understanding-discovery.js";
import { registerCapturePriority } from "../../memory-ingest/src/capture-priority.js";
import { knowledgeHandoffIdempotencyKey, type VerifiedCaptureHandoff } from "./knowledge-pipeline-handoff.js";

export function localCaptureDelivery(config: { archiveRoot: string; workspaceId: string; pipelineVersion: string; priorityFile: string }) {
  return async (record: VerifiedCaptureHandoff) => {
    if (record.workspace_id !== config.workspaceId || record.requested_pipeline !== config.pipelineVersion || record.verification_status !== "complete" || record.idempotency_key !== knowledgeHandoffIdempotencyKey(record)) throw new Error("Capture handoff scope mismatch.");
    const options = { archiveRoot: config.archiveRoot, capturePath: path.resolve(record.archive_reference), captureId: record.capture_id,
      workspaceId: config.workspaceId, pipelineVersion: config.pipelineVersion };
    const archive = await loadApprovedArchive(options);
    if (archive.manifestSha256 !== record.manifest_sha256 || archive.normalized.platform.id !== "chatgpt") throw new Error("Capture handoff evidence mismatch.");
    const result = await ingestApprovedCapture(options);
    const conversation = archive.normalized.conversation.conversation_id;
    const exchange = await prepareDiscoveryExchange(config.workspaceId, [conversation]);
    await registerCapturePriority(config.priorityFile, config.workspaceId, exchange);
    return { handoff_id: record.idempotency_key, ingest_job_id: result.ingestionRunId,
      source_version_id: exchange.selection[0]!.source_version_id, source_conversation_id: conversation };
  };
}
