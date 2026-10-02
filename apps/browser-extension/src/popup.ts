import type { DiscoverySummary, SiteDiscoveryResult } from "./discovery/run.js";
import type { ComparisonOutcome } from "./discovery/compare.js";

const COLLECTOR = "http://127.0.0.1:43117";
const pairCode = document.querySelector<HTMLInputElement>("#pair-code")!;
const pairButton = document.querySelector<HTMLButtonElement>("#pair")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture")!;
const discoverButton = document.querySelector<HTMLButtonElement>("#discover")!;
const discoverySummary = document.querySelector<HTMLElement>("#discovery-summary")!;
const inventoryButton = document.querySelector<HTMLButtonElement>("#inventory")!;
const prepareRecaptureButton = document.querySelector<HTMLButtonElement>("#prepare-recapture")!;
const confirmRecaptureButton = document.querySelector<HTMLButtonElement>("#confirm-recapture")!;
const status = document.querySelector<HTMLElement>("#status")!;

void restoreState();

pairButton.addEventListener("click", async () => {
  setStatus("Pairing with local collector...");
  const operationId = `operation-${crypto.randomUUID()}`;
  const correlationId = `correlation-${crypto.randomUUID()}`;
  try {
    const response = await fetch(`${COLLECTOR}/pair`, {
      method: "POST",
      headers: { "x-hhs-pair-code": pairCode.value.trim(), "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: operationId,
        correlation_id: correlationId,
        platform: "local-extension",
        opaque_account_reference: "opaque-account-unavailable",
        source_component: "extension_popup"
      })
    });
    const body = await response.json() as { token?: string; error?: string };
    if (!response.ok || !body.token) throw new Error(body.error ?? "Pairing failed.");
    await chrome.storage.local.set({ collectorToken: body.token });
    await chrome.storage.local.remove("pendingRecaptureIntent");
    pairCode.value = "";
    captureButton.disabled = false;
    inventoryButton.disabled = false;
    prepareRecaptureButton.disabled = false;
    confirmRecaptureButton.disabled = true;
    setStatus("Collector paired. Capture and read-only inventory are available.");
    await reconcileLatestOperation();
  } catch { setStatus("Pairing failed. Check that the local collector is running and use its current one-time code.", true); }
});

