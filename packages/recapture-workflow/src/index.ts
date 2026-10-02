import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type RecaptureState = "selected" | "awaiting_manual_open" | "identity_verified" | "awaiting_capture_confirmation" | "authorized" | "capturing" | "archive_written" | "archive_verified" | "comparing" | "catalog_committed" | "complete" | "needs_review" | "failed" | "cancelled" | "expired";

export interface RecaptureSelection {
  platform_id: string;
  opaque_account_reference: string;
  conversation_id: string;
  title: string;
  source_url: string;
}

export interface RecaptureIntent extends RecaptureSelection {
  intent_id: string;
  state: RecaptureState;
  created_at: string;
  expires_at: string;
  confirmed_at?: string;
  capture_id?: string;
  comparison_id?: string;
  failure_reason?: string;
  history: Array<{ at: string; from?: RecaptureState; to: RecaptureState; reason: string }>;
}

interface RecaptureStateFile {
  schema_version: "0.1.0";
  revision: number;
  intents: Record<string, RecaptureIntent>;
  last_capture_attempt_at?: string;
}

export class FileRecaptureWorkflow {
  private readonly statePath: string;
  private readonly eventsPath: string;

  constructor(readonly root: string, readonly cooldownMs = 30_000, readonly intentTtlMs = 15 * 60_000) {
    this.root = path.resolve(root);
    this.statePath = path.join(this.root, "recapture-state.json");
    this.eventsPath = path.join(this.root, "events.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try { await readFile(this.statePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeState({ schema_version: "0.1.0", revision: 0, intents: {} });
    }
  }

  async createIntent(selection: RecaptureSelection, now = new Date()): Promise<RecaptureIntent> {
    await this.expireUnused(now);
    const state = await this.readState();
    const createdAt = now.toISOString();
    const intent: RecaptureIntent = {
      ...selection,
      intent_id: randomUUID(),
      state: "awaiting_manual_open",
      created_at: createdAt,
      expires_at: new Date(now.getTime() + this.intentTtlMs).toISOString(),
      history: [{ at: createdAt, to: "selected", reason: "catalog_record_manually_selected" }, { at: createdAt, from: "selected", to: "awaiting_manual_open", reason: "automatic_navigation_prohibited" }]
    };
    state.intents[intent.intent_id] = intent;
    await this.persist(state, intent, "intent_created");
    return structuredClone(intent);
  }

  async verifyActiveIdentity(intentId: string, active: Pick<RecaptureSelection, "platform_id" | "opaque_account_reference" | "conversation_id">, now = new Date()): Promise<RecaptureIntent> {
    await this.expireUnused(now);
    return this.transition(intentId, now, ["awaiting_manual_open", "identity_verified", "awaiting_capture_confirmation"], (intent) => {
      if (intent.platform_id !== active.platform_id || intent.opaque_account_reference !== active.opaque_account_reference || intent.conversation_id !== active.conversation_id) throw new Error("Active conversation identity does not match the manually selected catalog record.");
      move(intent, "identity_verified", now, "active_tab_identity_matches_selection");
      move(intent, "awaiting_capture_confirmation", now, "explicit_confirmation_required");
    });
  }

  async confirm(intentId: string, exactConfirmation: boolean, now = new Date()): Promise<RecaptureIntent> {
    if (!exactConfirmation) throw new Error("Explicit one-capture confirmation is required.");
    await this.expireUnused(now);
    return this.transition(intentId, now, ["awaiting_capture_confirmation"], (intent, state) => {
      if (state.last_capture_attempt_at && now.getTime() - new Date(state.last_capture_attempt_at).getTime() < this.cooldownMs) throw new Error("Conservative recapture cooldown is still active.");
      intent.confirmed_at = now.toISOString();
      move(intent, "authorized", now, "user_confirmed_exactly_one_capture");
    });
  }

  async beginCapture(intentId: string, active: Pick<RecaptureSelection, "platform_id" | "opaque_account_reference" | "conversation_id">, now = new Date()): Promise<RecaptureIntent> {
    await this.expireUnused(now);
    return this.transition(intentId, now, ["authorized"], (intent, state) => {
      if (intent.platform_id !== active.platform_id || intent.opaque_account_reference !== active.opaque_account_reference || intent.conversation_id !== active.conversation_id) throw new Error("Active identity changed after confirmation; capture prohibited.");
      state.last_capture_attempt_at = now.toISOString();
      move(intent, "capturing", now, "single_foreground_capture_started");
    });
  }

