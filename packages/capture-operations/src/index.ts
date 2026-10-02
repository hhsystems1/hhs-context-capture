export const OPERATION_SCHEMA_VERSION = "hhs.capture-operation/1.0.0";
export const OPERATION_EVENT_SCHEMA_VERSION = "hhs.capture-operation-event/1.0.0";
export const OPERATION_RECEIPT_SCHEMA_VERSION = "hhs.capture-operation-receipt/1.0.0";

export const operationStates = [
  "created", "pairing", "prepared", "capturing", "delivering", "archiving", "verifying",
  "completed", "needs_review", "failed", "interrupted", "canceled"
] as const;
export type OperationStatus = (typeof operationStates)[number];

export const terminalOperationStates = ["completed", "needs_review", "failed", "interrupted", "canceled"] as const;
export type TerminalOperationStatus = (typeof terminalOperationStates)[number];

export const operationEventTypes = [
  "operation_created",
  "pairing_requested", "pairing_succeeded", "pairing_failed",
  "identity_observed", "identity_verified", "identity_mismatch",
  "capture_requested", "capture_started", "capture_progress",
  "collector_delivery_started", "collector_delivery_succeeded", "collector_delivery_failed",
  "archive_started", "archive_completed", "verification_completed",
  "capture_completed", "capture_needs_review", "capture_failed", "capture_interrupted",
  "operation_canceled"
] as const;
export type OperationEventType = (typeof operationEventTypes)[number];

export const sourceComponents = [
  "extension_popup", "extension_content", "extension_worker", "collector", "archive", "verifier", "reconciler"
] as const;
export type SourceComponent = (typeof sourceComponents)[number];

export type OperationType = "capture" | "recapture" | "pairing";
export type SafeMetadataValue = string | number | boolean | null;
export type SafeDiagnosticMetadata = Partial<Record<AllowedMetadataKey, SafeMetadataValue>>;

export interface OperationIdentity {
  operation_id: string;
  correlation_id: string;
}

export interface CreateOperationInput extends OperationIdentity {
  platform: string;
  opaque_account_reference: string;
  opaque_conversation_reference?: string;
  operation_type: OperationType;
  source_component: SourceComponent;
  parent_operation_id?: string;
}

export interface AppendOperationEventInput extends OperationIdentity {
  event_type: OperationEventType;
  event_sequence: number;
  event_timestamp: string;
  source_component: SourceComponent;
  metadata: SafeDiagnosticMetadata;
  event_sha256?: string;
  idempotency_key: string;
}

export interface OperationStatusReport {
  operation_id: string;
  correlation_id: string;
  status: OperationStatus;
  platform: string;
  operation_type: OperationType;
  last_event_sequence: number;
  last_event_type: OperationEventType;
  last_event_at: string;
  last_successful_stage: string;
  capture_started: boolean;
  identity_verified: boolean;
  collector_delivery_succeeded: boolean;
  archive_started: boolean;
  archive_created: boolean;
  verification_finished: boolean;
  safe_capture_reference: string | null;
  stop_reason_code: string | null;
  stop_summary: string | null;
  retry_safe: boolean;
  parent_operation_id: string | null;
  retry_operation_id: string | null;
  final_source_component: SourceComponent;
  stuck: boolean;
}

export const safeErrorSummaries = {
  pairing_failed: "The local collector did not accept the pairing request.",
  identity_mismatch: "The active conversation identity changed or did not match.",
  delivery_failed: "The capture could not be delivered to the local collector.",
  archive_failed: "The collector could not finish the immutable archive.",
  verification_failed: "Capture verification did not finish successfully.",
  stream_interrupted: "The local capture stream stopped before completion.",
  user_canceled: "The contributor canceled the operation.",
  stale_timeout: "The operation stopped making progress and was classified as interrupted.",
  collector_unavailable: "The local collector could not be reached.",
  validation_failed: "The collector rejected invalid operation data.",
  internal_error: "A local component reported a safe internal failure."
} as const;
export type SafeErrorCode = keyof typeof safeErrorSummaries;

