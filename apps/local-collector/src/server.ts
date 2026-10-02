import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type { CaptureBundle } from "@hhs/canonical-schema";
import { compareCaptureVersions } from "@hhs/capture-comparison";
import { createImmutableCaptureVersion, toCaptureReference } from "@hhs/capture-versioning";
import { FileCatalog } from "@hhs/conversation-catalog";
import type { ConversationClassification, InventoryRun } from "@hhs/inventory-schema";
import { validateInventoryIntegrity } from "@hhs/inventory-schema";
import { FileRecaptureWorkflow } from "@hhs/recapture-workflow";
import { FileReviewQueue } from "@hhs/review-queue";
import { approvedArchiveRoot, archiveCapture, archiveComparison, archiveInventory, catalogPathFor, operationalPathFor } from "@hhs/storage";
import {
  safeErrorSummaries, validateAppendEvent, validateCreateOperation,
  type AppendOperationEventInput, type CreateOperationInput, type SafeDiagnosticMetadata
} from "@hhs/capture-operations";
import { sha256 } from "@hhs/memory-schema";
import { operationStoreFromEnvironment } from "./operations.js";
import { archiveFailureMetadata } from "./archive-diagnostics.js";
import { KnowledgePipelineHandoffOutbox } from "./knowledge-pipeline-handoff.js";

const HOST = "127.0.0.1";
const PORT = localPort(process.env.HHS_COLLECTOR_PORT);
const MAX_BODY_BYTES = 75 * 1024 * 1024;
const archiveRoot = approvedArchiveRoot();
const operationStore = operationStoreFromEnvironment(archiveRoot);
const knowledgeHandoffs = new KnowledgePipelineHandoffOutbox({
  archiveRoot,
  ...(process.env.HHS_PIPELINE_HANDOFF_URL ? { endpoint: process.env.HHS_PIPELINE_HANDOFF_URL } : {}),
  ...(process.env.HHS_PIPELINE_HANDOFF_TOKEN ? { serviceToken: process.env.HHS_PIPELINE_HANDOFF_TOKEN } : {}),
  workspaceId: process.env.MEMORY_WORKSPACE_ID || "default",
  requestedPipeline: process.env.MEMORY_PIPELINE_VERSION || "memory-v1",
  maxDeliveryAttempts: positiveInteger(process.env.HHS_PIPELINE_HANDOFF_MAX_ATTEMPTS, 20),
});
const pairCode = randomBytes(4).toString("hex");
const sessionToken = randomBytes(32).toString("hex");
const Ajv2020 = Ajv2020Module.default;
const captureSchema = await loadSchema("../../../packages/canonical-schema/schemas/capture-bundle.schema.json");
const inventorySchema = await loadSchema("../../../packages/inventory-schema/schemas/inventory-run.schema.json");
const validateCapture = new Ajv2020({ allErrors: true, strict: true }).compile(captureSchema);
const validateInventory = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } }).compile(inventorySchema);

