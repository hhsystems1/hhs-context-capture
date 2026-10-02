import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationClassification, ConversationObservation, ImmutableCaptureReference, InventoryRun, ReviewStatus } from "@hhs/inventory-schema";
import { isVerifiedCompleteInventory, projectImmutableCaptureReference, stableJson, validateInventoryIntegrity } from "@hhs/inventory-schema";

export const CATALOG_SCHEMA_VERSION = "0.1.0";

export interface ClassificationDecision {
  classification: ConversationClassification;
  reason_codes: string[];
  inventory_id: string;
  observation_id?: string;
  decided_at: string;
}

export interface CatalogConversation {
  catalog_key: string;
  platform_id: string;
  opaque_account_reference: string;
  conversation_id: string;
  platform_conversation_id?: string;
  title: string;
  source_url?: string;
  first_observed_at: string;
  last_observed_at: string;
  last_observation_fingerprint: string;
  last_inventory_id: string;
  review_status: ReviewStatus;
  classification: ClassificationDecision;
  capture_versions: ImmutableCaptureReference[];
}

export interface CatalogInventoryRecord {
  inventory_id: string;
  platform_id: string;
  opaque_account_reference: string;
  status: InventoryRun["status"];
  completed_at: string;
  snapshot_sha256: string;
  transaction_id: string;
}

export interface CatalogState {
  schema_version: typeof CATALOG_SCHEMA_VERSION;
  revision: number;
  applied_transactions: string[];
  inventories: Record<string, CatalogInventoryRecord>;
  conversations: Record<string, CatalogConversation>;
}

export interface ApplyInventoryResult {
  transaction_id: string;
  applied: boolean;
  revision: number;
  classifications: Record<string, ConversationClassification>;
}

interface InventoryTransaction {
  transaction_id: string;
  kind: "apply_inventory";
  created_at: string;
  inventory: InventoryRun;
  capture_references: ImmutableCaptureReference[];
  transaction_sha256: string;
}

interface ReconcileCapturesTransaction {
  transaction_id: string;
  kind: "reconcile_captures";
  created_at: string;
  reconciliation_id: string;
  platform_id: string;
  opaque_account_reference: string;
  capture_references: ImmutableCaptureReference[];
  transaction_sha256: string;
}

type CatalogTransaction = InventoryTransaction | ReconcileCapturesTransaction;

export interface ReconcileCapturesResult {
  transaction_id: string;
  applied: boolean;
  revision: number;
  added_capture_ids: string[];
  already_present_capture_ids: string[];
  unmatched_capture_ids: string[];
}

