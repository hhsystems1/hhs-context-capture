chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isScreenshotRequest(message)) {
    chrome.tabs.captureVisibleTab({ format: "png" }).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  } else if (isCollectorRequest(message)) {
    submitToCollector(JSON.stringify(message.body ?? {}), message.endpoint).then(
      (body) => sendResponse({ ok: true, body }),
      (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  } else if (isMemoryQueryRequest(message)) {
    submitToMemoryQueryService(JSON.stringify(message.body ?? {}), message.endpoint).then(
      (body) => sendResponse({ ok: true, body }),
      (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  } else return false;
  return true;
});

const COLLECTOR = "http://127.0.0.1:43117";
// The local read-only Memory Query Service. Deliberately a different origin, a different token, and
// a different authority from the collector: memory_v1 reads never travel over the capture channel.
const MEMORY_QUERY_SERVICE = "http://127.0.0.1:54431";
const MAX_STREAM_BYTES = 150 * 1024 * 1024;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "HHS_ARCHIVE_STREAM" && port.name !== "HHS_INVENTORY_STREAM" && !port.name.startsWith("HHS_RECAPTURE_STREAM:")) return;
  const endpoint = port.name === "HHS_ARCHIVE_STREAM" ? "captures" : port.name === "HHS_INVENTORY_STREAM" ? "inventories" : `recapture/intents/${encodeURIComponent(port.name.slice("HHS_RECAPTURE_STREAM:".length))}/capture`;
  let chunks: string[] = [];
  let expectedChunks = 0;
  let receivedBytes = 0;
  let operation: { operationId: string; correlationId: string; eventSequence: number } | undefined;

  port.onMessage.addListener((message: unknown) => {
    if (!isStreamMessage(message)) return;
    if (message.type === "START") {
      expectedChunks = message.totalChunks;
      chunks = new Array<string>(expectedChunks);
      receivedBytes = 0;
      operation = message.operation;
      if (port.name !== "HHS_INVENTORY_STREAM" && !operation) {
        port.postMessage({ type: "ERROR", error: "Capture operation identity is required." });
        return;
      }
      port.postMessage({ type: "READY" });
      return;
    }
    if (message.type === "CHUNK") {
      if (message.index < 0 || message.index >= expectedChunks || chunks[message.index] !== undefined) {
        port.postMessage({ type: "ERROR", error: "Invalid or duplicate local stream chunk." });
        return;
      }
      chunks[message.index] = message.value;
      receivedBytes += message.value.length;
      if (receivedBytes > MAX_STREAM_BYTES) {
        port.postMessage({ type: "ERROR", error: "Local stream exceeds the extension size limit." });
        port.disconnect();
        return;
      }
      if (message.index + 1 < expectedChunks) {
        port.postMessage({ type: "ACK", nextIndex: message.index + 1 });
      } else {
        void deliverStream(chunks.join(""), endpoint, operation).then(
          (receipt) => port.postMessage({ type: "STORED", receipt }),
          (error: unknown) => port.postMessage({ type: "ERROR", error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  });
});

async function deliverStream(serializedPayload: string, endpoint: string, operation?: { operationId: string; correlationId: string; eventSequence: number }): Promise<unknown> {
  if (!operation) return submitToCollector(serializedPayload, endpoint);
  await submitOperationEvent(operation, "collector_delivery_started", "extension_worker", { stage: "collector_delivery_started" });
  try {
    return await submitToCollector(serializedPayload, endpoint, {
      "x-hhs-operation-id": operation.operationId,
      "x-hhs-correlation-id": operation.correlationId
    });
  } catch (error) {
    try {
      await submitOperationEvent({ ...operation, eventSequence: operation.eventSequence + 1 }, "collector_delivery_failed", "extension_worker", {
        safe_error_code: "delivery_failed",
        safe_error_summary: "The capture could not be delivered to the local collector.",
        reason_code: "delivery_failed"
      });
    } catch {
      // If the collector is unreachable, durable reconciliation will classify the last authoritative stage.
    }
    throw error;
  }
}

async function submitOperationEvent(
  operation: { operationId: string; correlationId: string; eventSequence: number },
  eventType: string,
  sourceComponent: string,
  metadata: Record<string, string | number | boolean>
): Promise<void> {
  await submitToCollector(JSON.stringify({
    operation_id: operation.operationId,
    correlation_id: operation.correlationId,
    event_type: eventType,
    event_sequence: operation.eventSequence,
    event_timestamp: new Date().toISOString(),
    source_component: sourceComponent,
    metadata,
    idempotency_key: await sha256Text(`${operation.operationId}:${operation.eventSequence}:${eventType}`)
  }), `operations/${encodeURIComponent(operation.operationId)}/events`);
}

async function submitToCollector(serializedPayload: string, endpoint: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const { collectorToken } = await chrome.storage.local.get("collectorToken");
  if (typeof collectorToken !== "string") throw new Error("Collector pairing expired.");
  const response = await fetch(`${COLLECTOR}/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${collectorToken}`, "content-type": "application/json", ...extraHeaders }, body: serializedPayload });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Collector rejected local payload.");
  return body;
}

async function submitToMemoryQueryService(serializedPayload: string, endpoint: string): Promise<unknown> {
  const { memoryQueryToken } = await chrome.storage.local.get("memoryQueryToken");
  if (typeof memoryQueryToken !== "string") {
    throw new Error("No Memory Query Service token is stored. Save one to enable read-only comparison.");
  }
  const response = await fetch(`${MEMORY_QUERY_SERVICE}/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${memoryQueryToken}`, "content-type": "application/json" },
    body: serializedPayload
  });
  const body = await response.json() as { error?: string; detail?: string };
  if (!response.ok) throw new Error(body.detail ?? body.error ?? "Memory query service rejected the request.");
  return body;
}

function isMemoryQueryRequest(value: unknown): value is { type: "HHS_MEMORY_QUERY_REQUEST"; endpoint: string; body?: unknown } {
  return typeof value === "object" && value !== null
    && (value as { type?: string }).type === "HHS_MEMORY_QUERY_REQUEST"
    && typeof (value as { endpoint?: unknown }).endpoint === "string";
}

function isScreenshotRequest(value: unknown): value is { type: "HHS_CAPTURE_SCREENSHOT" } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_CAPTURE_SCREENSHOT";
}

function isCollectorRequest(value: unknown): value is { type: "HHS_COLLECTOR_REQUEST"; endpoint: string; body?: unknown } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "HHS_COLLECTOR_REQUEST" && typeof (value as { endpoint?: unknown }).endpoint === "string";
}

function isStreamMessage(value: unknown): value is
  { type: "START"; totalChunks: number; operation?: { operationId: string; correlationId: string; eventSequence: number } } |
  { type: "CHUNK"; index: number; value: string } {
  if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") return false;
  const message = value as Record<string, unknown>;
  return (message.type === "START" && Number.isInteger(message.totalChunks) && Number(message.totalChunks) > 0) ||
    (message.type === "CHUNK" && Number.isInteger(message.index) && typeof message.value === "string");
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