const server = createServer(async (request, response) => {
  try {
    applyCors(request, response);
    if (request.method === "OPTIONS") return void response.writeHead(204).end();
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ready", archiveConfigured: true, operationLogging: "capture-operations-v1" });
    if (request.method === "POST" && request.url === "/pair") {
      const body = JSON.parse(await readBody(request)) as PairingOperationRequest;
      const accepted = safeEqual(header(request, "x-hhs-pair-code"), pairCode);
      await recordPairingOperation(body, accepted);
      if (!accepted) return json(response, 403, { error: safeErrorSummaries.pairing_failed });
      return json(response, 200, { token: sessionToken });
    }
    if (request.method === "POST" && request.url === "/operations") {
      requirePairing(request);
      const body = JSON.parse(await readBody(request)) as CreateOperationInput;
      validateCreateOperation(body);
      return json(response, 201, await operationStore.create(body));
    }
    const operationEventMatch = request.url?.match(/^\/operations\/([^/]+)\/events$/);
    if (request.method === "POST" && operationEventMatch) {
      requirePairing(request);
      const body = JSON.parse(await readBody(request)) as AppendOperationEventInput;
      if (decodeURIComponent(operationEventMatch[1]!) !== body.operation_id) return json(response, 400, { error: "Operation URL and event identity do not match." });
      validateAppendEvent(body);
      return json(response, 201, await operationStore.append(body));
    }
    const operationReconcileMatch = request.url?.match(/^\/operations\/([^/]+)\/reconcile$/);
    if (request.method === "POST" && operationReconcileMatch) {
      requirePairing(request);
      const body = JSON.parse(await readBody(request)) as { timeout_seconds?: number };
      return json(response, 200, await operationStore.reconcile(decodeURIComponent(operationReconcileMatch[1]!), body.timeout_seconds ?? 900));
    }
    if (request.method === "GET" && request.url === "/operations/latest") {
      requirePairing(request);
      return json(response, 200, { operation: await operationStore.latest() });
    }
    if (request.method === "GET" && request.url === "/operations") {
      requirePairing(request);
      return json(response, 200, { operations: await operationStore.list(true) });
    }
    const operationReportMatch = request.url?.match(/^\/operations\/([^/]+)$/);
    if (request.method === "GET" && operationReportMatch) {
      requirePairing(request);
      return json(response, 200, { operation: await operationStore.get(decodeURIComponent(operationReportMatch[1]!)) });
    }
    if (request.method === "POST" && request.url === "/captures") {
      if (!safeEqual(bearer(request), sessionToken)) return json(response, 401, { error: "Collector pairing required." });
      const operation = await requireCaptureOperation(request);
      const payload = JSON.parse(await readBody(request)) as CaptureBundle;
      if (!validateCapture(payload)) return json(response, 400, { error: "Capture schema validation failed.", details: validateCapture.errors });
      await operationStore.appendNext(operation.operationId, "collector_delivery_succeeded", "collector", { stage: "collector_delivery_succeeded" });
      let archiveStarted = false;
      try {
        await operationStore.appendNext(operation.operationId, "archive_started", "archive", { stage: "archive_started" });
        archiveStarted = true;
        const archive = await archiveCapture(payload);
        const manifestHash = archive.hashes["capture-manifest.json"];
        if (!manifestHash) throw new Error("Capture archive manifest hash is unavailable.");
        const safeCaptureReference = `capture-${sha256(payload.capture.capture_id).slice(0, 24)}`;
        await operationStore.appendNext(operation.operationId, "archive_completed", "archive", {
          stage: "archive_completed", archive_created: true, safe_capture_reference: safeCaptureReference,
          archive_manifest_sha256: manifestHash, message_count: payload.messages.length
        });
        await operationStore.appendNext(operation.operationId, "verification_completed", "verifier", {
          stage: "verification_completed", verification_status: payload.verification.status
        });
        if (payload.verification.status === "complete") {
          await knowledgeHandoffs.enqueue({
            captureId: payload.capture.capture_id,
            manifestSha256: manifestHash,
            archiveReference: archive.archivePath,
            verificationStatus: payload.verification.status,
          });
          await operationStore.appendNext(operation.operationId, "capture_completed", "collector", { stage: "capture_completed" });
        }
        else if (payload.verification.status === "needs_review" || payload.verification.status === "partial") await operationStore.appendNext(operation.operationId, "capture_needs_review", "collector", { stage: "capture_needs_review", verification_status: "needs_review" });
        else await operationStore.appendNext(operation.operationId, "capture_failed", "collector", {
          safe_error_code: "verification_failed", safe_error_summary: safeErrorSummaries.verification_failed, reason_code: "verification_failed"
        });
        return json(response, 201, { ...archive, safeCaptureReference, operation: await operationStore.get(operation.operationId) });
      } catch (error) {
        await safelyFailOperation(operation.operationId, "archive_failed", archiveFailureMetadata(error, archiveStarted));
        throw error;
      }
    }
    if (request.method === "POST" && request.url === "/inventories") {
      if (!safeEqual(bearer(request), sessionToken)) return json(response, 401, { error: "Collector pairing required." });
      const inventory = JSON.parse(await readBody(request)) as InventoryRun;
      if (!validateInventory(inventory)) return json(response, 400, { error: "Inventory schema validation failed.", details: validateInventory.errors });
      const integrityFailures = validateInventoryIntegrity(inventory);
      if (integrityFailures.length > 0) return json(response, 400, { error: "Inventory hash verification failed.", details: integrityFailures });
      const archive = await archiveInventory(inventory);
      const catalogPath = catalogPathFor(inventory.platform.platform_id, inventory.account.opaque_account_reference);
      const catalog = new FileCatalog(catalogPath);
      await catalog.initialize();
      const update = await catalog.applyInventory(inventory);
      const ordered = [...inventory.observations].sort((a, b) => a.sidebar_position - b.sidebar_position);
      return json(response, 201, {
        inventoryId: inventory.inventory_id,
        verificationStatus: inventory.status,
        observedCount: inventory.observations.length,
        classificationCounts: classificationCounts(update.classifications),
        latestSidebarItem: ordered[0] ? itemSummary(ordered[0]) : null,
        earliestSidebarItem: ordered.at(-1) ? itemSummary(ordered.at(-1)!) : null,
        inventoryPath: archive.inventoryPath,
        evidencePath: archive.evidencePath,
        catalogPath,
        hashesVerified: archive.hashesVerified,
        archiveHashCount: Object.keys(archive.hashes).length,
        evidenceHashCount: inventory.evidence.length,
        boundaryVerification: inventory.boundary_verification,
        warnings: inventory.warnings,
        catalogRevision: update.revision,
        catalogTransactionId: update.transaction_id,
        catalogTransactionApplied: update.applied
      });
    }
    if (request.method === "POST" && request.url === "/recapture/intents") {
      requirePairing(request);
      const selection = JSON.parse(await readBody(request)) as { platform_id?: string; opaque_account_reference?: string; conversation_id?: string };
      if (!selection.platform_id || !selection.opaque_account_reference || !selection.conversation_id) return json(response, 400, { error: "Recapture selection identity is incomplete." });
      const catalog = new FileCatalog(catalogPathFor(selection.platform_id, selection.opaque_account_reference));
      await catalog.initialize();
      const record = Object.values((await catalog.read()).conversations).find((item) => item.platform_id === selection.platform_id && item.opaque_account_reference === selection.opaque_account_reference && item.conversation_id === selection.conversation_id);
      if (!record) return json(response, 404, { error: "Active conversation is not present in the local catalog." });
      const workflow = new FileRecaptureWorkflow(operationalPathFor("recapture", selection.platform_id, selection.opaque_account_reference));
      await workflow.initialize();
      const intent = await workflow.createIntent({ platform_id: record.platform_id, opaque_account_reference: record.opaque_account_reference, conversation_id: record.conversation_id, title: record.title, source_url: record.source_url ?? "" });
      return json(response, 201, { intentId: intent.intent_id, state: intent.state, title: intent.title, conversationId: intent.conversation_id, expiresAt: intent.expires_at });
    }
    const verifyMatch = request.url?.match(/^\/recapture\/intents\/([^/]+)\/verify$/);
    if (request.method === "POST" && verifyMatch) {
      requirePairing(request);
      const active = JSON.parse(await readBody(request)) as { platform_id: string; opaque_account_reference: string; conversation_id: string };
      const workflow = new FileRecaptureWorkflow(operationalPathFor("recapture", active.platform_id, active.opaque_account_reference));
      await workflow.initialize();
      const intent = await workflow.verifyActiveIdentity(verifyMatch[1]!, active);
      return json(response, 200, { intentId: intent.intent_id, state: intent.state, title: intent.title });
    }
    const confirmMatch = request.url?.match(/^\/recapture\/intents\/([^/]+)\/confirm$/);
    if (request.method === "POST" && confirmMatch) {
      requirePairing(request);
      const body = JSON.parse(await readBody(request)) as { platform_id: string; opaque_account_reference: string; confirmed: boolean };
      const workflow = new FileRecaptureWorkflow(operationalPathFor("recapture", body.platform_id, body.opaque_account_reference));
      await workflow.initialize();
      const intent = await workflow.confirm(confirmMatch[1]!, body.confirmed === true);
      return json(response, 200, { intentId: intent.intent_id, state: intent.state });
    }
    const captureMatch = request.url?.match(/^\/recapture\/intents\/([^/]+)\/capture$/);
    if (request.method === "POST" && captureMatch) {
      requirePairing(request);
      const operation = await requireCaptureOperation(request);
      const bundle = JSON.parse(await readBody(request)) as CaptureBundle;
      if (!validateCapture(bundle)) return json(response, 400, { error: "Recapture schema validation failed.", details: validateCapture.errors });
      await operationStore.appendNext(operation.operationId, "collector_delivery_succeeded", "collector", { stage: "collector_delivery_succeeded" });
      let archiveStarted = false;
      try {
      const workflow = new FileRecaptureWorkflow(operationalPathFor("recapture", bundle.platform.id, bundle.account.opaque_account_reference));
      await workflow.initialize();
      await workflow.beginCapture(captureMatch[1]!, { platform_id: bundle.platform.id, opaque_account_reference: bundle.account.opaque_account_reference, conversation_id: bundle.conversation.conversation_id });
      const catalog = new FileCatalog(catalogPathFor(bundle.platform.id, bundle.account.opaque_account_reference));
      await catalog.initialize();
      const before = await catalog.read();
      const record = Object.values(before.conversations).find((item) => item.platform_id === bundle.platform.id && item.opaque_account_reference === bundle.account.opaque_account_reference && item.conversation_id === bundle.conversation.conversation_id);
      if (!record) throw new Error("Recapture conversation disappeared from the catalog before capture finalization.");
      const prior = [...record.capture_versions].filter((item) => item.status === "complete").at(-1);
      await operationStore.appendNext(operation.operationId, "archive_started", "archive", { stage: "archive_started" });
      archiveStarted = true;
      const archive = await archiveCapture(bundle);
      await workflow.checkpoint(captureMatch[1]!, "archive_written", { capture_id: bundle.capture.capture_id });
      const manifestHash = archive.hashes["capture-manifest.json"];
      if (!manifestHash) throw new Error("New immutable capture manifest hash is unavailable.");
      const version = createImmutableCaptureVersion(bundle, archive.archivePath, manifestHash);
      await workflow.checkpoint(captureMatch[1]!, "archive_verified", { capture_id: bundle.capture.capture_id });
      await workflow.checkpoint(captureMatch[1]!, "comparing", { capture_id: bundle.capture.capture_id });
      let comparisonReceipt: Record<string, unknown> | undefined;
      if (prior) {
        assertPrivateArchivePath(prior.archive_path);
        const priorBundle = JSON.parse(await readFile(path.join(prior.archive_path, "normalized", "conversation.json"), "utf8")) as CaptureBundle;
        const comparison = compareCaptureVersions(priorBundle, bundle, prior.manifest_sha256, manifestHash);
        const stored = await archiveComparison(comparison, bundle.platform.id, bundle.account.opaque_account_reference, bundle.conversation.conversation_id);
        const queue = new FileReviewQueue(operationalPathFor("review", bundle.platform.id, bundle.account.opaque_account_reference));
        await queue.initialize();
        const reviews = await queue.enqueueComparison(comparison, { platform_id: bundle.platform.id, opaque_account_reference: bundle.account.opaque_account_reference, conversation_id: bundle.conversation.conversation_id, created_at: bundle.capture.completed_at });
        comparisonReceipt = { comparisonId: comparison.comparison_id, status: comparison.status, path: stored.comparisonPath, reviewItems: reviews.length, changeCounts: comparison.change_counts };
      }
      const reconciliation = await catalog.reconcileCaptureReferences({ reconciliation_id: `recapture-${bundle.capture.capture_id}`, platform_id: bundle.platform.id, opaque_account_reference: bundle.account.opaque_account_reference, created_at: bundle.capture.completed_at, capture_references: [toCaptureReference(version)] });
      await workflow.checkpoint(captureMatch[1]!, "catalog_committed", { capture_id: bundle.capture.capture_id, ...(comparisonReceipt?.comparisonId ? { comparison_id: String(comparisonReceipt.comparisonId) } : {}) });
      const needsReview = bundle.verification.status !== "complete" || comparisonReceipt?.status === "needs_review";
      const finalIntent = await workflow.checkpoint(captureMatch[1]!, needsReview ? "needs_review" : "complete", { capture_id: bundle.capture.capture_id, ...(comparisonReceipt?.comparisonId ? { comparison_id: String(comparisonReceipt.comparisonId) } : {}) });
      const safeCaptureReference = `capture-${sha256(bundle.capture.capture_id).slice(0, 24)}`;
      await operationStore.appendNext(operation.operationId, "archive_completed", "archive", {
        stage: "archive_completed", archive_created: true, safe_capture_reference: safeCaptureReference,
        archive_manifest_sha256: manifestHash, message_count: bundle.messages.length
      });
      await operationStore.appendNext(operation.operationId, "verification_completed", "verifier", {
        stage: "verification_completed", verification_status: needsReview ? "needs_review" : "complete"
      });
      if (!needsReview) {
        await knowledgeHandoffs.enqueue({
          captureId: bundle.capture.capture_id,
          manifestSha256: manifestHash,
          archiveReference: archive.archivePath,
          verificationStatus: "complete",
        });
      }
      await operationStore.appendNext(operation.operationId, needsReview ? "capture_needs_review" : "capture_completed", "collector", {
        stage: needsReview ? "capture_needs_review" : "capture_completed",
        verification_status: needsReview ? "needs_review" : "complete"
      });
      return json(response, 201, { state: finalIntent.state, archive, safeCaptureReference, comparison: comparisonReceipt ?? null, reconciliation, operation: await operationStore.get(operation.operationId) });
      } catch (error) {
        await safelyFailOperation(operation.operationId, "archive_failed", archiveFailureMetadata(error, archiveStarted));
        throw error;
      }
    }
    return json(response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown collector error.";
    return json(response, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HHS collector listening on http://${HOST}:${PORT}`);
  if (process.env.HHS_SAFE_BACKGROUND === "1") {
    void persistPrivatePairingCode(pairCode);
  } else {
    console.log(`Archive root: ${archiveRoot}`);
    console.log(`One-time pairing code: ${pairCode}`);
  }
  void knowledgeHandoffs.flush().catch((error) => console.error("Knowledge handoff flush failed:", error));
});

const handoffRetryInterval = setInterval(
  () => void knowledgeHandoffs.flush().catch((error) => console.error("Knowledge handoff retry failed:", error)),
  60_000
);
handoffRetryInterval.unref();

async function persistPrivatePairingCode(code: string): Promise<void> {
  const runtime = path.resolve(process.cwd(), ".runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "collector-pairing-code.private"), `${code}\n`, { encoding: "utf8", mode: 0o600 });
}

async function loadSchema(relative: string): Promise<object> {
  const schemaPath = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(await readFile(schemaPath, "utf8")) as object;
}

function classificationCounts(classifications: Record<string, ConversationClassification>): Record<ConversationClassification, number> {
  const counts: Record<ConversationClassification, number> = { new: 0, possibly_changed: 0, unchanged: 0, missing: 0, needs_review: 0 };
  for (const classification of Object.values(classifications)) counts[classification] += 1;
  return counts;
}

function itemSummary(item: InventoryRun["observations"][number]) {
  return { conversationId: item.conversation_id, title: item.title, sourceUrl: item.source_url ?? null, accessibleTimestamp: item.platform_metadata.accessible_timestamp ?? null, sidebarPosition: item.sidebar_position };
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = header(request, "origin");
  if (origin.startsWith("chrome-extension://")) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-hhs-pair-code, x-hhs-operation-id, x-hhs-correlation-id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Local payload exceeds the collector size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bearer(request: IncomingMessage): string {
  const value = header(request, "authorization");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requirePairing(request: IncomingMessage): void {
  if (!safeEqual(bearer(request), sessionToken)) throw new Error("Collector pairing required.");
}

type PairingOperationRequest = {
  operation_id: string;
  correlation_id: string;
  platform: string;
  opaque_account_reference: string;
  source_component: "extension_popup";
};

async function recordPairingOperation(body: PairingOperationRequest, accepted: boolean): Promise<void> {
  const input: CreateOperationInput = {
    operation_id: body.operation_id,
    correlation_id: body.correlation_id,
    platform: body.platform,
    opaque_account_reference: body.opaque_account_reference,
    operation_type: "pairing",
    source_component: "extension_popup"
  };
  validateCreateOperation(input);
  await operationStore.create(input);
  await operationStore.appendNext(input.operation_id, "pairing_requested", "extension_popup", { stage: "pairing_requested" });
  await operationStore.appendNext(input.operation_id, accepted ? "pairing_succeeded" : "pairing_failed", "collector",
    accepted ? { stage: "pairing_succeeded" } : { safe_error_code: "pairing_failed", safe_error_summary: safeErrorSummaries.pairing_failed, reason_code: "pairing_failed" });
}

async function requireCaptureOperation(request: IncomingMessage): Promise<{ operationId: string; correlationId: string }> {
  const operationId = header(request, "x-hhs-operation-id");
  const correlationId = header(request, "x-hhs-correlation-id");
  if (!operationId || !correlationId) throw new Error("Capture operation identity headers are required.");
  const report = await operationStore.get(operationId);
  if (report.correlation_id !== correlationId) throw new Error("Capture operation correlation identity mismatch.");
  return { operationId, correlationId };
}

async function safelyFailOperation(operationId: string, code: "archive_failed" | "internal_error", diagnostics: SafeDiagnosticMetadata = {}): Promise<void> {
  try {
    await operationStore.appendNext(operationId, "capture_failed", "collector", {
      safe_error_code: code, safe_error_summary: safeErrorSummaries[code], reason_code: code, ...diagnostics
    });
  } catch {
    // The authoritative state may already be terminal; never overwrite it while handling another failure.
  }
}

function assertPrivateArchivePath(candidate: string): void {
  const relative = path.relative(archiveRoot, path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Catalog capture reference escapes the approved private archive.");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

function localPort(value: string | undefined): number {
  if (value === undefined) return 43_117;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("HHS_COLLECTOR_PORT must be a valid unprivileged local port.");
  return port;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("HHS_PIPELINE_HANDOFF_MAX_ATTEMPTS must be a positive integer.");
  return parsed;
}
