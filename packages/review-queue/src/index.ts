import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureComparison, MessageChangeRecord } from "@hhs/capture-comparison";
import { sha256, stableJson } from "@hhs/capture-versioning";

export type ReviewItemStatus = "open" | "acknowledged" | "resolved" | "accepted_uncertainty";

export interface ReviewQueueItem {
  review_id: string;
  status: ReviewItemStatus;
  severity: "material" | "warning";
  reason_codes: string[];
  platform_id: string;
  opaque_account_reference: string;
  conversation_id: string;
  source_kind?: "comparison" | "capture_verification";
  comparison_id?: string;
  capture_id?: string;
  prior_capture_id?: string;
  current_capture_id?: string;
  change_record_id?: string;
  prior_message_id?: string;
  current_message_id?: string;
  evidence_hashes: string[];
  created_at: string;
  history: Array<{ at: string; action: string; note?: string }>;
  item_sha256: string;
}

interface QueueState {
  schema_version: "0.1.0";
  revision: number;
  items: Record<string, ReviewQueueItem>;
  applied_events: string[];
  applied_transactions?: string[];
}

export interface CaptureVerificationReviewInput {
  capture_id: string;
  conversation_id: string;
  reason_codes: string[];
  evidence_hashes: string[];
}

export interface CaptureVerificationReviewTransaction {
  transaction_id: string;
  platform_id: string;
  opaque_account_reference: string;
  created_at: string;
  items: CaptureVerificationReviewInput[];
}

export interface CaptureVerificationReviewResult {
  transaction_id: string;
  transaction_sha256: string;
  applied: boolean;
  revision: number;
  created_review_ids: string[];
  already_present_review_ids: string[];
}

export interface ReviewContext {
  platform_id: string;
  opaque_account_reference: string;
  conversation_id: string;
  created_at: string;
}

export class FileReviewQueue {
  private readonly statePath: string;
  private readonly eventPath: string;
  private readonly transactionRoot: string;
  private readonly lockPath: string;

  constructor(readonly root: string) {
    this.root = path.resolve(root);
    this.statePath = path.join(this.root, "review-queue.json");
    this.eventPath = path.join(this.root, "events.jsonl");
    this.transactionRoot = path.join(this.root, "transactions");
    this.lockPath = path.join(this.root, ".review.lock");
  }