prepareRecaptureButton.addEventListener("click", async () => {
  setActionButtonsDisabled(true);
  try {
    const tabId = await activeChatGptTab("Manually open one cataloged ChatGPT conversation before preparing recapture.");
    setStatus("Checking the current conversation against the local catalog. No capture has started...");
    const result = await sendPageRequest<PrepareRecaptureReceipt>(tabId, { type: "HHS_PREPARE_RECAPTURE" });
    if (!result.ok || !result.intent || typeof result.intent.intentId !== "string") throw new Error(result.error ?? "Could not create a recapture intent.");
    await chrome.storage.local.set({ pendingRecaptureIntent: result.intent.intentId });
    setStatus(`Selected: ${String(result.intent.title ?? "cataloged conversation")}. No capture yet. Use Confirm One Immutable Recapture only after separate approval.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally { await enablePairedActions(); }
});

confirmRecaptureButton.addEventListener("click", async () => {
  const { pendingRecaptureIntent } = await chrome.storage.local.get("pendingRecaptureIntent");
  if (typeof pendingRecaptureIntent !== "string") return setStatus("Prepare the current cataloged conversation first.", true);
  const confirmed = confirm("Create exactly one new immutable capture version of the currently open, manually selected conversation? This does not navigate, regenerate, edit, or submit. Continue only with explicit approval for this exact conversation.");
  if (!confirmed) return;
  setActionButtonsDisabled(true);
  let operation: OperationContext | undefined;
  try {
    const tabId = await activeChatGptTab("The manually selected ChatGPT conversation must remain open.");
    const identityResult = await sendPageRequest<IdentityReceipt>(tabId, { type: "HHS_OBSERVE_CAPTURE_IDENTITY" });
    if (!identityResult.ok || !identityResult.identity) throw new Error("Recapture identity could not be observed safely.");
    const operationId = `operation-${crypto.randomUUID()}`;
    const correlationId = `correlation-${crypto.randomUUID()}`;
    const created = await collectorApi<OperationReport>("operations", "POST", {
      operation_id: operationId,
      correlation_id: correlationId,
      platform: identityResult.identity.platform,
      opaque_account_reference: identityResult.identity.opaqueAccountReference,
      opaque_conversation_reference: identityResult.identity.opaqueConversationReference,
      operation_type: "recapture",
      source_component: "extension_popup"
    });
    operation = { operationId, correlationId, eventSequence: created.last_event_sequence + 1, expectedConversationReference: identityResult.identity.opaqueConversationReference };
    await appendEvent(operation, "identity_observed", "extension_content", { stage: "identity_observed" });
    operation.eventSequence++;
    await appendEvent(operation, "identity_verified", "extension_content", { stage: "identity_verified", identity_verified: true });
    operation.eventSequence++;
    await appendEvent(operation, "capture_requested", "extension_popup", { stage: "capture_requested" });
    operation.eventSequence++;
    setStatus("Creating one immutable recapture. Keep this exact tab active...");
    const result = await sendPageRequest<ConfirmedRecaptureReceipt>(tabId, { type: "HHS_CONFIRMED_RECAPTURE", intentId: pendingRecaptureIntent, operation });
    if (!result.ok || !result.recapture) throw new Error(result.error ?? "Recapture failed.");
    await chrome.storage.local.remove("pendingRecaptureIntent");
    const report = await collectorApi<{ operation: OperationReport }>(`operations/${encodeURIComponent(operationId)}`, "GET");
    await rememberOperation(report.operation);
    setStatus(`Recapture ${report.operation.status}. Archive and comparison receipts were stored locally.`);
  } catch {
    if (operation) await recordSafeCaptureFailure(operation);
    setStatus("Recapture stopped before completion. Inspect the latest safe operation report.", true);
  } finally { await enablePairedActions(); }
});

captureButton.addEventListener("click", async () => {
  setActionButtonsDisabled(true);
  let operation: OperationContext | undefined;
  try {
    const tabId = await activeChatGptTab("Open a ChatGPT conversation in the active tab before capturing.");
    const identityResult = await sendPageRequest<IdentityReceipt>(tabId, { type: "HHS_OBSERVE_CAPTURE_IDENTITY" });
    if (!identityResult.ok || !identityResult.identity) throw new Error("Capture identity could not be observed safely.");
    const operationId = `operation-${crypto.randomUUID()}`;
    const correlationId = `correlation-${crypto.randomUUID()}`;
    const created = await collectorApi<OperationReport>("operations", "POST", {
      operation_id: operationId,
      correlation_id: correlationId,
      platform: identityResult.identity.platform,
      opaque_account_reference: identityResult.identity.opaqueAccountReference,
      opaque_conversation_reference: identityResult.identity.opaqueConversationReference,
      operation_type: "capture",
      source_component: "extension_popup"
    });
    operation = {
      operationId,
      correlationId,
      eventSequence: created.last_event_sequence + 1,
      expectedConversationReference: identityResult.identity.opaqueConversationReference
    };
    await appendEvent(operation, "identity_observed", "extension_content", { stage: "identity_observed" });
    operation.eventSequence++;
    await appendEvent(operation, "identity_verified", "extension_content", { stage: "identity_verified", identity_verified: true });
    operation.eventSequence++;
    await appendEvent(operation, "capture_requested", "extension_popup", { stage: "capture_requested" });
    operation.eventSequence++;
    setStatus("Capturing. Keep this ChatGPT tab active...");
    const result = await sendPageRequest<CaptureReceipt>(tabId, { type: "HHS_CAPTURE_CURRENT", operation });
    if (!result.ok || !result.archive) throw new Error(result.error ?? "Capture failed in the page.");
    const report = await collectorApi<{ operation: OperationReport }>(`operations/${encodeURIComponent(operationId)}`, "GET");
    await rememberOperation(report.operation);
    setStatus(`${report.operation.status}: ${result.archive.messageCount} messages archived as ${report.operation.safe_capture_reference ?? "a private capture reference"}.`);
  } catch {
    if (operation) await recordSafeCaptureFailure(operation);
    setStatus("Capture stopped before completion. Open the latest operation report for the safe last-known stage.", true);
  } finally { await enablePairedActions(); }
});

inventoryButton.addEventListener("click", async () => {
  const confirmed = confirm("Run one read-only sidebar inventory? This scrolls the ChatGPT sidebar and restores its initial position where possible. It will not open or capture conversations.");
  if (!confirmed) return;
  setActionButtonsDisabled(true);
  try {
    const tabId = await activeChatGptTab("Open ChatGPT with the conversation sidebar visible before inventory.");
    setStatus("Inventorying the sidebar read-only. Keep this ChatGPT tab active...");
    const result = await sendPageRequest<InventoryReceipt>(tabId, { type: "HHS_INVENTORY_SIDEBAR" });
    if (!result.ok || !result.inventory) throw new Error(result.error ?? "Sidebar inventory failed.");
    const receipt = result.inventory;
    setStatus(`${receipt.verificationStatus}: ${receipt.observedCount} conversations. new=${receipt.classificationCounts.new}, possibly_changed=${receipt.classificationCounts.possibly_changed}, unchanged=${receipt.classificationCounts.unchanged}, missing=${receipt.classificationCounts.missing}, needs_review=${receipt.classificationCounts.needs_review}. Inventory: ${receipt.inventoryPath}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally { await enablePairedActions(); }
});

discoverButton.addEventListener("click", async () => {
  setActionButtonsDisabled(true);
  discoverySummary.hidden = true;
  try {
    const { tabId, host } = await activeTabForDiscovery();
    setStatus(`Running a read-only dry discovery on ${host}. Nothing is written or stored...`);
    const result = await sendPageRequest<DiscoveryReceipt>(tabId, { type: "HHS_DISCOVER_SITE" });
    if (!result.ok || !result.discovery) throw new Error(result.error ?? "Discovery failed in the page.");
    if (!result.discovery.ok) {
      const refusal = result.discovery.refusal;
      return setStatus(`No discovery adapter is registered for ${refusal.host}. Registered sources: ${refusal.registered_hosts.join(", ")}.`, true);
    }
    renderDiscoverySummary(result.discovery.summary);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(/receiving end|establish connection|cannot access|no tab with id/i.test(detail)
      ? "This site is not supported for discovery yet. The extension holds no permission to read it."
      : detail, true);
  } finally { await enablePairedActions(); }
});

function renderDiscoverySummary(summary: DiscoverySummary): void {
  const lines = [
    `source:     ${summary.source_kind} (${summary.adapter_id} v${summary.adapter_version}, ${summary.transport})`,
    `host:       ${summary.observed_host}`,
    `status:     ${summary.status}   verified_complete: ${summary.verified_complete}`,
    `persisted:  ${summary.persisted}`,
    `snapshot:   ${summary.snapshot_sha256.slice(0, 16)}...`,
    "",
    `totals: ${summary.totals.containers} containers, ${summary.totals.items} items, ${summary.totals.items_needing_review} needing review`,
    ...Object.entries(summary.totals.items_by_kind).map(([kind, count]) => `  ${kind}: ${count}`),
    "",
    "containers:",
    ...summary.containers.map((container) => `  [${container.enumeration_status}] ${container.title} (${container.container_kind}): ${container.observed_item_count}${container.declared_item_count === null ? "" : ` of ${container.declared_item_count} declared`}`),
    "",
    "boundary verification:",
    ...Object.entries(summary.boundary_verification).map(([key, value]) => `  ${key}: ${value}`),
    "",
    "capabilities:",
    ...Object.entries(summary.capabilities).map(([key, value]) => `  ${key}: ${value}`),
    "",
    `warnings (${summary.warnings.length}):`,
    ...(summary.warnings.length > 0 ? summary.warnings.map((warning) => `  - ${warning}`) : ["  none"]),
    "",
    `item sample (${summary.item_sample.length} of ${summary.totals.items}${summary.item_sample_truncated ? ", truncated" : ""}):`,
    ...summary.item_sample.map((item) => `  - ${item.title} [${item.item_kind}] in ${item.container_title}${item.review_status === "needs_review" ? "  (needs_review)" : ""}`),
    "",
    ...comparisonLines(summary.comparison)
  ];
  discoverySummary.textContent = lines.join("\n");
  discoverySummary.hidden = false;
  setStatus(headlineFor(summary));
}

function comparisonLines(comparison: ComparisonOutcome | undefined): string[] {
  if (!comparison) return ["memory_v1 comparison: not run"];
  if (!comparison.available) {
    return [
      "memory_v1 comparison: unavailable",
      `  reason: ${comparison.reason}`,
      "  Start the local Memory Query Service and store its token to enable comparison."
    ];
  }

  const counts = comparison.counts;
  const plan = comparison.plan;
  const pad = (value: number) => String(value).padStart(4, " ");
  return [
    "memory_v1 comparison (read-only):",
    `${pad(counts.total_discovered)} chats discovered`,
    `${pad(counts.already_known)} already known`,
    `${pad(counts.never_captured)} never captured`,
    `${pad(counts.possibly_changed)} possibly changed`,
    `${pad(counts.captured_partial)} partial`,
    `${pad(counts.captured_verified)} verified`,
    `${pad(counts.needs_review)} need review`,
    "",
    "Proposed capture plan:",
    `${pad(plan.expected_item_count)} conversations`,
    `  operation:  ${plan.operation}`,
    `  volume:     ${plan.estimated_volume_bytes === null ? plan.estimated_volume_basis : `${plan.estimated_volume_bytes} bytes`}`,
    `  excluded:   ${plan.excluded.captured_verified} verified, ${plan.excluded.needs_review} needing review`,
    `  plan hash:  ${plan.plan_sha256.slice(0, 16)}...`,
    "  status:     proposed only. Nothing is captured, stored, or authorized by this plan.",
    ...(comparison.needs_review_sample.length > 0
      ? ["", `needs_review sample (${comparison.needs_review_sample.length}):`,
        ...comparison.needs_review_sample.map((item) => `  - ${item.title}: ${item.reasons.join(", ")}`)]
      : [])
  ];
}

function headlineFor(summary: DiscoverySummary): string {
  if (!summary.comparison?.available) {
    return `Dry discovery ${summary.status}: ${summary.totals.items} items across ${summary.totals.containers} containers. Nothing was written.`;
  }
  const counts = summary.comparison.counts;
  return `${counts.total_discovered} discovered, ${counts.already_known} already known, ${counts.never_captured} never captured. Proposed plan: ${summary.comparison.plan.expected_item_count} conversations. Nothing was captured.`;
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (typeof message === "object" && message !== null && (message as { type?: string }).type === "HHS_CAPTURE_PROGRESS") setStatus(String((message as { progress?: unknown }).progress ?? "Working..."));
});

async function restoreState(): Promise<void> {
  await enablePairedActions();
  if (captureButton.disabled) return setStatus("Start the collector, enter its one-time pairing code, then pair.");
  await reconcileLatestOperation();
}

async function enablePairedActions(): Promise<void> {
  const { collectorToken, pendingRecaptureIntent } = await chrome.storage.local.get(["collectorToken", "pendingRecaptureIntent"]);
  const disabled = typeof collectorToken !== "string";
  captureButton.disabled = disabled;
  inventoryButton.disabled = disabled;
  prepareRecaptureButton.disabled = disabled;
  confirmRecaptureButton.disabled = disabled || typeof pendingRecaptureIntent !== "string";
  // Dry discovery writes nothing and never contacts the collector, so it needs no pairing.
  discoverButton.disabled = false;
}

function setActionButtonsDisabled(disabled: boolean): void {
  captureButton.disabled = disabled;
  discoverButton.disabled = disabled;
  inventoryButton.disabled = disabled;
  prepareRecaptureButton.disabled = disabled;
  confirmRecaptureButton.disabled = disabled;
}

async function activeTabForDiscovery(): Promise<{ tabId: number; host: string }> {
  const [{ id: tabId, url } = {}] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabId === undefined || url === undefined) throw new Error("No active tab found.");
  return { tabId, host: new URL(url).hostname };
}

