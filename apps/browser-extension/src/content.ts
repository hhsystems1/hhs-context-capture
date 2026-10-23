import {inspectCaptureRuntime,sameCaptureRuntime,type CaptureRuntime} from './capture-runtime.js';
import { captureDiagnosticError, captureFailure, captureStep, safeCaptureFailure } from "@hhs/capture-operations";
import { resolveDiscoveryAdapter } from "./discovery/registry.js";
import { ChatGptDomSidebarPort, ChatGptSidebarInventoryAdapter, hashInventoryEvidence } from "@hhs/adapter-chatgpt/inventory";
import { SCHEMA_VERSION, type CaptureBundle, type EvidenceRecord } from "@hhs/canonical-schema";
import { verifyCapture } from "@hhs/capture-engine";
import type { InventoryRun } from "@hhs/inventory-schema";
import { runSiteDiscovery, type SiteDiscoveryResult } from "./discovery/run.js";
import type { ComparisonRequestPayload, ComparisonResponsePayload } from "./discovery/compare.js";

const contentScope = globalThis as typeof globalThis & { __hhsContextCaptureRegistered?: boolean };
if (!contentScope.__hhsContextCaptureRegistered) {
  contentScope.__hhsContextCaptureRegistered = true;
  const runtimeInstanceId = crypto.randomUUID();
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message==='object'&&message!==null&&(message as {type?:string}).type==='HHS_INSPECT_CAPTURE_RUNTIME') {
      try { sendResponse({ok:true,runtime:inspectCaptureRuntime(location.hostname,runtimeInstanceId)}); }
      catch { sendResponse({ok:false,error:'capture_runtime_unavailable'}); }
      return false;
    }
    if (!isCaptureRequest(message) && !isInventoryRequest(message) && !isPrepareRecaptureRequest(message) && !isConfirmedRecaptureRequest(message) && !isObserveIdentityRequest(message) && !isDiscoverSiteRequest(message)) return false;
    if (isCaptureRequest(message)||isConfirmedRecaptureRequest(message)) {
      let matches=false;
      try { matches=sameCaptureRuntime((message as {expectedRuntime?:unknown}).expectedRuntime,inspectCaptureRuntime(location.hostname,runtimeInstanceId)); } catch { /* Invalidated/unsupported runtime fails closed. */ }
      if(!matches){const diagnostic=safeCaptureFailure(captureFailure('extension_channel','runtime_version_mismatch'),'extension_channel');sendResponse({ok:false,error:diagnostic.safe_error_summary,diagnostic});return false;}
    }
    const reportProgress = (progress: string) => chrome.runtime.sendMessage({ type: "HHS_CAPTURE_PROGRESS", progress }).catch(() => undefined);
    if (isDiscoverSiteRequest(message)) {
      discoverSite(reportProgress).then(
        (discovery) => sendResponse({ ok: true, discovery }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (isObserveIdentityRequest(message)) {
      observedCaptureIdentity().then(
        (identity) => sendResponse({ ok: true, identity }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      );
      return true;
    }
    if (isInventoryRequest(message)) {
      inventorySidebar(reportProgress).then(async (inventory) => {
        reportProgress(`Streaming ${inventory.observations.length} sidebar observations to the local collector...`);
        return { inventory: await streamJsonToBackground<InventoryReceipt>(inventory, "HHS_INVENTORY_STREAM", reportProgress) };
      }).then(
        (result) => sendResponse({ ok: true, ...result }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (isPrepareRecaptureRequest(message)) {
      prepareRecapture().then(
        (result) => sendResponse({ ok: true, ...result }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (isConfirmedRecaptureRequest(message)) {
      runConfirmedRecapture(message.intentId, message.operation, reportProgress, inspectCaptureRuntime(location.hostname,runtimeInstanceId)).then(
        (result) => sendResponse({ ok: true, recapture: result }),
        (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    const operation = message.operation;
    emitOperationEvent(operation, "capture_started", "extension_content", { stage: "capture_started" }).then(() =>
      captureConversation(reportProgress, inspectCaptureRuntime(location.hostname,runtimeInstanceId))).then(async (bundle) => {
      const observedConversation = `conversation-${(await sha256Text(bundle.conversation.conversation_id)).slice(0, 24)}`;
      if (observedConversation !== operation.expectedConversationReference) {
        await emitOperationEvent({ ...operation, eventSequence: operation.eventSequence + 1 }, "identity_mismatch", "extension_content", {
          safe_error_code: "identity_mismatch",
          safe_error_summary: "The active conversation identity changed or did not match.",
          reason_code: "identity_mismatch"
        });
        throw captureFailure("identity_read","identity_mismatch");
      }
      await emitOperationEvent({ ...operation, eventSequence: operation.eventSequence + 1 }, "capture_progress", "extension_content", {
        stage: "extraction_completed", message_count: bundle.messages.length
      });
      reportProgress(`Streaming ${bundle.messages.length} messages to the local collector...`);
      const archive = await streamJsonToBackground<{ archivePath: string; messageCount: number }>(
        bundle, "HHS_ARCHIVE_STREAM", reportProgress,
        { ...operation, eventSequence: operation.eventSequence + 2 }
      );
      return { archive, captureStatus: bundle.verification.status, messageCount: bundle.messages.length };
    }).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error: unknown) => { const diagnostic=safeCaptureFailure(error,"page_extraction"); sendResponse({ok:false,error:diagnostic.safe_error_summary,diagnostic}); },
    );
    return true;
  });
}

type StreamPortName = "HHS_ARCHIVE_STREAM" | "HHS_INVENTORY_STREAM" | `HHS_RECAPTURE_STREAM:${string}`;
type OperationContext = { operationId: string; correlationId: string; eventSequence: number; expectedConversationReference: string };
type ClassificationCounts = Record<"new" | "possibly_changed" | "unchanged" | "missing" | "needs_review", number>;
type InventoryReceipt = { verificationStatus: string; observedCount: number; classificationCounts: ClassificationCounts; inventoryPath: string; catalogPath: string };

async function streamJsonToBackground<T>(value: unknown, portName: StreamPortName, onProgress: (message: string) => void, operation?: OperationContext): Promise<T> {
  const serialized = JSON.stringify(value);
  const chunkSize = 256 * 1024;
  const totalChunks = Math.ceil(serialized.length / chunkSize);
  const port = chrome.runtime.connect({ name: portName });
  return new Promise((resolve, reject) => {
    let completed = false;
    const sendChunk = (index: number) => {
      const start = index * chunkSize;
      port.postMessage({ type: "CHUNK", index, value: serialized.slice(start, start + chunkSize) });
      onProgress(`Streaming local payload: ${index + 1}/${totalChunks}`);
    };
    port.onMessage.addListener((message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const response = message as { type?: string; nextIndex?: number; error?: string; diagnostic?: unknown; receipt?: T };
      if (response.type === "READY") sendChunk(0);
      else if (response.type === "ACK" && typeof response.nextIndex === "number") sendChunk(response.nextIndex);
      else if (response.type === "STORED" && response.receipt) { completed = true; resolve(response.receipt); port.disconnect(); }
      else if (response.type === "ERROR") { completed = true; reject(captureDiagnosticError(response,"extension_channel")); port.disconnect(); }
    });
    port.onDisconnect.addListener(() => { if (!completed) reject(captureFailure("extension_channel","stream_disconnected")); });
    port.postMessage({ type: "START", totalChunks, ...(operation ? { operation } : {}) });
  });
}

async function inventorySidebar(onProgress: (message: string) => void): Promise<InventoryRun> {
  const account = await existingOpaqueAccountReference();
  const adapter = new ChatGptSidebarInventoryAdapter();
  const port = new ChatGptDomSidebarPort(document);
  const inventory = await adapter.inventory(port, account, (progress) => onProgress(`Read-only sidebar inventory: ${progress.unique_conversations} conversations observed; pass ${progress.pass}.`));
  return hashInventoryEvidence(inventory);
}

/**
 * Dry discovery. Reads only what the page already renders, keeps the complete run in memory for the
 * duration of the call, and returns a capped summary. Nothing is streamed to the collector, written
 * to the archive, or stored in extension storage.
 */
async function discoverSite(onProgress: (message: string) => void): Promise<SiteDiscoveryResult> {
  const account = await readOnlyOpaqueAccountReference();
  return runSiteDiscovery(document, location.href, account, onProgress, undefined, memoryQueryComparison);
}

/**
 * Sends the minimum comparison payload to the local read-only Memory Query Service through the
 * background worker. This never touches the capture collector: memory_v1 read authority and
 * source-capture write authority stay separate services with separate tokens.
 */
async function memoryQueryComparison(payload: ComparisonRequestPayload): Promise<ComparisonResponsePayload> {
  const response = await chrome.runtime.sendMessage({
    type: "HHS_MEMORY_QUERY_REQUEST",
    endpoint: "discovery/compare",
    body: payload
  }) as { ok: boolean; body?: ComparisonResponsePayload; error?: string };
  if (!response.ok || !response.body) throw new Error(response.error ?? "Local memory query service is unavailable.");
  return response.body;
}

/**
 * Reads the established opaque account reference without creating one. Discovery must never write to
 * extension storage, so an absent reference degrades to a non-identifying placeholder.
 */
async function readOnlyOpaqueAccountReference(): Promise<string> {
  const stored = await chrome.storage.local.get("opaqueAccountReference");
  return typeof stored.opaqueAccountReference === "string" ? stored.opaqueAccountReference : "opaque-account-undeclared";
}

async function prepareRecapture(): Promise<{ intent: Record<string, unknown> }> {
  const active = await activeIdentity();
  const response = await collectorRequest("recapture/intents", active);
  return { intent: response };
}

async function runConfirmedRecapture(intentId: string, operation: OperationContext, onProgress: (message: string) => void, runtime: CaptureRuntime): Promise<Record<string, unknown>> {
  const active = await activeIdentity();
  await collectorRequest(`recapture/intents/${encodeURIComponent(intentId)}/verify`, active);
  await collectorRequest(`recapture/intents/${encodeURIComponent(intentId)}/confirm`, { platform_id: active.platform_id, opaque_account_reference: active.opaque_account_reference, confirmed: true });
  await emitOperationEvent(operation, "capture_started", "extension_content", { stage: "capture_started" });
  const bundle = await captureConversation(onProgress,runtime);
  const observedConversation = `conversation-${(await sha256Text(bundle.conversation.conversation_id)).slice(0, 24)}`;
  if (bundle.conversation.conversation_id !== active.conversation_id || observedConversation !== operation.expectedConversationReference) {
    await emitOperationEvent({ ...operation, eventSequence: operation.eventSequence + 1 }, "identity_mismatch", "extension_content", {
      safe_error_code: "identity_mismatch",
      safe_error_summary: "The active conversation identity changed or did not match.",
      reason_code: "identity_mismatch"
    });
    throw new Error("Active conversation identity changed during recapture; submission prohibited.");
  }
  await emitOperationEvent({ ...operation, eventSequence: operation.eventSequence + 1 }, "capture_progress", "extension_content", { stage: "extraction_completed", message_count: bundle.messages.length });
  return streamJsonToBackground<Record<string, unknown>>(bundle, `HHS_RECAPTURE_STREAM:${intentId}`, onProgress, { ...operation, eventSequence: operation.eventSequence + 2 });
}

async function activeIdentity(): Promise<{ platform_id: string; opaque_account_reference: string; conversation_id: string }> {
  const match = /^\/(?:g\/[^/]+\/)?c\/([^/?#]+)/.exec(location.pathname);
  if (!match?.[1]) throw new Error("Open the manually selected ChatGPT conversation before preparing recapture.");
  return { platform_id: "chatgpt", opaque_account_reference: await existingOpaqueAccountReference(), conversation_id: match[1] };
}

async function observedCaptureIdentity(): Promise<{ platform: string; opaqueAccountReference: string; opaqueConversationReference: string }> {
  const identity = await activeIdentity();
  return {
    platform: identity.platform_id,
    opaqueAccountReference: identity.opaque_account_reference,
    opaqueConversationReference: `conversation-${(await sha256Text(identity.conversation_id)).slice(0, 24)}`
  };
}

async function collectorRequest(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await chrome.runtime.sendMessage({ type: "HHS_COLLECTOR_REQUEST", endpoint, body }) as { ok: boolean; body?: Record<string, unknown>; error?: string; diagnostic?: unknown };
  if (!response.ok || !response.body) throw captureDiagnosticError(response,"operation_event");
  return response.body;
}

async function emitOperationEvent(operation: OperationContext, eventType: string, sourceComponent: string, metadata: Record<string, string | number | boolean>): Promise<void> {
  await collectorRequest(`operations/${encodeURIComponent(operation.operationId)}/events`, {
    operation_id: operation.operationId,
    correlation_id: operation.correlationId,
    event_type: eventType,
    event_sequence: operation.eventSequence,
    event_timestamp: new Date().toISOString(),
    source_component: sourceComponent,
    metadata,
    idempotency_key: await sha256Text(`${operation.operationId}:${operation.eventSequence}:${eventType}`)
  });
}

async function existingOpaqueAccountReference(): Promise<string> {
  const stored = await chrome.storage.local.get("opaqueAccountReference");
  if (typeof stored.opaqueAccountReference !== "string") throw new Error("No established opaque account reference is stored. Complete-account inventory is prohibited until the existing capture identity is restored.");
  return stored.opaqueAccountReference;
}

async function captureConversation(onProgress: (message: string) => void, runtime:CaptureRuntime): Promise<CaptureBundle> {
  const resolution = resolveDiscoveryAdapter(new URL(location.href).hostname);
  if (!resolution.supported || !resolution.registration.capture) throw captureFailure("page_detection", "unsupported_page");
  const adapter = resolution.registration.capture.create();
  if(adapter.adapterVersion!==runtime.adapter_version)throw captureFailure('extension_channel','runtime_version_mismatch');
  const startedAt = new Date().toISOString();
  const context = {
    document,
    sourceUrl: location.href,
    onProgress,
    captureScreenshot: async (portion: EvidenceRecord["portion"], metadata: Record<string, unknown> = {}): Promise<EvidenceRecord | undefined> => {
      const response = await chrome.runtime.sendMessage({ type: "HHS_CAPTURE_SCREENSHOT" }) as { ok: boolean; dataUrl?: string };
      if (!response.ok || !response.dataUrl) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 550));
      return { evidence_id: crypto.randomUUID(), kind: "screenshot", portion, captured_at: new Date().toISOString(), media_type: "image/png", sha256: await sha256DataUrl(response.dataUrl), inline_data: response.dataUrl, metadata: { viewport: { width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY }, ...metadata } };
    },
  };
  const detection = await captureStep("page_detection",()=>adapter.detect(context));
  if (!detection.detected) throw captureFailure("page_detection", detection.reason ?? "conversation_not_rendered");
  const identity = await captureStep("identity_read",()=>adapter.identifyConversation(context));
  const extracted = await captureStep("page_extraction",()=>adapter.capture(context));
  const verification = await captureStep("capture_validation",()=>verifyCapture(extracted));
  const account = await captureStep("account_read",()=>opaqueAccountReference());
  const captureId = crypto.randomUUID();
  return {
    schema_version: SCHEMA_VERSION,
    capture: { capture_id: captureId, started_at: startedAt, completed_at: new Date().toISOString(), source_url: identity.sourceUrl, adapter_version: adapter.adapterVersion, status: verification.status },
    platform: { id: adapter.platform, observed_host: location.hostname },
    account: { opaque_account_reference: account },
    conversation: { conversation_id: identity.conversationId, ...(identity.platformConversationId ? { platform_conversation_id: identity.platformConversationId } : {}), title: identity.title, source_url: identity.sourceUrl, platform_metadata: {} },
    messages: extracted.messages,
    branches: extracted.branches,
    attachments: extracted.attachments,
    citations: extracted.citations,
    artifacts: extracted.artifacts,
    tool_events: extracted.toolEvents,
    evidence: extracted.evidence,
    verification: { ruleset_version: "0.1.0", ...verification },
    platform_metadata: {...extracted.platformMetadata,capture_runtime:runtime},
  };
}

async function opaqueAccountReference(): Promise<string> {
  const stored = await chrome.storage.local.get("opaqueAccountReference");
  if (typeof stored.opaqueAccountReference === "string") return stored.opaqueAccountReference;
  const created = `account-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ opaqueAccountReference: created });
  return created;
}

async function sha256DataUrl(dataUrl: string): Promise<string> {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isCaptureRequest(value: unknown): value is { type: "HHS_CAPTURE_CURRENT_VERIFIED"; operation: OperationContext } {
  if (typeof value !== "object" || value === null || (value as { type?: string }).type !== "HHS_CAPTURE_CURRENT_VERIFIED") return false;
  const operation = (value as { operation?: Partial<OperationContext> }).operation;
  return typeof operation?.operationId === "string" && typeof operation.correlationId === "string" && Number.isSafeInteger(operation.eventSequence);
}

function isInventoryRequest(value: unknown): value is { type: "HHS_INVENTORY_SIDEBAR" } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_INVENTORY_SIDEBAR";
}

function isPrepareRecaptureRequest(value: unknown): value is { type: "HHS_PREPARE_RECAPTURE" } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_PREPARE_RECAPTURE";
}

function isConfirmedRecaptureRequest(value: unknown): value is { type: "HHS_CONFIRMED_RECAPTURE_VERIFIED"; intentId: string; operation: OperationContext } {
  if (typeof value !== "object" || value === null || (value as { type?: string }).type !== "HHS_CONFIRMED_RECAPTURE_VERIFIED" || typeof (value as { intentId?: unknown }).intentId !== "string") return false;
  const operation = (value as { operation?: Partial<OperationContext> }).operation;
  return typeof operation?.operationId === "string" && typeof operation.correlationId === "string"
    && Number.isSafeInteger(operation.eventSequence) && typeof operation.expectedConversationReference === "string";
}

function isDiscoverSiteRequest(value: unknown): value is { type: "HHS_DISCOVER_SITE" } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_DISCOVER_SITE";
}

function isObserveIdentityRequest(value: unknown): value is { type: "HHS_OBSERVE_CAPTURE_IDENTITY" } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_OBSERVE_CAPTURE_IDENTITY";
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