export class FileCatalog {
  readonly root: string;
  private readonly statePath: string;
  private readonly transactionRoot: string;
  private readonly lockPath: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.statePath = path.join(this.root, "catalog.json");
    this.transactionRoot = path.join(this.root, "transactions");
    this.lockPath = path.join(this.root, ".catalog.lock");
  }

  async initialize(): Promise<void> {
    await mkdir(this.transactionRoot, { recursive: true });
    await this.withLock(async () => {
      let state = await this.readStateUnsafe();
      const transactionFiles = (await readdir(this.transactionRoot)).filter((name) => name.endsWith(".json")).sort();
      for (const name of transactionFiles) {
        const transaction = JSON.parse(await readFile(path.join(this.transactionRoot, name), "utf8")) as CatalogTransaction;
        validateTransaction(transaction);
        if (!state.applied_transactions.includes(transaction.transaction_id)) state = applyTransaction(state, transaction);
      }
      await this.writeStateUnsafe(state);
    });
  }

  async read(): Promise<CatalogState> {
    return this.readStateUnsafe();
  }

  async applyInventory(inventory: InventoryRun, captureReferences: ImmutableCaptureReference[] = []): Promise<ApplyInventoryResult> {
    const failures = validateInventoryIntegrity(inventory);
    if (failures.length > 0) throw new Error(`Inventory integrity validation failed: ${failures.join(", ")}`);
    validateCaptureReferences(inventory, captureReferences);
    await mkdir(this.transactionRoot, { recursive: true });
    const transactionId = `inventory:${inventory.inventory_id}:${inventory.snapshot_sha256}`;
    const transactionBase = { transaction_id: transactionId, kind: "apply_inventory" as const, created_at: inventory.completed_at, inventory, capture_references: captureReferences };
    const transaction: InventoryTransaction = { ...transactionBase, transaction_sha256: hash(stableJson(transactionBase)) };
    await writeExclusiveOrVerify(path.join(this.transactionRoot, `${hash(transactionId)}.json`), transaction);

    return this.withLock(async () => {
      const state = await this.readStateUnsafe();
      if (state.applied_transactions.includes(transactionId)) return resultFor(state, transactionId, false, inventory);
      const next = applyTransaction(state, transaction);
      await this.writeStateUnsafe(next);
      return resultFor(next, transactionId, true, inventory);
    });
  }

  async reconcileCaptureReferences(input: { reconciliation_id: string; platform_id: string; opaque_account_reference: string; created_at: string; capture_references: ImmutableCaptureReference[] }): Promise<ReconcileCapturesResult> {
    validateStandaloneCaptureReferences(input.capture_references);
    await mkdir(this.transactionRoot, { recursive: true });
    const transactionId = `reconcile:${input.reconciliation_id}:${hash(stableJson(input.capture_references))}`;
    const base = { transaction_id: transactionId, kind: "reconcile_captures" as const, ...input };
    const transaction: ReconcileCapturesTransaction = { ...base, transaction_sha256: hash(stableJson(base)) };
    await writeExclusiveOrVerify(path.join(this.transactionRoot, `${hash(transactionId)}.json`), transaction);
    return this.withLock(async () => {
      const state = await this.readStateUnsafe();
      if (state.applied_transactions.includes(transactionId)) return reconciliationResult(state, state, transaction, false);
      const next = applyTransaction(state, transaction);
      await this.writeStateUnsafe(next);
      return reconciliationResult(state, next, transaction, true);
    });
  }

  private async readStateUnsafe(): Promise<CatalogState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as CatalogState;
      if (state.schema_version !== CATALOG_SCHEMA_VERSION) throw new Error(`Unsupported catalog schema ${state.schema_version}.`);
      return normalizeCatalogState(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyState();
    }
  }

  private async writeStateUnsafe(state: CatalogState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.statePath);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const handle = await this.acquireLock();
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      return await action();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }

  private async acquireLock(): Promise<Awaited<ReturnType<typeof open>>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await open(this.lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = await readLock(this.lockPath);
        if (lock && processIsActive(lock.pid)) throw new Error(`Catalog is locked by active process ${lock.pid}.`, { cause: error });
        await rm(this.lockPath, { force: true });
      }
    }
    throw new Error("Could not acquire the catalog transaction lock after stale-lock recovery.");
  }
}

function applyTransaction(state: CatalogState, transaction: CatalogTransaction): CatalogState {
  validateTransaction(transaction);
  if (state.applied_transactions.includes(transaction.transaction_id)) return state;
  if (transaction.kind === "reconcile_captures") return applyReconciliationTransaction(state, transaction);
  const inventory = transaction.inventory;
  const next = structuredClone(state);
  const seen = new Set<string>();
  const capturesByConversation = new Map<string, ImmutableCaptureReference[]>();
  for (const capture of transaction.capture_references) {
    const group = capturesByConversation.get(capture.conversation_id) ?? [];
    group.push(capture);
    capturesByConversation.set(capture.conversation_id, group);
  }

  for (const observation of inventory.observations) {
    const key = catalogKey(inventory.platform.platform_id, inventory.account.opaque_account_reference, observation.conversation_id);
    if (seen.has(key)) throw new Error(`Duplicate conversation identity in inventory: ${observation.conversation_id}`);
    seen.add(key);
    const existing = next.conversations[key];
    const decision = classifyObserved(inventory, observation, existing);
    const captureVersions = mergeCaptureVersions(existing?.capture_versions ?? [], capturesByConversation.get(observation.conversation_id) ?? []);
    next.conversations[key] = {
      catalog_key: key,
      platform_id: inventory.platform.platform_id,
      opaque_account_reference: inventory.account.opaque_account_reference,
      conversation_id: observation.conversation_id,
      ...(observation.platform_conversation_id === undefined ? {} : { platform_conversation_id: observation.platform_conversation_id }),
      title: observation.title,
      ...(observation.source_url === undefined ? {} : { source_url: observation.source_url }),
      first_observed_at: existing?.first_observed_at ?? observation.observed_at,
      last_observed_at: observation.observed_at,
      last_observation_fingerprint: observation.observation_fingerprint,
      last_inventory_id: inventory.inventory_id,
      review_status: decision.classification === "needs_review" ? "needs_review" : observation.review_status,
      classification: decision,
      capture_versions: captureVersions
    };
  }

  if (isVerifiedCompleteInventory(inventory)) {
    for (const [key, conversation] of Object.entries(next.conversations)) {
      if (conversation.platform_id !== inventory.platform.platform_id || conversation.opaque_account_reference !== inventory.account.opaque_account_reference || seen.has(key)) continue;
      conversation.classification = {
        classification: "missing",
        reason_codes: ["not_observed_in_verified_complete_inventory", "retained_not_deleted"],
        inventory_id: inventory.inventory_id,
        decided_at: inventory.completed_at
      };
    }
  }

  next.revision += 1;
  next.applied_transactions.push(transaction.transaction_id);
  next.inventories[inventory.inventory_id] = {
    inventory_id: inventory.inventory_id,
    platform_id: inventory.platform.platform_id,
    opaque_account_reference: inventory.account.opaque_account_reference,
    status: inventory.status,
    completed_at: inventory.completed_at,
    snapshot_sha256: inventory.snapshot_sha256,
    transaction_id: transaction.transaction_id
  };
  return next;
}

