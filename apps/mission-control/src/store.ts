import { createHash } from "node:crypto";
import pg from "pg";
import { assertLoopbackUrl } from "./diagnostics.js";
import type { CaptureOperationLink } from "./archive-inspector.js";
import { APPROVED_KNOWLEDGE_QUERY_SQL } from "../../memory-ingest/src/query.js";

const { Pool } = pg;

export interface SearchInput {
  text?: string;
  record_type?: "message" | "block";
  role?: "user" | "assistant" | "tool" | "system_visible" | "unknown";
  verification_status?: "complete" | "partial" | "failed" | "needs_review";
}

export interface ApprovedKnowledgeInput {
  text?: string;
}

/**
 * Pending human review work, read-only.
 *
 * A knowledge candidate is pending only while no human_review_events row
 * exists for it. Candidate rows are immutable and their status stays
 * 'proposed' permanently, while decisions are recorded as append-only review
 * events, so filtering on status alone leaves decided candidates in the inbox.
 * This mirrors the pending filter proven in apps/memory-ingest/src/review.ts.
 */
export const PENDING_REVIEWS_SQL = `select kind,raw_id,status,detail,occurred_at from (
          select 'capture_operation_review' kind,operation_id raw_id,status,
            jsonb_build_object('last_successful_stage',last_successful_stage,'verification_finished',verification_finished) detail,
            last_event_at occurred_at
            from capture_ops.operation_status_report where workspace_id=$1 and status='needs_review'
          union all select 'capture_verification',verification_result_id,status,
            jsonb_build_object('warning_count',jsonb_array_length(warnings)) detail,null::timestamptz occurred_at
            from memory_v1.verification_results where workspace_id=$1 and status in ('needs_review','partial','failed')
          union all select 'quarantine',quarantine_item_id,status,
            jsonb_build_object('reason_code',reason_code,'fatal',fatal),null::timestamptz
            from memory_v1.quarantine_items where workspace_id=$1 and status='open'
          union all select 'knowledge_candidate',k.knowledge_candidate_id,k.status,
            jsonb_build_object('kind',k.kind,'pipeline_version',k.pipeline_version,'promotion_receipt_id',k.promotion_receipt_id,'promoted_at',p.promoted_at),coalesce(p.promoted_at,k.created_at)
            from memory_v1.trusted_knowledge_candidates k
            left join memory_v1.promotion_receipts p
              on (p.workspace_id,p.promotion_receipt_id,p.pipeline_version)=(k.workspace_id,k.promotion_receipt_id,k.pipeline_version)
            where k.workspace_id=$1 and k.status='proposed'
              and not exists (select 1 from memory_v1.human_review_events e
                where e.workspace_id=k.workspace_id and e.knowledge_candidate_id=k.knowledge_candidate_id)
          union all select 'contradiction',contradiction_id,status,'{}'::jsonb,null::timestamptz
            from memory_v1.contradictions where workspace_id=$1 and status<>'resolved'
          union all select 'supersession',supersession_id,'recorded','{}'::jsonb,null::timestamptz
            from memory_v1.supersessions where workspace_id=$1
        ) raw order by occurred_at desc nulls last limit 100`;

/**
 * Approved knowledge listing, read-only.
 *
 * Lists human-approved knowledge with the approval event that authorized it and
 * one representative provenance line resolved through the existing chain:
 * approved_knowledge -> candidate_evidence -> provenance_edges -> content_blocks
 * -> messages -> conversations -> capture_versions. This is a listing, not a
 * search: text matching is delegated to the proven APPROVED_KNOWLEDGE_QUERY_SQL
 * in apps/memory-ingest/src/query.ts so no competing search exists.
 */