async function activeChatGptTab(errorMessage: string): Promise<number> {
  const [{ id: tabId, url } = {}] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabId) throw new Error("No active tab found.");
  if (!url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) throw new Error(errorMessage);
  return tabId;
}

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.dataset.error = String(error);
}

type CaptureReceipt = { ok: boolean; archive?: { archivePath: string; messageCount: number }; captureStatus?: string; messageCount?: number; error?: string };
type IdentityReceipt = { ok: boolean; identity?: { platform: string; opaqueAccountReference: string; opaqueConversationReference: string }; error?: string };
type OperationContext = { operationId: string; correlationId: string; eventSequence: number; expectedConversationReference: string };
type OperationReport = {
  operation_id: string; correlation_id: string; status: string; last_event_sequence: number;
  last_event_type: string; last_event_at: string; last_successful_stage: string;
  safe_capture_reference: string | null; stop_summary: string | null;
};
type ClassificationCounts = Record<"new" | "possibly_changed" | "unchanged" | "missing" | "needs_review", number>;
type InventoryReceipt = { ok: boolean; inventory?: { verificationStatus: string; observedCount: number; classificationCounts: ClassificationCounts; inventoryPath: string }; error?: string };
type DiscoveryReceipt = { ok: boolean; discovery?: SiteDiscoveryResult; error?: string };
type PrepareRecaptureReceipt = { ok: boolean; intent?: { intentId?: string; title?: string }; error?: string };
type ConfirmedRecaptureReceipt = { ok: boolean; recapture?: Record<string, unknown>; error?: string };