  async checkpoint(intentId: string, next: Exclude<RecaptureState, "selected" | "awaiting_manual_open" | "identity_verified" | "awaiting_capture_confirmation" | "authorized" | "capturing" | "expired">, detail: { capture_id?: string; comparison_id?: string; failure_reason?: string } = {}, now = new Date()): Promise<RecaptureIntent> {
    const allowed: Record<string, RecaptureState[]> = {
      archive_written: ["capturing"], archive_verified: ["archive_written"], comparing: ["archive_verified"], catalog_committed: ["comparing"], complete: ["catalog_committed"], needs_review: ["archive_verified", "comparing", "catalog_committed"], failed: ["capturing", "archive_written", "archive_verified", "comparing"], cancelled: ["awaiting_manual_open", "identity_verified", "awaiting_capture_confirmation", "authorized"]
    };
    return this.transition(intentId, now, allowed[next] ?? [], (intent) => {
      Object.assign(intent, detail);
      move(intent, next, now, detail.failure_reason ?? `checkpoint_${next}`);
    });
  }

  async get(intentId: string): Promise<RecaptureIntent | undefined> {
    return structuredClone((await this.readState()).intents[intentId]);
  }

  async cancel(intentId: string, reason = "user_cancelled_unused_intent", now = new Date()): Promise<RecaptureIntent> {
    if (!reason.trim()) throw new Error("Cancellation reason is required.");
    return this.transition(intentId, now, ["awaiting_manual_open", "identity_verified", "awaiting_capture_confirmation", "authorized"], (intent) => move(intent, "cancelled", now, reason));
  }

  async expireUnused(now = new Date()): Promise<RecaptureIntent[]> {
    const state = await this.readState();
    const eligible = new Set<RecaptureState>(["awaiting_manual_open", "identity_verified", "awaiting_capture_confirmation", "authorized"]);
    const expired = Object.values(state.intents).filter((intent) => eligible.has(intent.state) && new Date(intent.expires_at).getTime() < now.getTime());
    if (expired.length === 0) return [];
    const events: string[] = [];
    for (const intent of expired) {
      move(intent, "expired", now, "intent_ttl_elapsed_without_capture");
      state.revision += 1;
      events.push(JSON.stringify({ event_id: randomUUID(), event: "intent_expired", intent_id: intent.intent_id, state: intent.state, at: now.toISOString() }));
    }
    await appendFile(this.eventsPath, `${events.join("\n")}\n`, { encoding: "utf8", flag: "a" });
    await this.writeState(state);
    return structuredClone(expired);
  }

  private async transition(intentId: string, now: Date, allowed: RecaptureState[], action: (intent: RecaptureIntent, state: RecaptureStateFile) => void): Promise<RecaptureIntent> {
    const state = await this.readState();
    const intent = state.intents[intentId];
    if (!intent) throw new Error("Unknown recapture intent.");
    if (!allowed.includes(intent.state)) throw new Error(`Recapture transition prohibited from ${intent.state}.`);
    action(intent, state);
    await this.persist(state, intent, "state_transition");
    return structuredClone(intent);
  }

  private async readState(): Promise<RecaptureStateFile> { return JSON.parse(await readFile(this.statePath, "utf8")) as RecaptureStateFile; }

  private async persist(state: RecaptureStateFile, intent: RecaptureIntent, event: string): Promise<void> {
    state.revision += 1;
    await appendFile(this.eventsPath, `${JSON.stringify({ event_id: randomUUID(), event, intent_id: intent.intent_id, state: intent.state, at: intent.history.at(-1)?.at ?? intent.created_at })}\n`, { encoding: "utf8", flag: "a" });
    await this.writeState(state);
  }

  private async writeState(state: RecaptureStateFile): Promise<void> {
    const temporary = path.join(this.root, `.recapture-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.statePath);
  }
}

function move(intent: RecaptureIntent, to: RecaptureState, now: Date, reason: string): void {
  const from = intent.state;
  intent.state = to;
  intent.history.push({ at: now.toISOString(), from, to, reason });
}