export const APPROVED_KNOWLEDGE_LIST_SQL = `select
    ak.approved_knowledge_id,ak.knowledge_candidate_id,ak.pipeline_version,ak.approved_at,
    ak.approved_value,ak.approved_value_sha256,
    jsonb_array_length(ak.provenance_edge_ids) provenance_edge_count,
    k.kind,
    hre.reviewer_id,hre.rationale,hre.to_status review_status,hre.occurred_at reviewed_at,
    ev.capture_version_id,ev.immutable_archive_locator,ev.conversation_id,ev.source_conversation_id,
    ev.message_id,ev.sequence,ev.role,ev.representation_kind,ev.representation_sha256,ev.text_value
  from memory_v1.approved_knowledge ak
  join memory_v1.knowledge_candidates k
    on k.workspace_id=ak.workspace_id and k.knowledge_candidate_id=ak.knowledge_candidate_id
  join memory_v1.human_review_events hre
    on hre.workspace_id=ak.workspace_id and hre.human_review_event_id=ak.approval_event_id
  left join lateral (
    select cv.capture_version_id,cv.immutable_archive_locator,conv.conversation_id,conv.source_conversation_id,
           m.message_id,m.sequence,m.role,pe.representation_kind,pe.representation_sha256,
           (select rep->>'value' from jsonb_array_elements(b.representations) rep
             where rep->>'representation_kind'=pe.representation_kind
               and rep->>'sha256'=pe.representation_sha256 limit 1) text_value
      from memory_v1.candidate_evidence ce
      join memory_v1.provenance_edges pe
        on pe.workspace_id=ce.workspace_id and pe.provenance_edge_id=ce.provenance_edge_id
      join memory_v1.content_blocks b
        on b.workspace_id=pe.workspace_id and b.content_block_id=pe.content_block_id
      join memory_v1.messages m on m.workspace_id=b.workspace_id and m.message_id=b.message_id
      join memory_v1.conversations conv
        on conv.workspace_id=m.workspace_id and conv.conversation_id=m.conversation_id
      join memory_v1.capture_versions cv
        on cv.workspace_id=m.workspace_id and cv.capture_version_id=m.capture_version_id
     where ce.workspace_id=ak.workspace_id and ce.knowledge_candidate_id=ak.knowledge_candidate_id
     order by m.sequence asc,pe.provenance_edge_id asc limit 1
  ) ev on true
  where ak.workspace_id=$1
  order by ak.approved_at desc limit 200`;