function applyReconciliationTransaction(state: CatalogState, transaction: ReconcileCapturesTransaction): CatalogState {
  const next = structuredClone(state);
  for (const reference of transaction.capture_references) {
    const conversation = Object.values(next.conversations).find((item) => item.platform_id === transaction.platform_id && item.opaque_account_reference === transaction.opaque_account_reference && item.conversation_id === reference.conversation_id);
    if (!conversation) continue;
    conversation.capture_versions = mergeCaptureVersions(conversation.capture_versions, [reference]);
  }
  next.revision += 1;
  next.applied_transactions.push(transaction.transaction_id);
  return next;
}

function classifyObserved(inventory: InventoryRun, observation: ConversationObservation, existing: CatalogConversation | undefined): ClassificationDecision {
  const common = { inventory_id: inventory.inventory_id, observation_id: observation.observation_id, decided_at: inventory.completed_at };
  if (!isVerifiedCompleteInventory(inventory) || observation.review_status === "needs_review") {
    const reasons = observation.review_reasons.length > 0 ? observation.review_reasons : ["inventory_not_verified_complete"];
    return { ...common, classification: "needs_review", reason_codes: reasons };
  }
  if (!existing) return { ...common, classification: "new", reason_codes: ["first_stable_observation"] };
  const latestCapture = existing.capture_versions.at(-1);
  if (existing.last_observation_fingerprint === observation.observation_fingerprint && latestCapture?.status === "complete") {
    return { ...common, classification: "unchanged", reason_codes: ["inventory_fingerprint_matches", "latest_capture_verified_complete"] };
  }
  const reasons = existing.last_observation_fingerprint === observation.observation_fingerprint
    ? ["no_verified_complete_capture_for_unchanged_claim"]
    : ["inventory_fingerprint_changed"];
  return { ...common, classification: "possibly_changed", reason_codes: reasons };
}

function mergeCaptureVersions(existing: ImmutableCaptureReference[], incoming: ImmutableCaptureReference[]): ImmutableCaptureReference[] {
  const merged = existing.map((item) => projectImmutableCaptureReference(item));
  for (const rawCapture of incoming) {
    const capture = projectImmutableCaptureReference(rawCapture);
    const prior = merged.find((item) => item.capture_id === capture.capture_id);
    if (prior && stableJson(prior) !== stableJson(capture)) throw new Error(`Immutable capture reference conflict: ${capture.capture_id}`);
    if (!prior) merged.push(capture);
  }
  return merged.sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.capture_id.localeCompare(b.capture_id));
}

function normalizeCatalogState(state: CatalogState): CatalogState {
  const normalized = structuredClone(state);
  for (const conversation of Object.values(normalized.conversations)) {
    conversation.capture_versions = mergeCaptureVersions(conversation.capture_versions, []);
  }
  return normalized;
}

function validateCaptureReferences(inventory: InventoryRun, captures: ImmutableCaptureReference[]): void {
  const conversations = new Set(inventory.observations.map((item) => item.conversation_id));
  for (const capture of captures) {
    if (!conversations.has(capture.conversation_id)) throw new Error(`Capture ${capture.capture_id} does not belong to an observed conversation.`);
    if (!/^[a-f0-9]{64}$/.test(capture.manifest_sha256)) throw new Error(`Capture ${capture.capture_id} has an invalid manifest hash.`);
    for (const [messageId, messageHash] of Object.entries(capture.message_hashes)) {
      if (!messageId || !/^[a-f0-9]{64}$/.test(messageHash)) throw new Error(`Capture ${capture.capture_id} has an invalid message hash.`);
    }
  }
}

