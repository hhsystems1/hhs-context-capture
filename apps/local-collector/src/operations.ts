import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OPERATION_EVENT_SCHEMA_VERSION, OPERATION_RECEIPT_SCHEMA_VERSION, OPERATION_SCHEMA_VERSION,
  validateAppendEvent, validateCreateOperation, type AppendOperationEventInput, type CreateOperationInput,
  type OperationEventType, type OperationStatusReport, type SafeDiagnosticMetadata, type SourceComponent
} from "@hhs/capture-operations";
import { idempotencyKey, sha256 } from "@hhs/memory-schema";
import pg from "pg";

const { Pool } = pg;

export interface CaptureOperationStoreConfig {
  workspaceId: string;
  writerDatabaseUrl: string;
  readerDatabaseUrl: string;
  operationsRoot: string;
}

export interface StoredOperationEvent {
  operationEventId: string;
  eventSha256: string;
  operationStatus: string;
  replayed: boolean;
  receiptRelativeLocator: string;
}

export class CaptureOperationStore {
  readonly workspaceId: string;
  readonly operationsRoot: string;
  private readonly writer: pg.Pool;
  private readonly reader: pg.Pool;

  constructor(config: CaptureOperationStoreConfig) {
    this.workspaceId = config.workspaceId;
    this.operationsRoot = path.resolve(config.operationsRoot);
    assertLocalDatabaseUrl(config.writerDatabaseUrl);
    assertLocalDatabaseUrl(config.readerDatabaseUrl);
    this.writer = new Pool({ connectionString: config.writerDatabaseUrl, max: 4, application_name: "hhs-capture-operations-writer" });
    this.reader = new Pool({ connectionString: config.readerDatabaseUrl, max: 4, application_name: "hhs-capture-operations-reader" });
  }

  async close(): Promise<void> {
    await Promise.all([this.writer.end(), this.reader.end()]);
  }

