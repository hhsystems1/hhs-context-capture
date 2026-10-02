import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type VerifiedCaptureHandoff = {
  capture_id: string;
  manifest_sha256: string;
  archive_reference: string;
  workspace_id: string;
  verification_status: "complete";
  requested_pipeline: string;
  idempotency_key: string;
};

type Delivery = {
  status: "pending" | "retrying" | "delivered" | "delivery_failed";
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  handoff_id: string | null;
  parent_job_id: string | null;
  ingest_job_id: string | null;
};

type HandoffRecord = VerifiedCaptureHandoff & {
  schema_version: "hhs.knowledge-pipeline-handoff.v1";
  delivery: Delivery;
};

export function knowledgeHandoffIdempotencyKey(input: Pick<VerifiedCaptureHandoff,
  "capture_id" | "manifest_sha256" | "workspace_id" | "requested_pipeline">): string {
  const identity = [input.capture_id, input.manifest_sha256, input.workspace_id, input.requested_pipeline].join("\n");
  return `knowledge-handoff:v1:${createHash("sha256").update(identity).digest("hex")}`;
}

export class KnowledgePipelineHandoffOutbox {
  private readonly directory: string;

  constructor(private readonly options: {
    archiveRoot: string;
    endpoint?: string;
    serviceToken?: string;
    workspaceId: string;
    requestedPipeline: string;
    maxDeliveryAttempts?: number;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.directory = path.join(options.archiveRoot, "operations", "knowledge-pipeline-handoffs");
  }

  async enqueue(input: {
    captureId: string;
    manifestSha256: string;
    archiveReference: string;
    verificationStatus: string;
  }): Promise<HandoffRecord> {
    if (input.verificationStatus !== "complete") throw new Error("Only complete verified captures may enter the knowledge pipeline handoff.");
    const identity = {
      capture_id: input.captureId,
      manifest_sha256: input.manifestSha256,
      archive_reference: input.archiveReference,
      workspace_id: this.options.workspaceId,
      verification_status: "complete" as const,
      requested_pipeline: this.options.requestedPipeline,
    };
    const idempotencyKey = knowledgeHandoffIdempotencyKey(identity);
    const file = this.fileFor(idempotencyKey);
    await mkdir(this.directory, { recursive: true });

    let record: HandoffRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as HandoffRecord;
      if (!this.sameIdentity(record, identity)) throw new Error("Existing handoff idempotency key has a different immutable identity.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      record = {
        schema_version: "hhs.knowledge-pipeline-handoff.v1",
        ...identity,
        idempotency_key: idempotencyKey,
        delivery: {
          status: "pending", attempts: 0, next_attempt_at: null, last_error: null,
          handoff_id: null, parent_job_id: null, ingest_job_id: null,
        },
      };
      await this.write(file, record);
    }

    return this.deliver(file, record);
  }

  async flush(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
    for (const name of files) {
      const file = path.join(this.directory, name);
      const record = JSON.parse(await readFile(file, "utf8")) as HandoffRecord;
      if (record.delivery.status === "delivered" || record.delivery.status === "delivery_failed") continue;
      if (record.delivery.next_attempt_at && Date.parse(record.delivery.next_attempt_at) > this.now().getTime()) continue;
      await this.deliver(file, record);
    }
  }

  private async deliver(file: string, record: HandoffRecord): Promise<HandoffRecord> {
    if (record.delivery.status === "delivered" || record.delivery.status === "delivery_failed") return record;
    if (!this.options.endpoint || !this.options.serviceToken) return record;

    const attempts = record.delivery.attempts + 1;
    try {
      const response = await (this.options.fetchImpl || fetch)(this.options.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.serviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          capture_id: record.capture_id,
          manifest_sha256: record.manifest_sha256,
          archive_reference: record.archive_reference,
          workspace_id: record.workspace_id,
          verification_status: record.verification_status,
          requested_pipeline: record.requested_pipeline,
          idempotency_key: record.idempotency_key,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HHS Core returned HTTP ${response.status}`);
      record.delivery = {
        status: "delivered", attempts, next_attempt_at: null, last_error: null,
        handoff_id: String(body.handoff_id || ""), parent_job_id: String(body.parent_job_id || ""),
        ingest_job_id: String(body.ingest_job_id || ""),
      };
    } catch (error) {
      const max = this.options.maxDeliveryAttempts ?? 20;
      const terminal = attempts >= max;
      const delayMinutes = Math.min(30, 2 ** Math.max(0, attempts - 1));
      record.delivery = {
        ...record.delivery,
        status: terminal ? "delivery_failed" : "retrying",
        attempts,
        next_attempt_at: terminal ? null : new Date(this.now().getTime() + delayMinutes * 60_000).toISOString(),
        last_error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.write(file, record);
    return record;
  }

  private sameIdentity(record: HandoffRecord, input: Omit<VerifiedCaptureHandoff, "idempotency_key">): boolean {
    return record.capture_id === input.capture_id
      && record.manifest_sha256 === input.manifest_sha256
      && record.archive_reference === input.archive_reference
      && record.workspace_id === input.workspace_id
      && record.verification_status === input.verification_status
      && record.requested_pipeline === input.requested_pipeline;
  }

  private fileFor(key: string): string {
    return path.join(this.directory, `${key.slice("knowledge-handoff:v1:".length)}.json`);
  }

  private now(): Date { return (this.options.now || (() => new Date()))(); }

  private async write(file: string, record: HandoffRecord): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }
}