function validateTransaction(transaction: CatalogTransaction): void {
  const { transaction_sha256, ...payload } = transaction;
  if (hash(stableJson(payload)) !== transaction_sha256) throw new Error(`Transaction hash verification failed: ${transaction.transaction_id}`);
  if (transaction.kind === "apply_inventory") {
    const failures = validateInventoryIntegrity(transaction.inventory);
    if (failures.length > 0) throw new Error(`Journaled inventory failed integrity validation: ${failures.join(", ")}`);
  } else {
    validateStandaloneCaptureReferences(transaction.capture_references);
  }
}

async function writeExclusiveOrVerify(destination: string, transaction: CatalogTransaction): Promise<void> {
  const serialized = `${JSON.stringify(transaction, null, 2)}\n`;
  try {
    const handle = await open(destination, "wx");
    try { await handle.writeFile(serialized); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(destination, "utf8")) as CatalogTransaction;
    if (stableJson(existing) !== stableJson(transaction)) throw new Error(`Transaction identity collision: ${transaction.transaction_id}`, { cause: error });
  }
}

function validateStandaloneCaptureReferences(captures: ImmutableCaptureReference[]): void {
  const seen = new Map<string, ImmutableCaptureReference>();
  for (const capture of captures) {
    if (!capture.capture_id || !capture.conversation_id || !capture.archive_path) throw new Error("Capture reconciliation reference is incomplete.");
    if (!/^[a-f0-9]{64}$/.test(capture.manifest_sha256)) throw new Error(`Capture ${capture.capture_id} has an invalid manifest hash.`);
    for (const [messageId, messageHash] of Object.entries(capture.message_hashes)) {
      if (!messageId || !/^[a-f0-9]{64}$/.test(messageHash)) throw new Error(`Capture ${capture.capture_id} has an invalid message hash.`);
    }
    const prior = seen.get(capture.capture_id);
    if (prior && stableJson(prior) !== stableJson(capture)) throw new Error(`Duplicate immutable capture ID conflict: ${capture.capture_id}`);
    seen.set(capture.capture_id, capture);
  }
}

function reconciliationResult(before: CatalogState, after: CatalogState, transaction: ReconcileCapturesTransaction, applied: boolean): ReconcileCapturesResult {
  const added: string[] = [];
  const present: string[] = [];
  const unmatched: string[] = [];
  for (const reference of transaction.capture_references) {
    const beforeConversation = Object.values(before.conversations).find((item) => item.platform_id === transaction.platform_id && item.opaque_account_reference === transaction.opaque_account_reference && item.conversation_id === reference.conversation_id);
    const afterConversation = Object.values(after.conversations).find((item) => item.platform_id === transaction.platform_id && item.opaque_account_reference === transaction.opaque_account_reference && item.conversation_id === reference.conversation_id);
    if (!afterConversation) unmatched.push(reference.capture_id);
    else if (beforeConversation?.capture_versions.some((item) => item.capture_id === reference.capture_id)) present.push(reference.capture_id);
    else added.push(reference.capture_id);
  }
  return { transaction_id: transaction.transaction_id, applied, revision: after.revision, added_capture_ids: added, already_present_capture_ids: present, unmatched_capture_ids: unmatched };
}

function resultFor(state: CatalogState, transactionId: string, applied: boolean, inventory: InventoryRun): ApplyInventoryResult {
  const classifications: Record<string, ConversationClassification> = {};
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.platform_id === inventory.platform.platform_id && conversation.opaque_account_reference === inventory.account.opaque_account_reference && conversation.classification.inventory_id === inventory.inventory_id) {
      classifications[conversation.conversation_id] = conversation.classification.classification;
    }
  }
  return { transaction_id: transactionId, applied, revision: state.revision, classifications };
}

function catalogKey(platformId: string, accountReference: string, conversationId: string): string {
  return hash(stableJson([platformId, accountReference, conversationId]));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyState(): CatalogState {
  return { schema_version: CATALOG_SCHEMA_VERSION, revision: 0, applied_transactions: [], inventories: {}, conversations: {} };
}

async function readLock(lockPath: string): Promise<{ pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? { pid: value.pid } : undefined;
  } catch {
    return undefined;
  }
}

function processIsActive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