  async create(input: CreateOperationInput, createdAt = new Date().toISOString()): Promise<OperationStatusReport> {
    validateCreateOperation(input);
    const operationIdempotency = idempotencyKey("capture_operation", this.workspaceId, [
      input.operation_id, input.correlation_id, input.platform, input.opaque_account_reference,
      input.opaque_conversation_reference ?? null, input.operation_type, input.parent_operation_id ?? null
    ]);
    const createdEventIdempotency = eventIdempotency(input.operation_id, 1, "operation_created");
    await this.writerTransaction(async (client) => {
      await client.query("select capture_ops.create_capture_operation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [
        this.workspaceId, input.operation_id, input.correlation_id, input.platform,
        input.opaque_account_reference, input.opaque_conversation_reference ?? null, input.operation_type,
        input.source_component, input.parent_operation_id ?? null, createdAt,
        operationIdempotency, createdEventIdempotency
      ]);
    });
    await this.ensureReceipt(input.operation_id, 1);
    return this.get(input.operation_id);
  }

  async append(input: AppendOperationEventInput): Promise<StoredOperationEvent> {
    const metadata = validateAppendEvent(input);
    const row = await this.writerTransaction(async (client) => (await client.query(
      "select * from capture_ops.append_operation_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
        this.workspaceId, input.operation_id, input.correlation_id, input.event_type,
        input.event_sequence, input.event_timestamp, input.source_component, metadata,
        OPERATION_EVENT_SCHEMA_VERSION, input.idempotency_key, input.event_sha256 ?? null
      ]
    )).rows[0]);
    const receiptRelativeLocator = await this.ensureReceipt(input.operation_id, input.event_sequence);
    return {
      operationEventId: String(row?.operation_event_id),
      eventSha256: String(row?.event_sha256),
      operationStatus: String(row?.operation_status),
      replayed: Boolean(row?.replayed),
      receiptRelativeLocator
    };
  }

  async appendNext(operationId: string, eventType: OperationEventType, sourceComponent: SourceComponent, metadata: SafeDiagnosticMetadata = {}, timestamp = new Date().toISOString()): Promise<StoredOperationEvent> {
    const identity = await this.readerTransaction(async (client) => (await client.query(
      "select correlation_id,current_event_sequence from capture_ops.capture_operations where workspace_id=$1 and operation_id=$2",
      [this.workspaceId, operationId]
    )).rows[0]);
    if (!identity) throw new Error("Capture operation does not exist.");
    const sequence = Number(identity.current_event_sequence) + 1;
    return this.append({
      operation_id: operationId,
      correlation_id: String(identity.correlation_id),
      event_type: eventType,
      event_sequence: sequence,
      event_timestamp: timestamp,
      source_component: sourceComponent,
      metadata,
      idempotency_key: eventIdempotency(operationId, sequence, eventType)
    });
  }

  async reconcile(operationId: string, timeoutSeconds = 900, at = new Date().toISOString()): Promise<OperationStatusReport> {
    await this.writerTransaction(async (client) => {
      await client.query("select capture_ops.reconcile_interrupted_operation($1,$2,$3,$4,$5)", [
        this.workspaceId, operationId, at, timeoutSeconds,
        idempotencyKey("capture_operation_reconciliation", this.workspaceId, [operationId, at, timeoutSeconds])
      ]);
    });
    const report = await this.get(operationId);
    await this.ensureReceipt(operationId, report.last_event_sequence);
    return report;
  }

  async get(operationId: string): Promise<OperationStatusReport> {
    const row = await this.readerTransaction(async (client) => (await client.query(
      "select * from capture_ops.operation_status_report where workspace_id=$1 and operation_id=$2",
      [this.workspaceId, operationId]
    )).rows[0]);
    if (!row) throw new Error("Capture operation report was not found.");
    return mapReport(row);
  }

  async latest(): Promise<OperationStatusReport | null> {
    const row = await this.readerTransaction(async (client) => (await client.query(
      "select * from capture_ops.latest_operation_report where workspace_id=$1", [this.workspaceId]
    )).rows[0]);
    return row ? mapReport(row) : null;
  }

  async list(includeTerminal = true): Promise<OperationStatusReport[]> {
    const rows = await this.readerTransaction(async (client) => (await client.query(
      `select * from capture_ops.operation_status_report where workspace_id=$1
       and ($2::boolean or status not in ('completed','needs_review','failed','interrupted','canceled'))
       order by created_at desc`, [this.workspaceId, includeTerminal]
    )).rows);
    return rows.map(mapReport);
  }

  private async ensureReceipt(operationId: string, sequence: number): Promise<string> {
    const event = await this.readerTransaction(async (client) => (await client.query(
      `select e.*,o.platform,o.operation_type from capture_ops.capture_operation_events e
       join capture_ops.capture_operations o using(workspace_id,operation_id)
       where e.workspace_id=$1 and e.operation_id=$2 and e.event_sequence=$3`,
      [this.workspaceId, operationId, sequence]
    )).rows[0]);
    if (!event) throw new Error("Authoritative operation event was not found for receipt creation.");
    const operationSegment = safeSegment(operationId);
    const leaf = `${String(sequence).padStart(6, "0")}-${String(event.event_sha256).slice(0, 16)}`;
    const relative = path.posix.join("events", operationSegment, leaf);
    const parent = containedPath(this.operationsRoot, "events", operationSegment);
    const destination = containedPath(this.operationsRoot, ...relative.split("/"));
    await mkdir(parent, { recursive: true });
    const receipt = {
      schema_version: OPERATION_RECEIPT_SCHEMA_VERSION,
      workspace_id: this.workspaceId,
      operation_id: operationId,
      correlation_id: event.correlation_id,
      operation_event_id: event.operation_event_id,
      platform: event.platform,
      operation_type: event.operation_type,
      event_type: event.event_type,
      event_sequence: Number(event.event_sequence),
      event_timestamp: new Date(event.event_timestamp).toISOString(),
      operation_status: event.operation_status,
      source_component: event.source_component,
      diagnostic_metadata: event.diagnostic_metadata,
      event_sha256: event.event_sha256,
      idempotency_key: event.idempotency_key
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const receiptSha256 = digest(receiptBytes);
    const manifest = {
      schema_version: "hhs.capture-operation-manifest/1.0.0",
      operation_event_id: event.operation_event_id,
      files: [{ path: "receipt.json", bytes: receiptBytes.length, sha256: receiptSha256 }]
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestSha256 = digest(manifestBytes);
    const hashIndex = `${receiptSha256}  receipt.json\n${manifestSha256}  manifest.json\n`;
    let destinationExists = false;
    try {
      await verifyReceiptDirectory(destination);
      if (digest(await readFile(path.join(destination, "receipt.json"))) !== receiptSha256) throw new Error("Existing operation receipt conflicts with the authoritative event.");
      destinationExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!destinationExists) {
      const staging = containedPath(parent, `.tmp-${randomUUID()}`);
      await mkdir(staging, { recursive: false });
      await writeFile(path.join(staging, "receipt.json"), receiptBytes, { flag: "wx" });
      await writeFile(path.join(staging, "manifest.json"), manifestBytes, { flag: "wx" });
      await writeFile(path.join(staging, "hashes.sha256"), hashIndex, { flag: "wx" });
      await verifyReceiptDirectory(staging);
      await rename(staging, destination);
    }
    const receiptId = `operation_receipt_${digest(Buffer.from(`${this.workspaceId}:${event.operation_event_id}`, "utf8")).slice(0, 32)}`;
    const body = {
      workspace_id: this.workspaceId,
      operation_receipt_id: receiptId,
      operation_id: operationId,
      operation_event_id: event.operation_event_id,
      receipt_relative_locator: relative,
      receipt_sha256: receiptSha256,
      manifest_sha256: manifestSha256,
      schema_version: OPERATION_RECEIPT_SCHEMA_VERSION,
      idempotency_key: idempotencyKey("capture_operation_receipt", this.workspaceId, event.operation_event_id),
      created_at: new Date(event.created_at).toISOString()
    };
    await this.writerTransaction(async (client) => {
      await client.query("select capture_ops.register_operation_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        this.workspaceId, receiptId, operationId, event.operation_event_id, relative,
        receiptSha256, manifestSha256, body.idempotency_key, sha256(body)
      ]);
    });
    return relative;
  }

  private async writerTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.writer, this.workspaceId, false, callback);
  }

  private async readerTransaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.reader, this.workspaceId, true, callback);
  }
}