export class MissionControlStore {
  private readonly pool: pg.Pool;
  constructor(private readonly workspaceId: string, connectionString: string) {
    assertLoopbackUrl(connectionString);
    this.pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 3000,
      application_name: "hhs-mission-control-reader"
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  async captureOperationBySafeReference(safeCaptureReference: string): Promise<CaptureOperationLink> {
    if (!/^capture-[a-f0-9]{24}$/.test(safeCaptureReference)) throw new Error("Invalid safe capture reference.");
    return this.read(async (client) => {
      const result = await client.query(`select o.operation_id,o.status,o.verification_status,
          o.safe_capture_reference,o.archive_manifest_sha256,
          (select (e.diagnostic_metadata->>'message_count')::integer
             from capture_ops.capture_operation_events e
            where e.workspace_id=o.workspace_id and e.operation_id=o.operation_id
              and e.diagnostic_metadata ? 'message_count'
            order by e.event_sequence desc limit 1) message_count
        from capture_ops.capture_operations o
        where o.workspace_id=$1 and o.safe_capture_reference=$2`, [this.workspaceId, safeCaptureReference]);
      if (result.rows.length !== 1) throw new Error("Safe capture reference did not resolve uniquely.");
      const row = result.rows[0]!;
      return {
        safe_capture_reference: String(row.safe_capture_reference),
        status: String(row.status),
        verification_status: row.verification_status === null ? null : String(row.verification_status),
        archive_manifest_sha256: String(row.archive_manifest_sha256),
        message_count: row.message_count === null ? null : Number(row.message_count),
        operation_ref: safeRef("operation", String(row.operation_id))
      };
    });
  }

  async statusSummary(): Promise<Record<string, unknown>> {
    return this.read(async (client) => {
      await client.query("set local statement_timeout = '5000ms'");
      await client.query("set local lock_timeout = '2000ms'");
      const operations = await client.query(`
        select operation_id,status,last_successful_stage,stuck,created_at
        from capture_ops.operation_status_report
        where workspace_id=$1
        order by created_at desc,operation_id asc
        limit 1
      `, [this.workspaceId]);

      const counts = await client.query(`
        select
          (select count(*) from memory_v1.messages where workspace_id=$1) messages,
          (select count(*) from memory_v1.content_blocks where workspace_id=$1) blocks,
          (select count(*) from memory_v1.knowledge_candidates
            where workspace_id=$1 and status='proposed') proposed,
          (select count(*) from memory_v1.approved_knowledge
            where workspace_id=$1) approved
      `, [this.workspaceId]);

      const attention = await client.query(`
        select
          (select count(*) from capture_ops.operation_status_report
            where workspace_id=$1
              and (status in ('needs_review','failed','interrupted') or stuck)) operation_issues,
          (select count(*) from memory_v1.quarantine_items
            where workspace_id=$1 and status='open') quarantine,
          (select count(*) from memory_v1.contradictions
            where workspace_id=$1 and status<>'resolved') contradictions
      `, [this.workspaceId]);

      const operationRows = operations.rows.map((row) => ({
        ...omitIds(row),
        operation_ref: safeRef("operation", String(row.operation_id))
      }));

      const attentionRow = numericRow(attention.rows[0] ?? {});
      const needsYou =
        Number(attentionRow.operation_issues ?? 0)
        + Number(attentionRow.quarantine ?? 0)
        + Number(attentionRow.contradictions ?? 0);

      return {
        mode: "read_only",
        generated_at: new Date().toISOString(),
        operations: operationRows,
        memory: numericRow(counts.rows[0] ?? {}),
        needs_you: needsYou,
        review_queue_state: "deferred_from_fast_status"
      };
    });
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return this.read(async (client) => {
      const operations = await client.query(`select operation_id,status,platform,operation_type,last_event_sequence,last_event_type,last_event_at,
          last_successful_stage,capture_started,identity_verified,collector_delivery_succeeded,archive_started,
          archive_created,verification_finished,safe_capture_reference,stop_reason_code,stop_summary,retry_safe,
          parent_operation_id,retry_operation_id,final_source_component,stuck,created_at
          from capture_ops.operation_status_report where workspace_id=$1 order by created_at desc limit 50`, [this.workspaceId]);
      const events = await client.query(`select operation_id,event_sequence,event_type,event_timestamp,operation_status,source_component,diagnostic_metadata,event_sha256
          from capture_ops.capture_operation_events where workspace_id=$1 order by event_timestamp desc,event_sequence desc limit 2000`, [this.workspaceId]);
      const imports = await client.query("select * from memory_v1.import_report where workspace_id=$1 order by pipeline_version", [this.workspaceId]);
      const counts = await client.query(`select
          (select count(*) from memory_v1.source_systems where workspace_id=$1) sources,
          (select count(*) from memory_v1.conversations where workspace_id=$1) conversations,
          (select count(*) from memory_v1.capture_versions where workspace_id=$1) capture_versions,
          (select count(*) from memory_v1.messages where workspace_id=$1) messages,
          (select count(*) from memory_v1.content_blocks where workspace_id=$1) blocks,
          (select count(*) from memory_v1.message_range_chunks where workspace_id=$1) chunks,
          (select count(*) from memory_v1.trusted_knowledge_candidates where workspace_id=$1) candidates,
          (select count(*) from memory_v1.trusted_provenance_edges where workspace_id=$1) provenance,
          (select count(*) from memory_v1.ingestion_runs where workspace_id=$1) ingestion_runs,
          (select count(*) from memory_v1.ingestion_checkpoints where workspace_id=$1) checkpoints,
          (select count(*) from memory_v1.quarantine_items where workspace_id=$1 and status='open') quarantine,
          (select count(*) from memory_v1.proof_receipts where workspace_id=$1) proofs,
          (select count(*) from memory_v1.approved_knowledge where workspace_id=$1) approved,
          (select count(*) from memory_v1.knowledge_candidates where workspace_id=$1 and status='proposed') proposed,
          (select count(*) from memory_v1.contradictions where workspace_id=$1 and status<>'resolved') contradictions,
          (select count(*) from memory_v1.supersessions where workspace_id=$1) supersessions`, [this.workspaceId]);
      const reviews = await client.query(PENDING_REVIEWS_SQL, [this.workspaceId]);
      const activity = await client.query(`select
          (select max(last_event_at) from capture_ops.operation_status_report where workspace_id=$1) latest_operation,
          (select max(captured_at) from memory_v1.capture_versions where workspace_id=$1) latest_capture,
          (select max(started_at) from memory_v1.ingestion_runs where workspace_id=$1) latest_ingestion,
          (select max(created_at) from memory_v1.proof_receipts where workspace_id=$1) latest_proof,
          (select max(occurred_at) from memory_v1.human_review_events where workspace_id=$1) latest_review`, [this.workspaceId]);
      const safeOperations = operations.rows.map((row) => {
        const operationEvents = events.rows.filter((event) => event.operation_id === row.operation_id);
        const metadata = operationEvents.map((event) => event.diagnostic_metadata as Record<string, unknown> | null)
          .filter((value): value is Record<string, unknown> => Boolean(value));
        return {
          ...omitIds(row), operation_ref: safeRef("operation", String(row.operation_id)),
          parent_ref: row.parent_operation_id ? safeRef("operation", String(row.parent_operation_id)) : null,
          retry_ref: row.retry_operation_id ? safeRef("operation", String(row.retry_operation_id)) : null,
          pairing_state: pairingState(row),
          message_count: lastMetadata(metadata, "message_count"),
          archive_state: row.archive_created ? "completed" : row.archive_started ? "started" : "not_started",
          verification_state: lastMetadata(metadata, "verification_status")
            ?? (row.verification_finished ? "completed" : "not_started"),
          comparison_state: "not_recorded"
        };
      });
      const safeEvents = events.rows.map((row) => ({
        ...omitIds(row), operation_ref: safeRef("operation", String(row.operation_id)),
        event_hash: String(row.event_sha256)
      }));
      const safeReviews = reviews.rows.map((row) => ({
        kind: row.kind, item_ref: safeRef(String(row.kind), String(row.raw_id)),
        status: row.status, detail: row.detail, occurred_at: row.occurred_at
      }));
      const needsYou = operations.rows.filter((row) => ["needs_review", "failed", "interrupted"].includes(String(row.status)) || Boolean(row.stuck)).length
        + safeReviews.filter((row) => row.kind !== "capture_operation_review").length;
      return {
        mode: "read_only",
        generated_at: new Date().toISOString(),
        operations: safeOperations,
        events: safeEvents,
        imports: imports.rows.map(stripPrivateLocators),
        memory: numericRow(counts.rows[0] ?? {}),
        reviews: safeReviews,
        activity: activity.rows[0] ?? {},
        needs_you: needsYou
      };
    });
  }

  async search(input: SearchInput): Promise<Record<string, unknown>[]> {
    const text = input.text?.trim().slice(0, 200) ?? "";
    if (!text && !input.role && !input.verification_status) return [];
    return this.read(async (client) => {
      const result = await client.query(`with records as (
        select 'message' record_type,m.message_id record_id,m.capture_version_id,m.sequence,m.role,
          rep->>'representation_kind' representation_kind,rep->>'value' value,rep->>'sha256' representation_sha256
        from memory_v1.messages m cross join lateral jsonb_array_elements(m.representations) rep
        where m.workspace_id=$1
        union all
        select 'block',b.content_block_id,b.capture_version_id,b.sequence,m.role,
          rep->>'representation_kind',rep->>'value',rep->>'sha256'
        from memory_v1.content_blocks b join memory_v1.messages m
          on (m.workspace_id,m.message_id)=(b.workspace_id,b.message_id)
        cross join lateral jsonb_array_elements(b.representations) rep
        where b.workspace_id=$1
      )
      select r.*,c.manifest_sha256,c.verification_status
      from records r join memory_v1.capture_versions c
        on (c.workspace_id,c.capture_version_id)=($1,r.capture_version_id)
      where ($2='' or r.value ilike '%' || $2 || '%')
        and ($3='' or r.record_type=$3) and ($4='' or r.role=$4)
        and ($5='' or c.verification_status=$5)
      order by r.sequence limit 100`, [
        this.workspaceId, text, input.record_type ?? "", input.role ?? "", input.verification_status ?? ""
      ]);
      return result.rows.map((row) => ({
        record_type: row.record_type,
        record_ref: safeRef(String(row.record_type), String(row.record_id)),
        capture_ref: safeRef("capture", String(row.capture_version_id)),
        sequence: Number(row.sequence),
        role: row.role,
        representation_kind: row.representation_kind,
        exact_text: row.value,
        representation_sha256: row.representation_sha256,
        archive_manifest_sha256: row.manifest_sha256,
        verification_status: row.verification_status,
        evidence_tier: "raw_evidence"
      }));
    });
  }

  /**
   * Approved-tier knowledge. Without text this lists approved knowledge; with
   * text the proven approved-knowledge query supplies the matches and this
   * annotates each item with the provenance lines that matched.
   */
  async approvedKnowledge(input: ApprovedKnowledgeInput): Promise<Record<string, unknown>> {
    const text = input.text?.trim().slice(0, 200) ?? "";
    return this.read(async (client) => {
      const listed = await client.query(APPROVED_KNOWLEDGE_LIST_SQL, [this.workspaceId]);
      const matchesByKnowledge = new Map<string, Record<string, unknown>[]>();
      if (text) {
        const matched = await client.query(APPROVED_KNOWLEDGE_QUERY_SQL, [this.workspaceId, text, 200]);
        for (const row of matched.rows) {
          const key = String(row.approved_knowledge_id);
          const lines = matchesByKnowledge.get(key) ?? [];
          if (lines.length < 3) {
            lines.push({
              sequence: Number(row.sequence),
              role: row.role,
              exact_text: row.text_value,
              message_ref: safeRef("message", String(row.message_id)),
              conversation_ref: safeRef("conversation", String(row.conversation_id)),
              capture_ref: safeRef("capture", String(row.capture_version_id)),
              provenance_edge_ref: safeRef("provenance_edge", String(row.provenance_edge_id)),
              representation_kind: row.representation_kind,
              representation_sha256: row.representation_sha256,
              archive_locator: row.immutable_archive_locator
            });
          }
          matchesByKnowledge.set(key, lines);
        }
      }
      const items = listed.rows
        .filter((row) => !text || matchesByKnowledge.has(String(row.approved_knowledge_id)))
        .map((row) => {
          const value = (row.approved_value ?? {}) as Record<string, unknown>;
          return {
            knowledge_ref: safeRef("approved_knowledge", String(row.approved_knowledge_id)),
            candidate_ref: safeRef("knowledge_candidate", String(row.knowledge_candidate_id)),
            kind: row.kind,
            value_shape: typeof value.statement === "string" ? "statement" : String(value.candidate_type ?? "structured_value"),
            statement: approvedStatement(value),
            pipeline_version: row.pipeline_version,
            approved_at: row.approved_at,
            reviewer_id: row.reviewer_id,
            review_status: row.review_status,
            review_rationale: row.rationale,
            reviewed_at: row.reviewed_at,
            approved_value_sha256: row.approved_value_sha256,
            evidence_tier: "approved_knowledge",
            provenance: {
              provenance_edge_count: Number(row.provenance_edge_count ?? 0),
              capture_ref: row.capture_version_id ? safeRef("capture", String(row.capture_version_id)) : null,
              archive_locator: row.immutable_archive_locator ?? null,
              conversation_ref: row.conversation_id ? safeRef("conversation", String(row.conversation_id)) : null,
              source_conversation_id: row.source_conversation_id ?? null,
              message_ref: row.message_id ? safeRef("message", String(row.message_id)) : null,
              first_sequence: row.sequence === null || row.sequence === undefined ? null : Number(row.sequence),
              role: row.role ?? null,
              representation_kind: row.representation_kind ?? null,
              representation_sha256: row.representation_sha256 ?? null,
              excerpt: excerpt(row.text_value)
            },
            matches: matchesByKnowledge.get(String(row.approved_knowledge_id)) ?? []
          };
        });
      return { mode: "read_only", tier: "approved_knowledge", query_text_used: Boolean(text), total: items.length, items };
    });
  }

  private async read<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin read only");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [this.workspaceId]);
      const role = await client.query("select current_user");
      if (role.rows[0]?.current_user !== "memory_v1_report_login") throw new Error("Mission Control requires the report-reader login.");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  }
}