async function sendPageRequest<T>(tabId: number, message: { type: string } & Record<string, unknown>): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/receiving end does not exist|could not establish connection/i.test(detail)) throw error;
    setStatus("Connecting the HHS preservation script to this ChatGPT tab...");
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, message) as T;
  }
}

async function collectorApi<T>(endpoint: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const { collectorToken } = await chrome.storage.local.get("collectorToken");
  if (typeof collectorToken !== "string") throw new Error("Collector pairing expired.");
  const response = await fetch(`${COLLECTOR}/${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${collectorToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Local collector request failed.");
  return result;
}

async function appendEvent(operation: OperationContext, eventType: string, sourceComponent: string, metadata: Record<string, string | number | boolean>): Promise<void> {
  await collectorApi(`operations/${encodeURIComponent(operation.operationId)}/events`, "POST", {
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

async function recordSafeCaptureFailure(operation: OperationContext): Promise<void> {
  try {
    const result = await collectorApi<{ operation: OperationReport }>(`operations/${encodeURIComponent(operation.operationId)}`, "GET");
    if (["completed", "needs_review", "failed", "interrupted", "canceled"].includes(result.operation.status)) return void await rememberOperation(result.operation);
    operation.eventSequence = result.operation.last_event_sequence + 1;
    await appendEvent(operation, "capture_failed", "extension_popup", {
      safe_error_code: "internal_error",
      safe_error_summary: "A local component reported a safe internal failure.",
      reason_code: "internal_error",
      last_successful_stage: result.operation.last_successful_stage
    });
    const updated = await collectorApi<{ operation: OperationReport }>(`operations/${encodeURIComponent(operation.operationId)}`, "GET");
    await rememberOperation(updated.operation);
  } catch {
    // The collector may be unavailable; its durable last event remains authoritative for later reconciliation.
  }
}

async function reconcileLatestOperation(): Promise<void> {
  try {
    const result = await collectorApi<{ operation: OperationReport | null }>("operations/latest", "GET");
    if (!result.operation) return setStatus("Collector paired. No capture operation has been recorded yet.");
    await rememberOperation(result.operation);
    setStatus(`Latest operation: ${result.operation.status}; last stage: ${result.operation.last_successful_stage}.`);
  } catch {
    setStatus("Stored pairing is no longer valid. Pair with the current local collector before reconciling status.", true);
    captureButton.disabled = true;
    inventoryButton.disabled = true;
    prepareRecaptureButton.disabled = true;
    confirmRecaptureButton.disabled = true;
  }
}

async function rememberOperation(report: OperationReport): Promise<void> {
  const stored = await chrome.storage.local.get("captureOperationRecent");
  const prior = Array.isArray(stored.captureOperationRecent) ? stored.captureOperationRecent as OperationReport[] : [];
  const safe = {
    operation_id: report.operation_id,
    correlation_id: report.correlation_id,
    status: report.status,
    last_event_sequence: report.last_event_sequence,
    last_event_type: report.last_event_type,
    last_event_at: report.last_event_at,
    last_successful_stage: report.last_successful_stage,
    safe_capture_reference: report.safe_capture_reference,
    stop_summary: report.stop_summary
  };
  await chrome.storage.local.set({ captureOperationRecent: [safe, ...prior.filter((item) => item.operation_id !== report.operation_id)].slice(0, 5) });
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