const allowedMetadataKeys = [
  "stage", "progress_current", "progress_total", "message_count", "content_block_count",
  "safe_error_code", "safe_error_summary", "verification_status", "delivery_receipt_sha256",
  "archive_manifest_sha256", "safe_capture_reference", "reason_code", "timeout_seconds",
  "last_successful_stage", "identity_verified", "archive_created", "retry_safe"
] as const;
export type AllowedMetadataKey = (typeof allowedMetadataKeys)[number];
const allowedMetadata = new Set<string>(allowedMetadataKeys);
const hashKeys = new Set<AllowedMetadataKey>(["delivery_receipt_sha256", "archive_manifest_sha256"]);
const numericKeys = new Set<AllowedMetadataKey>(["progress_current", "progress_total", "message_count", "content_block_count", "timeout_seconds"]);
const booleanKeys = new Set<AllowedMetadataKey>(["identity_verified", "archive_created", "retry_safe"]);
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function validateCreateOperation(input: CreateOperationInput): void {
  assertIdentifier("operation_id", input.operation_id);
  assertIdentifier("correlation_id", input.correlation_id);
  assertSafeOpaque("platform", input.platform);
  assertSafeOpaque("opaque_account_reference", input.opaque_account_reference);
  if (input.opaque_conversation_reference !== undefined) assertSafeOpaque("opaque_conversation_reference", input.opaque_conversation_reference);
  if (!new Set<OperationType>(["capture", "recapture", "pairing"]).has(input.operation_type)) throw new Error("Unsupported operation_type.");
  if (!sourceComponents.includes(input.source_component)) throw new Error("Unsupported source_component.");
  if (input.parent_operation_id !== undefined) {
    assertIdentifier("parent_operation_id", input.parent_operation_id);
    if (input.parent_operation_id === input.operation_id) throw new Error("An operation cannot retry itself.");
  }
}

export function validateAppendEvent(input: AppendOperationEventInput): SafeDiagnosticMetadata {
  assertIdentifier("operation_id", input.operation_id);
  assertIdentifier("correlation_id", input.correlation_id);
  if (!operationEventTypes.includes(input.event_type)) throw new Error("Unsupported operation event type.");
  if (!sourceComponents.includes(input.source_component)) throw new Error("Unsupported source component.");
  if (!Number.isSafeInteger(input.event_sequence) || input.event_sequence < 1) throw new Error("event_sequence must be a positive integer.");
  if (!Number.isFinite(Date.parse(input.event_timestamp))) throw new Error("event_timestamp must be ISO-compatible.");
  if (!sha256Pattern.test(input.idempotency_key)) throw new Error("idempotency_key must be a lowercase SHA-256.");
  if (input.event_sha256 !== undefined && !sha256Pattern.test(input.event_sha256)) throw new Error("event_sha256 must be a lowercase SHA-256.");
  return validateSafeMetadata(input.metadata);
}