export function operationStoreFromEnvironment(archiveRoot: string): CaptureOperationStore {
  return new CaptureOperationStore({
    workspaceId: required("MEMORY_WORKSPACE_ID"),
    writerDatabaseUrl: required("MEMORY_INGEST_DATABASE_URL"),
    readerDatabaseUrl: required("MEMORY_REPORT_DATABASE_URL"),
    operationsRoot: path.join(archiveRoot, "operations", "capture-operations-v1")
  });
}

export function eventIdempotency(operationId: string, sequence: number, eventType: OperationEventType): string {
  return idempotencyKey("capture_operation_event", "capture-operations-v1", [operationId, sequence, eventType]);
}

async function transaction<T>(pool: pg.Pool, workspaceId: string, readOnly: boolean, callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "begin read only" : "begin");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

function mapReport(row: Record<string, unknown>): OperationStatusReport {
  return {
    operation_id: String(row.operation_id),
    correlation_id: String(row.correlation_id),
    status: String(row.status) as OperationStatusReport["status"],
    platform: String(row.platform),
    operation_type: String(row.operation_type) as OperationStatusReport["operation_type"],
    last_event_sequence: Number(row.last_event_sequence),
    last_event_type: String(row.last_event_type) as OperationStatusReport["last_event_type"],
    last_event_at: new Date(String(row.last_event_at)).toISOString(),
    last_successful_stage: String(row.last_successful_stage),
    capture_started: Boolean(row.capture_started),
    identity_verified: Boolean(row.identity_verified),
    collector_delivery_succeeded: Boolean(row.collector_delivery_succeeded),
    archive_started: Boolean(row.archive_started),
    archive_created: Boolean(row.archive_created),
    verification_finished: Boolean(row.verification_finished),
    safe_capture_reference: row.safe_capture_reference === null ? null : String(row.safe_capture_reference),
    stop_reason_code: row.stop_reason_code === null ? null : String(row.stop_reason_code),
    stop_summary: row.stop_summary === null ? null : String(row.stop_summary),
    retry_safe: Boolean(row.retry_safe),
    parent_operation_id: row.parent_operation_id === null ? null : String(row.parent_operation_id),
    retry_operation_id: row.retry_operation_id === null ? null : String(row.retry_operation_id),
    final_source_component: String(row.final_source_component) as OperationStatusReport["final_source_component"],
    stuck: Boolean(row.stuck)
  };
}

async function verifyReceiptDirectory(directory: string): Promise<void> {
  const lines = (await readFile(path.join(directory, "hashes.sha256"), "utf8")).trim().split(/\r?\n/);
  if (lines.length !== 2) throw new Error("Operation receipt hash index must contain two entries.");
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(receipt\.json|manifest\.json)$/.exec(line);
    if (!match?.[1] || !match[2] || digest(await readFile(path.join(directory, match[2]))) !== match[1]) throw new Error("Operation receipt hash verification failed.");
  }
}

function containedPath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Operation receipt path escaped its private root.");
  return resolved;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new Error("Unsafe operation receipt segment.");
  return safe;
}

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function assertLocalDatabaseUrl(value: string): void { const url = new URL(value); if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) throw new Error("Capture operations require local PostgreSQL."); }
export { OPERATION_SCHEMA_VERSION };
