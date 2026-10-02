import { createHash } from "node:crypto";
import pg from "pg";
import { createPool, readOnlyTransaction } from "./db.js";
import { resolveKnownRecords, type CaptureVerificationStatus, type KnownConversationRecord, type KnownConversationRow } from "@hhs/capture-planning";

/**
 * Read-only comparison of discovered conversations against memory_v1.
 *
 * Every query runs through the report-reader pool inside a `begin read only` transaction. This
 * module contains no insert, update, or delete statement, and the report role holds no write grant.
 * It never writes discovery results anywhere: the answer is returned to the caller and dropped.
 */

/** Only sources with a registered discovery adapter may be compared. */
export const COMPARABLE_SOURCE_KINDS = ["chatgpt"] as const;
export const MAX_COMPARISON_ITEMS = 5_000;

/** The complete payload a client may send. Anything else is rejected. */
export const ALLOWED_ITEM_FIELDS = ["source_native_id", "title"] as const;

const VERIFICATION_STATUSES = new Set<CaptureVerificationStatus>(["complete", "partial", "failed", "needs_review"]);

export interface ComparisonItem {
  source_native_id: string;
  title: string;
}

export interface ComparisonPayload {
  sourceKind: string;
  opaqueAccountReference: string;
  items: ComparisonItem[];
}

export class ComparisonPayloadError extends Error {}

/**
 * Validates the minimum comparison payload. Items may carry only an identity and a title, so
 * conversation content cannot be sent to this service even by a modified client.
 */
export function parseComparisonPayload(body: Record<string, unknown>): ComparisonPayload {
  const sourceKind = typeof body.source_kind === "string" ? body.source_kind.trim() : "";
  if (!(COMPARABLE_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new ComparisonPayloadError(`source_kind must be one of: ${COMPARABLE_SOURCE_KINDS.join(", ")}`);
  }

  const opaqueAccountReference = typeof body.opaque_account_reference === "string" ? body.opaque_account_reference.trim() : "";
  if (!opaqueAccountReference) throw new ComparisonPayloadError("opaque_account_reference is required.");

  if (!Array.isArray(body.items)) throw new ComparisonPayloadError("items must be an array.");
  if (body.items.length > MAX_COMPARISON_ITEMS) {
    throw new ComparisonPayloadError(`items may not exceed ${MAX_COMPARISON_ITEMS} entries.`);
  }

  const items = body.items.map((entry, index): ComparisonItem => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ComparisonPayloadError(`items[${index}] must be an object.`);
    }
    const extra = Object.keys(entry).filter((key) => !(ALLOWED_ITEM_FIELDS as readonly string[]).includes(key));
    if (extra.length > 0) {
      throw new ComparisonPayloadError(`items[${index}] may contain only ${ALLOWED_ITEM_FIELDS.join(" and ")}; received: ${extra.join(", ")}`);
    }
    const record = entry as Record<string, unknown>;
    const nativeId = typeof record.source_native_id === "string" ? record.source_native_id.trim() : "";
    if (!nativeId) throw new ComparisonPayloadError(`items[${index}].source_native_id is required.`);
    if (typeof record.title !== "string") throw new ComparisonPayloadError(`items[${index}].title must be a string.`);
    return { source_native_id: nativeId, title: record.title };
  });

  return { sourceKind, opaqueAccountReference, items };
}

export interface ComparisonRequest extends ComparisonPayload {
  workspaceId: string;
}

/**
 * Returns what memory_v1 already holds for the supplied conversation identities. Titles are never
 * returned: the stored title is compared by SHA-256 and reduced to a boolean before leaving here.
 */
export async function compareDiscoveredConversations(
  request: ComparisonRequest,
  pool: pg.Pool = readerPool()
): Promise<KnownConversationRecord[]> {
  if (request.items.length === 0) return [];

  const nativeIds = [...new Set(request.items.map((item) => item.source_native_id))];
  const rows = await readOnlyTransaction(pool, request.workspaceId, async (client) => {
    const result = await client.query(KNOWN_CONVERSATIONS_SQL, [
      request.workspaceId,
      request.opaqueAccountReference,
      `${request.sourceKind}/%`,
      nativeIds
    ]);
    return result.rows as Array<Record<string, unknown>>;
  });

  const expectedTitleSha256 = new Map<string, string>();
  for (const item of request.items) {
    expectedTitleSha256.set(item.source_native_id, sha256Hex(item.title));
  }

  return resolveKnownRecords(rows.map(toKnownConversationRow), expectedTitleSha256);
}

export const KNOWN_CONVERSATIONS_SQL = `
select
  c.source_conversation_id as source_native_id,
  c.conversation_id        as conversation_record_id,
  cv.verification_status   as verification_status,
  cv.captured_at           as captured_at,
  c.title_representation->>'sha256' as title_sha256
from memory_v1.conversations c
join memory_v1.source_records sr
  on sr.workspace_id = c.workspace_id and sr.source_record_id = c.source_record_id
join memory_v1.source_accounts sa
  on sa.workspace_id = sr.workspace_id and sa.source_account_id = sr.source_account_id
join memory_v1.source_systems ss
  on ss.workspace_id = sr.workspace_id and ss.source_system_id = sr.source_system_id
left join memory_v1.capture_versions cv
  on cv.workspace_id = c.workspace_id and cv.conversation_id = c.conversation_id
where c.workspace_id = $1
  and sa.opaque_account_reference = $2
  and ss.adapter_contract like $3
  and c.source_conversation_id = any($4::text[])
`;

export function toKnownConversationRow(row: Record<string, unknown>): KnownConversationRow {
  const status = typeof row.verification_status === "string" ? row.verification_status : null;
  const capturedAt = row.captured_at instanceof Date
    ? row.captured_at.toISOString()
    : typeof row.captured_at === "string" ? row.captured_at : null;
  return {
    source_native_id: String(row.source_native_id),
    conversation_record_id: String(row.conversation_record_id),
    verification_status: status !== null && VERIFICATION_STATUSES.has(status as CaptureVerificationStatus)
      ? status as CaptureVerificationStatus
      : null,
    captured_at: capturedAt,
    title_sha256: typeof row.title_sha256 === "string" ? row.title_sha256 : null
  };
}

let cachedPool: pg.Pool | undefined;

/** The report-reader pool. No other role is reachable from this module. */
export function readerPool(): pg.Pool {
  cachedPool ??= createPool("reader");
  return cachedPool;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