/**
 * Human-readable rendering of an approved value without inventing content.
 * Distilled candidates carry a statement; message-range candidates describe the
 * exact preserved range they approved.
 */
export function approvedStatement(value: Record<string, unknown>): string {
  if (typeof value.statement === "string" && value.statement.trim()) return value.statement;
  if (value.candidate_type === "message_range") {
    const count = Array.isArray(value.message_ids) ? value.message_ids.length : 0;
    return `Approved message range ${value.start_sequence}–${value.end_sequence} (${count} messages) of the preserved capture.`;
  }
  return JSON.stringify(value).slice(0, 400);
}

function excerpt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}

export function safeRef(kind: string, value: string): string {
  return `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function omitIds(row: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set(["operation_id", "correlation_id", "parent_operation_id", "retry_operation_id"]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !blocked.has(key)));
}

function stripPrivateLocators(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.includes("locator") && !key.endsWith("_id") && key !== "workspace_name"));
}

function numericRow(row: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function pairingState(row: Record<string, unknown>): string {
  if (row.status === "prepared" && !row.capture_started) return "pairing_ready";
  if (row.status === "failed" && String(row.last_event_type).startsWith("pairing_")) return "pairing_failed";
  if (row.stuck) return "stuck_capture";
  return "not_pairing";
}

function lastMetadata(rows: Record<string, unknown>[], key: string): unknown {
  for (let index = rows.length - 1; index >= 0; index--) {
    const value = rows[index]?.[key];
    if (value !== undefined) return value;
  }
  return null;
}
