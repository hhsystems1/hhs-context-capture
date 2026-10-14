import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DiscoveryExchange } from "./understanding-discovery.js";

// Append scheduling metadata only. Existing business ranks are never rewritten.
export async function registerCapturePriority(file: string, workspace: string, exchange: DiscoveryExchange) {
  let index: { workspace_id: string; conversations: Array<Record<string, unknown>>; [key: string]: unknown };
  try { index = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    index = { schema_version: "hhs-business-priority-index/1.0.0", workspace_id: workspace, conversations: [] };
  }
  if (index.workspace_id !== workspace || !Array.isArray(index.conversations)) throw new Error("Capture priority workspace mismatch.");
  let rank = 0;
  for (const entry of index.conversations) {
    const value = entry.unprocessed_queue_rank ?? entry.overall_priority_rank;
    if (!Number.isInteger(value) || Number(value) < 1) throw new Error("Existing priority rank is invalid.");
    rank = Math.max(rank, Number(value));
  }
  let changed = false;
  const additions: string[] = [];
  for (const source of exchange.selection) {
    if (index.conversations.some(row => row.source_conversation_id === source.source_conversation_id)) continue;
    index.conversations.push({
      source_conversation_id: source.source_conversation_id, source_version_id: source.source_version_id,
      title: source.title, source_family: source.source_family, evidence_issue: false,
      unprocessed_queue_rank: ++rank, priority_tier: "new_verified_capture",
      estimated_input_tokens: Math.ceil(source.content_characters / 3),
      priority_basis: "append_after_existing_ranks; targeted_processing_available"
    });
    additions.push(source.source_conversation_id);
    changed = true;
  }
  if (!changed) return;
  index.capture_intake_update = { registered_at: new Date().toISOString(), source_conversation_ids: additions,
    exchange_id: exchange.exchange_id, evidence_sha256: exchange.evidence_sha256,
    token_rule: "ceil(canonical_evidence_characters / 3)", original_plan_metadata_is_historical: true };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(index, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