export function validateSafeMetadata(value: unknown): SafeDiagnosticMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Diagnostic metadata must be an allowlisted object.");
  const metadata = value as Record<string, unknown>;
  const output: Record<string, SafeMetadataValue> = {};
  for (const [key, item] of Object.entries(metadata)) {
    if (!allowedMetadata.has(key)) throw new Error(`Diagnostic metadata field is prohibited: ${key}.`);
    if (typeof item === "object" && item !== null) throw new Error(`Diagnostic metadata field must be scalar: ${key}.`);
    if (!["string", "number", "boolean"].includes(typeof item) && item !== null) throw new Error(`Unsupported diagnostic metadata value: ${key}.`);
    const typedKey = key as AllowedMetadataKey;
    if (numericKeys.has(typedKey) && (!Number.isSafeInteger(item) || Number(item) < 0)) throw new Error(`${key} must be a non-negative integer.`);
    if (booleanKeys.has(typedKey) && typeof item !== "boolean") throw new Error(`${key} must be boolean.`);
    if (hashKeys.has(typedKey) && (typeof item !== "string" || !sha256Pattern.test(item))) throw new Error(`${key} must be a lowercase SHA-256.`);
    if (typeof item === "string") validateSafeString(key, item);
    output[key] = item as SafeMetadataValue;
  }
  const code = output.safe_error_code;
  const summary = output.safe_error_summary;
  if (code !== undefined) {
    if (typeof code !== "string" || !(code in safeErrorSummaries)) throw new Error("safe_error_code is not allowlisted.");
    if (summary !== undefined && summary !== safeErrorSummaries[code as SafeErrorCode]) throw new Error("safe_error_summary must match its allowlisted error code.");
  } else if (summary !== undefined) throw new Error("safe_error_summary requires safe_error_code.");
  return output as SafeDiagnosticMetadata;
}

export function nextStatus(current: OperationStatus | null, eventType: OperationEventType): OperationStatus {
  if (current !== null && terminalOperationStates.includes(current as TerminalOperationStatus)) throw new Error("Terminal operations cannot accept more events.");
  const allowed = transitionTable[eventType];
  if (!allowed.from.includes(current)) throw new Error(`Invalid operation transition: ${String(current)} -> ${eventType}.`);
  return allowed.to;
}

export function reconstructOperationReport(
  operation: Pick<CreateOperationInput, "operation_id" | "correlation_id" | "platform" | "operation_type" | "parent_operation_id">,
  events: Array<Pick<AppendOperationEventInput, "event_type" | "event_sequence" | "event_timestamp" | "source_component" | "metadata">>,
  retryOperationId: string | null = null,
  staleAfterSeconds = 900,
  now = new Date()
): OperationStatusReport {
  if (!events.length) throw new Error("An operation report requires at least operation_created.");
  const ordered = [...events].sort((a, b) => a.event_sequence - b.event_sequence);
  let status: OperationStatus | null = null;
  for (let index = 0; index < ordered.length; index++) {
    const event = ordered[index]!;
    if (event.event_sequence !== index + 1) throw new Error("Operation event history is not contiguous.");
    status = nextStatus(status, event.event_type);
  }
  const has = (type: OperationEventType) => ordered.some((event) => event.event_type === type);
  const latest = ordered.at(-1)!;
  const merged = Object.assign({}, ...ordered.map((event) => event.metadata)) as SafeDiagnosticMetadata;
  const terminal = terminalOperationStates.includes(status as TerminalOperationStatus);
  const ageSeconds = Math.max(0, (now.getTime() - Date.parse(latest.event_timestamp)) / 1000);
  return {
    operation_id: operation.operation_id,
    correlation_id: operation.correlation_id,
    status: status!,
    platform: operation.platform,
    operation_type: operation.operation_type,
    last_event_sequence: latest.event_sequence,
    last_event_type: latest.event_type,
    last_event_at: latest.event_timestamp,
    last_successful_stage: String(merged.last_successful_stage ?? merged.stage ?? latest.event_type),
    capture_started: has("capture_started"),
    identity_verified: has("identity_verified"),
    collector_delivery_succeeded: has("collector_delivery_succeeded"),
    archive_started: has("archive_started"),
    archive_created: has("archive_completed"),
    verification_finished: has("verification_completed"),
    safe_capture_reference: typeof merged.safe_capture_reference === "string" ? merged.safe_capture_reference : null,
    stop_reason_code: typeof merged.reason_code === "string" ? merged.reason_code : typeof merged.safe_error_code === "string" ? merged.safe_error_code : null,
    stop_summary: typeof merged.safe_error_summary === "string" ? merged.safe_error_summary : null,
    retry_safe: terminal && status !== "completed" && status !== "needs_review",
    parent_operation_id: operation.parent_operation_id ?? null,
    retry_operation_id: retryOperationId,
    final_source_component: latest.source_component,
    stuck: !terminal && ageSeconds >= staleAfterSeconds
  };
}

