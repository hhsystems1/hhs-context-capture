/**
 * Knowledge Extraction V1 CLI.
 *
 * Usage:
 *   tsx --env-file=.env.memory-v1.local scripts/extract-knowledge.ts \
 *     --proposals <path.json> [--dry-run]
 *
 * The proposals file is the (LLM-authored) ExtractionInput. This CLI never
 * trusts it: every quote is re-validated verbatim against ingested verified
 * evidence and hash-checked before any candidate is written, and all written
 * candidates are status='proposed' awaiting human review.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { runExtraction, type ExtractionInput } from "../apps/memory-ingest/src/extraction.js";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
const workspaceId = process.env.MEMORY_WORKSPACE_ID?.trim();
if (!workspaceId) throw new Error("MEMORY_WORKSPACE_ID is required.");
const input = JSON.parse(readFileSync(path.resolve(arg("proposals")), "utf8")) as ExtractionInput;
const result = await runExtraction({ workspaceId, input, dryRun: process.argv.includes("--dry-run") });
console.log(JSON.stringify(result, null, 2));
if (result.issues.length) process.exit(1);