  async initialize(): Promise<void> {
    await mkdir(this.transactionRoot, { recursive: true });
    try { await readFile(this.statePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeState(emptyState());
    }
  }

  async enqueueComparison(comparison: CaptureComparison, context: ReviewContext): Promise<ReviewQueueItem[]> {
    const uncertain = comparison.records.filter((record) => record.classification === "uncertain");
    const records: Array<MessageChangeRecord | undefined> = uncertain.length > 0 ? uncertain : comparison.status === "needs_review" ? [undefined] : [];
    const state = await this.readState();
    const added: ReviewQueueItem[] = [];
    for (const record of records) {
      const reviewId = sha256(stableJson([comparison.comparison_id, record?.record_id ?? "comparison", record?.reason_codes ?? comparison.warnings])).slice(0, 32);
      if (state.items[reviewId]) { added.push(state.items[reviewId]); continue; }
      const base = {
        review_id: reviewId,
        status: "open" as const,
        severity: "material" as const,
        source_kind: "comparison" as const,
        reason_codes: record?.reason_codes ?? comparison.warnings,
        platform_id: context.platform_id,
        opaque_account_reference: context.opaque_account_reference,
        conversation_id: context.conversation_id,
        comparison_id: comparison.comparison_id,
        prior_capture_id: comparison.prior_capture_id,
        current_capture_id: comparison.current_capture_id,
        ...(record ? { change_record_id: record.record_id } : {}),
        ...(record?.prior_message_id ? { prior_message_id: record.prior_message_id } : {}),
        ...(record?.current_message_id ? { current_message_id: record.current_message_id } : {}),
        evidence_hashes: [record?.prior_summary_sha256, record?.current_summary_sha256].filter((value): value is string => Boolean(value)),
        created_at: context.created_at,
        history: [{ at: context.created_at, action: "created_from_comparison" }]
      };
      const item: ReviewQueueItem = { ...base, item_sha256: sha256(stableJson(base)) };
      state.items[reviewId] = item;
      state.revision += 1;
      const eventId = `enqueue:${reviewId}`;
      state.applied_events.push(eventId);
      await appendFile(this.eventPath, `${JSON.stringify({ event_id: eventId, item })}\n`, { encoding: "utf8", flag: "a" });
      added.push(item);
    }
    await this.writeState(state);
    return added;
  }

  async enqueueCaptureVerifications(input: CaptureVerificationReviewTransaction): Promise<CaptureVerificationReviewResult> {
    validateCaptureVerificationTransaction(input);
    await mkdir(this.transactionRoot, { recursive: true });
    const transactionBase = { kind: "capture_verification_reviews" as const, ...input };
    const transactionSha256 = sha256(stableJson(transactionBase));
    const transaction = { ...transactionBase, transaction_sha256: transactionSha256 };
    const transactionPath = path.join(this.transactionRoot, `${sha256(input.transaction_id)}.json`);
    await writeExclusiveOrVerify(transactionPath, transaction);
    return this.withLock(async () => {
      const state = await this.readState();
      state.applied_transactions ??= [];
      const reviewIds = input.items.map((item) => captureVerificationReviewId(item));
      if (state.applied_transactions.includes(input.transaction_id)) {
        return { transaction_id: input.transaction_id, transaction_sha256: transactionSha256, applied: false, revision: state.revision, created_review_ids: [], already_present_review_ids: reviewIds };
      }
      const created: string[] = [];
      const alreadyPresent: string[] = [];
      for (const source of input.items) {
        const reviewId = captureVerificationReviewId(source);
        const existing = state.items[reviewId];
        if (existing) {
          if (existing.capture_id !== source.capture_id || stableJson(existing.reason_codes) !== stableJson(source.reason_codes)) throw new Error(`Immutable review item conflict: ${reviewId}`);
          alreadyPresent.push(reviewId);
          continue;
        }
        const base = {
          review_id: reviewId,
          status: "open" as const,
          severity: "material" as const,
          source_kind: "capture_verification" as const,
          reason_codes: [...source.reason_codes],
          platform_id: input.platform_id,
          opaque_account_reference: input.opaque_account_reference,
          conversation_id: source.conversation_id,
          capture_id: source.capture_id,
          evidence_hashes: [...source.evidence_hashes],
          created_at: input.created_at,
          history: [{ at: input.created_at, action: "created_from_capture_verification" }]
        };
        state.items[reviewId] = { ...base, item_sha256: sha256(stableJson(base)) };
        state.revision += 1;
        created.push(reviewId);
      }
      state.applied_transactions.push(input.transaction_id);
      await this.writeState(state);
      return { transaction_id: input.transaction_id, transaction_sha256: transactionSha256, applied: true, revision: state.revision, created_review_ids: created, already_present_review_ids: alreadyPresent };
    });
  }

  async read(): Promise<QueueState> { return this.readState(); }

  private async readState(): Promise<QueueState> {
    return JSON.parse(await readFile(this.statePath, "utf8")) as QueueState;
  }

  private async writeState(state: QueueState): Promise<void> {
    const temporary = path.join(this.root, `.review-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.statePath);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const handle = await open(this.lockPath, "wx");
    try { return await action(); }
    finally { await handle.close(); await rm(this.lockPath, { force: true }); }
  }
}

function emptyState(): QueueState {
  return { schema_version: "0.1.0", revision: 0, items: {}, applied_events: [], applied_transactions: [] };
}

function validateCaptureVerificationTransaction(input: CaptureVerificationReviewTransaction): void {
  if (!input.transaction_id || !input.platform_id || !input.opaque_account_reference || !input.created_at || input.items.length === 0) throw new Error("Capture verification review transaction is incomplete.");
  const captureIds = input.items.map((item) => item.capture_id);
  if (new Set(captureIds).size !== captureIds.length) throw new Error("Capture verification transaction contains duplicate capture IDs.");
  for (const item of input.items) if (!item.capture_id || !item.conversation_id || item.reason_codes.length === 0 || item.reason_codes.some((reason) => !reason)) throw new Error("Capture verification review item is incomplete.");
}

function captureVerificationReviewId(item: CaptureVerificationReviewInput): string {
  return sha256(stableJson(["capture_verification", item.capture_id, item.reason_codes])).slice(0, 32);
}

async function writeExclusiveOrVerify(destination: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(destination, serialized, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(destination, "utf8")) as unknown;
    if (stableJson(existing) !== stableJson(value)) throw new Error(`Review transaction identity collision: ${destination}`, { cause: error });
  }
}