export interface RecentOperationCache {
  schema_version: "hhs.capture-operation-recent-cache/1.0.0";
  operations: Array<Pick<OperationStatusReport, "operation_id" | "correlation_id" | "status" | "last_event_type" | "last_event_at" | "stop_summary">>;
}

export function updateRecentOperationCache(cache: RecentOperationCache | undefined, report: OperationStatusReport, limit = 5): RecentOperationCache {
  const safe = {
    operation_id: report.operation_id,
    correlation_id: report.correlation_id,
    status: report.status,
    last_event_type: report.last_event_type,
    last_event_at: report.last_event_at,
    stop_summary: report.stop_summary
  };
  const prior = cache?.schema_version === "hhs.capture-operation-recent-cache/1.0.0" ? cache.operations : [];
  return { schema_version: "hhs.capture-operation-recent-cache/1.0.0", operations: [safe, ...prior.filter((item) => item.operation_id !== report.operation_id)].slice(0, limit) };
}

function assertIdentifier(name: string, value: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${name} is invalid.`);
}

function assertSafeOpaque(name: string, value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$/.test(value)) throw new Error(`${name} must be an opaque identifier without paths or URLs.`);
}

function validateSafeString(key: string, value: string): void {
  if (value.length > 240 || [...value].some((character) => character.charCodeAt(0) < 32)) throw new Error(`${key} exceeds safe string limits.`);
  if (/^[a-zA-Z]:[\\/]|^\\\\|\/(?:users|home|var|etc)\//i.test(value)) throw new Error(`${key} contains a private filesystem path.`);
  if (/(?:https?|file|postgres(?:ql)?):\/\//i.test(value)) throw new Error(`${key} contains a prohibited URL.`);
  if (/(?:authorization|bearer|password|pairing secret|collector token|cookie|private key|transcript|<html|<body)/i.test(value)) throw new Error(`${key} contains prohibited sensitive material.`);
}

const transitionTable: Record<OperationEventType, { from: Array<OperationStatus | null>; to: OperationStatus }> = {
  operation_created: { from: [null], to: "created" },
  pairing_requested: { from: ["created"], to: "pairing" },
  pairing_succeeded: { from: ["pairing"], to: "prepared" },
  pairing_failed: { from: ["pairing"], to: "failed" },
  identity_observed: { from: ["created", "prepared"], to: "prepared" },
  identity_verified: { from: ["prepared"], to: "prepared" },
  identity_mismatch: { from: ["created", "prepared", "capturing"], to: "failed" },
  capture_requested: { from: ["created", "prepared"], to: "prepared" },
  capture_started: { from: ["prepared"], to: "capturing" },
  capture_progress: { from: ["capturing"], to: "capturing" },
  collector_delivery_started: { from: ["capturing"], to: "delivering" },
  collector_delivery_succeeded: { from: ["delivering"], to: "delivering" },
  collector_delivery_failed: { from: ["capturing", "delivering"], to: "failed" },
  archive_started: { from: ["delivering"], to: "archiving" },
  archive_completed: { from: ["archiving"], to: "archiving" },
  verification_completed: { from: ["archiving"], to: "verifying" },
  capture_completed: { from: ["verifying"], to: "completed" },
  capture_needs_review: { from: ["verifying"], to: "needs_review" },
  capture_failed: { from: ["created", "pairing", "prepared", "capturing", "delivering", "archiving", "verifying"], to: "failed" },
  capture_interrupted: { from: ["created", "pairing", "prepared", "capturing", "delivering", "archiving", "verifying"], to: "interrupted" },
  operation_canceled: { from: ["created", "pairing", "prepared", "capturing", "delivering", "archiving", "verifying"], to: "canceled" }
};
