import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileRecaptureWorkflow } from "./index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("single manually confirmed recapture workflow", () => {
  it("requires matching active identity and explicit confirmation, then resumes from disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-recapture-")); roots.push(root);
    const workflow = new FileRecaptureWorkflow(root, 30_000); await workflow.initialize();
    const selection = { platform_id: "chatgpt", opaque_account_reference: "opaque-account", conversation_id: "conversation-1", title: "Selected", source_url: "https://chatgpt.com/c/conversation-1" };
    const intent = await workflow.createIntent(selection, new Date("2026-07-18T00:00:00Z"));
    await expect(workflow.verifyActiveIdentity(intent.intent_id, { ...selection, conversation_id: "wrong" }, new Date("2026-07-18T00:00:01Z"))).rejects.toThrow("does not match");
    await workflow.verifyActiveIdentity(intent.intent_id, selection, new Date("2026-07-18T00:00:02Z"));
    await expect(workflow.confirm(intent.intent_id, false, new Date("2026-07-18T00:00:03Z"))).rejects.toThrow("Explicit");
    await workflow.confirm(intent.intent_id, true, new Date("2026-07-18T00:00:04Z"));
    const started = await workflow.beginCapture(intent.intent_id, selection, new Date("2026-07-18T00:00:05Z"));
    expect(started.state).toBe("capturing");
    const resumed = new FileRecaptureWorkflow(root); await resumed.initialize();
    expect((await resumed.get(intent.intent_id))?.state).toBe("capturing");
  });

  it("contains no browser navigation primitive or batch loop", async () => {
    const source = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/location\s*=|window\.open|tabs\.update|\.click\s*\(|setInterval/);
    const contentSource = await readFile(fileURLToPath(new URL("../../../apps/browser-extension/src/content.ts", import.meta.url)), "utf8");
    const backgroundSource = await readFile(fileURLToPath(new URL("../../../apps/browser-extension/src/background.ts", import.meta.url)), "utf8");
    expect(`${contentSource}\n${backgroundSource}`).not.toMatch(/chrome\.tabs\.(update|create)|window\.open|location\.(assign|replace)\s*\(/);
  });

  it("append-only expires every unused intent exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-recapture-")); roots.push(root);
    const workflow = new FileRecaptureWorkflow(root, 30_000, 60_000); await workflow.initialize();
    const selection = { platform_id: "chatgpt", opaque_account_reference: "opaque-account", conversation_id: "conversation-1", title: "Selected", source_url: "https://chatgpt.com/c/conversation-1" };
    const intent = await workflow.createIntent(selection, new Date("2026-07-18T00:00:00Z"));
    const first = await workflow.expireUnused(new Date("2026-07-18T00:01:01Z"));
    const repeated = await workflow.expireUnused(new Date("2026-07-18T00:02:00Z"));
    expect(first.map((item) => item.intent_id)).toEqual([intent.intent_id]);
    expect(repeated).toEqual([]);
    expect((await workflow.get(intent.intent_id))?.state).toBe("expired");
    const events = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "intent_expired")).toHaveLength(1);
  });

  it("append-only cancels an unused intent and prohibits later capture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-recapture-")); roots.push(root);
    const workflow = new FileRecaptureWorkflow(root); await workflow.initialize();
    const selection = { platform_id: "chatgpt", opaque_account_reference: "opaque-account", conversation_id: "conversation-1", title: "Selected", source_url: "https://chatgpt.com/c/conversation-1" };
    const intent = await workflow.createIntent(selection, new Date("2026-07-18T00:00:00Z"));
    const cancelled = await workflow.cancel(intent.intent_id, "operator_cancelled_duplicate_prepare", new Date("2026-07-18T00:00:01Z"));
    expect(cancelled.state).toBe("cancelled");
    await expect(workflow.verifyActiveIdentity(intent.intent_id, selection, new Date("2026-07-18T00:00:02Z"))).rejects.toThrow("prohibited from cancelled");
  });

  it("expires an authorized intent before a late capture can begin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-recapture-")); roots.push(root);
    const workflow = new FileRecaptureWorkflow(root, 30_000, 60_000); await workflow.initialize();
    const selection = { platform_id: "chatgpt", opaque_account_reference: "opaque-account", conversation_id: "conversation-1", title: "Selected", source_url: "https://chatgpt.com/c/conversation-1" };
    const intent = await workflow.createIntent(selection, new Date("2026-07-18T00:00:00Z"));
    await workflow.verifyActiveIdentity(intent.intent_id, selection, new Date("2026-07-18T00:00:10Z"));
    await workflow.confirm(intent.intent_id, true, new Date("2026-07-18T00:00:20Z"));
    await expect(workflow.beginCapture(intent.intent_id, selection, new Date("2026-07-18T00:01:01Z"))).rejects.toThrow("prohibited from expired");
    expect((await workflow.get(intent.intent_id))?.state).toBe("expired");
  });
});
