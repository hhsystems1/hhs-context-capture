/** Execute the existing entrypoints in an isolated VM with real temporary files.
 * Every model/subprocess is injected: no provider, database, env file, or runner
 * outside this test is invoked. Discovery validation uses the production validator.
 */
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { promisify } from "node:util";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonrepair } from "jsonrepair";
import { sha256 } from "@hhs/memory-schema";
import {
  UNDERSTANDING_DISCOVERY_PIPELINE_VERSION, UNDERSTANDING_INPUT_SCHEMA, UNDERSTANDING_OUTPUT_SCHEMA,
  validateDiscoveryOutput, type DiscoveryExchange, type DiscoveryEvidence, type DiscoveryOutput
} from "../apps/memory-ingest/src/understanding-discovery.js";

const SOURCE = "synthetic-source";
const WORKSPACE = "synthetic-workspace";
const MODEL = "synthetic-model";
const roots: string[] = [];
const { modelDiscoveryExchange, restoreModelEvidenceRefs, providerFailureCategory, providerRequestSignal, requestDiscoveryModel, modelLinkingObservations, restoreLinkingRefs, LINKING_REQUEST_VERSION, readStandardProviderFailure, standardProviderFailureCode } = await import(path.resolve("scripts/reconstruction-provider.mjs"));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "hhs-runner-unit-")); roots.push(value); return value; }
function put(directory: string, file: string, value: unknown): void {
  const destination = path.resolve(directory, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(value, null, 2) + "\n");
}
function get(directory: string, file: string): any { return JSON.parse(fs.readFileSync(path.resolve(directory, file), "utf8")); }
function providerAudit(directory: string): any {
  const folder = path.join(directory, '.runtime/reconstruction/priority-runs');
  const file = fs.readdirSync(folder).find(name => name.endsWith('-provider-attempts.json'))!;
  return get(folder, file);
}
function exchange(id = "exchange"): DiscoveryExchange {
  const text = `The assistant suggests documenting the workflow (${id}).`;
  const hash = sha256(text);
  const evidence: DiscoveryEvidence = {
    evidence_ref: `ev-${id}`, source_conversation_id: SOURCE, conversation_id: "conversation", source_family: "native_export",
    source_version_id: "version", capture_version_id: null, message_id: "message", source_message_id: "source-message",
    message_sequence: 0, role: "assistant", active_path: true, content_block_id: "block", block_kind: "text",
    representation_kind: "canonical_text", text, representation_sha256: hash, source_record_id: "record",
    immutable_evidence_locator: "fixture://message", source_record_sha256: hash, source_version_locator: "fixture://source",
    source_container_sha256: "a".repeat(64), capture_locator: null, capture_manifest_sha256: null,
    resolution_id: "resolution", resolution_expected_sha256: hash, resolution_observed_sha256: hash,
    resolution_exact: true, source_observed_at: "2026-01-01T00:00:00.000Z"
  };
  return {
    schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: id, evidence_sha256: sha256([evidence]), created_at: "2026-01-01T00:00:00.000Z",
    selection: [{ source_conversation_id: SOURCE, conversation_id: "conversation", title: "Synthetic",
      source_family: "native_export", observed_at: evidence.source_observed_at, message_count: 1,
      content_characters: text.length, source_version_id: "version", content_sha256: hash,
      immutable_source_locator: "fixture://source", source_container_sha256: "a".repeat(64),
      capture_version_id: null, capture_manifest_sha256: null, capture_locator: null }], evidence: [evidence],
    model_instructions: { output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
      link_kinds_are_free_text: true, evidence_refs_are_authoritative: true, evidence_excerpts_are_optional: true,
      user_authority_requires_user_evidence: true, database_ids_or_hashes_required: false, model_metadata_required: false }
  };
}
function output(input = exchange(), forbidden = false): DiscoveryOutput {
  return { schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: input.exchange_id, observations: [{
    observation_ref: "o1", source_conversation_id: SOURCE, observation_kind: "finding",
    statement: forbidden ? "The user requires documenting the workflow." : input.evidence[0]!.text,
    payload: {}, attribution: { subject: "assistant", claim_type: "finding" }, confidence: 0.8,
    evidence: [{ evidence_ref: input.evidence[0]!.evidence_ref }] }], links: [] };
}
function receipt(attempt = 1): Record<string, unknown> { return { provider: "openrouter", model: MODEL,
  runner_version: "synthetic-runner/1", attempt, validated: true }; }
function argument(args: string[], name: string): string { return args[args.indexOf(`--${name}`) + 1]!; }
type Result = { status: number; stdout: string; stderr: string };
type Spawn = (command: string, args: string[], options: any) => Result;
function result(status = 0, value: unknown = {}): Result { return { status, stdout: JSON.stringify(value), stderr: status ? "synthetic failure" : "" }; }
function validate(directory: string, args: string[]): Result {
  const input = get(directory, argument(args, "exchange"));
  const candidate = get(directory, argument(args, "output"));
  const checked = validateDiscoveryOutput(input, candidate, { provider: "openrouter", name: MODEL, runner_version: "unit/1" });
  return result(checked.valid ? 0 : 1);
}
class ScriptExit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
async function run(directory: string, script: string, args: string[], spawnSync: Spawn,
  fetch: (url: string, options: any) => Promise<any> = async () => { throw new Error("Unexpected provider call"); },
  globals: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const resolve = (file: string) => path.resolve(directory, file);
  const pathMethods = new Set(["existsSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync", "mkdtempSync", "renameSync", "copyFileSync"]);
  const localFs = new Proxy(fs, { get(target, property: keyof typeof fs) {
    if (!pathMethods.has(String(property))) return target[property];
    return (...values: any[]) => {
      values[0] = resolve(values[0]);
      if (property === "renameSync" || property === "copyFileSync") values[1] = resolve(values[1]);
      return (target[property] as (...args: any[]) => any)(...values);
    };
  } });
  const fakeProcess = { argv: ["node", script, ...args], execPath: "node", pid: 123, cwd: () => directory,
    env: { OPENROUTER_API_KEY: "synthetic-key", MEMORY_WORKSPACE_ID: "untrusted-environment-workspace", MEMORY_REPORT_DATABASE_URL: "synthetic-report-url" }, exitCode: 0,
    exit: (code: number) => { throw new ScriptExit(code); }, stdout: { write: (value: string) => logs.push(value) },
    stderr: { write: (value: string) => logs.push(value) } };
  const original = fs.readFileSync(path.resolve("scripts", script), "utf8");
  const source = (script.endsWith(".ts") ? transpileModule(original, { compilerOptions: {
    module: ModuleKind.ESNext, target: ScriptTarget.ES2022
  } }).outputText : original).replace(/^import[\s\S]*?;\r?\n/gm, "");
  try {
    await vm.runInNewContext(`(async () => { ${source} })()`, {
      fs: localFs, path, spawnSync, jsonrepair, process: fakeProcess, Buffer, fetch,
      providerRequestSignal: () => providerRequestSignal(fakeProcess.env),
      modelDiscoveryExchange, restoreModelEvidenceRefs, providerFailureCategory, requestDiscoveryModel, modelLinkingObservations, restoreLinkingRefs, LINKING_REQUEST_VERSION, readStandardProviderFailure, standardProviderFailureCode,
      mkdir: (file: string, options: any) => mkdir(resolve(file), options),
      readFile: (file: string, options: any) => readFile(resolve(file), options),
      writeFile: (file: string, value: any, options: any) => writeFile(resolve(file), value, options),
      setTimeout: (callback: () => void) => callback(),
      console: { log: (...values: unknown[]) => logs.push(values.join(" ")), error: (...values: unknown[]) => logs.push(values.join(" ")) },
      ...globals
    }, { filename: script });
  } catch (error) { if (error instanceof ScriptExit) return { code: error.code, logs }; throw error; }
  return { code: fakeProcess.exitCode, logs };
}
const BASE = ".runtime/reconstruction/priority-runs/priority-0001-synthetic-source";
function priority(directory: string, oversized = false): void {
  put(directory, ".runtime/reconstruction/business-priority-index-v1.json", { conversations: [{
    source_conversation_id: SOURCE, title: "Synthetic", evidence_issue: false, unprocessed_queue_rank: 1,
    estimated_input_tokens: oversized ? 80000 : 100 }] });
}
function standardArtifacts(directory: string, forbidden = false): void {
  put(directory, `${BASE}-input.json`, exchange()); put(directory, `${BASE}-output.json`, output(exchange(), forbidden));
  put(directory, `${BASE}-openrouter-raw.json`, { model: MODEL });
}
function batchReceipt(directory: string): any {
  const files = fs.readdirSync(path.join(directory, ".runtime/reconstruction/batch-receipts")).filter((name) => name.endsWith(".json"));
  return get(directory, path.join(".runtime/reconstruction/batch-receipts", files.sort().at(-1)!));
}
function inventory(processed = false): Result { return result(0, { workspace_id: WORKSPACE, conversations: [{
  source_conversation_id: SOURCE, source_version_id: "version", capture_version_id: null, discovery_status: processed ? "discovery_processed" : "unprocessed" }] }); }
function persistResult(replay = false): Result { return result(0, { observations_inserted: replay ? 0 : 1,
  observation_links_inserted: 0, provenance_edges_inserted: replay ? 0 : 1, replay }); }
const BATCH_ARGS = ["--workspace", WORKSPACE];

describe("existing standard reconstruction runner retry/resume", () => {
  it("routes metadata-heavy low-estimate sources through the existing resumable chunk path", async () => {
    const directory = root(); priority(directory);
    const runDir = '.runtime/reconstruction/oversized-runs/priority-0001-synthetic-source';
    let chunkRuns = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes('scripts/reconstruction-inventory.ts')) {
        const value = JSON.parse(inventory().stdout); value.conversations[0].evidence_block_count = 1342; return result(0, value);
      }
      if (args.includes('export-chunks')) return result(0, { parent_exchange: exchange(), chunks: [{
        chunk_number: 1, chunk_count: 1, exchange: exchange(), evidence_characters: 500, exceeds_target: false }] });
      if (args.includes('scripts/run-oversized-orchestrator.mjs')) {
        chunkRuns++; put(directory, runDir + '/parent-output.json', output());
        put(directory, runDir + '/parent-model.json', receipt()); return result();
      }
      if (args.includes('validate')) return validate(directory, args);
      if (args.includes('persist')) return persistResult();
      throw new Error('Must not send this source as one standard model request');
    };
    expect((await run(directory, 'run-reconstruction-batch.mjs', BATCH_ARGS, spawn)).code).toBe(0);
    expect(chunkRuns).toBe(1); expect(batchReceipt(directory).completed[0].mode).toBe('oversized');
  });
  it("replays existing complete validated artifacts even when the new size policy would chunk the source", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const spawn: Spawn = (_command, args) => {
      if (args.includes('scripts/reconstruction-inventory.ts')) {
        const value = JSON.parse(inventory().stdout); value.conversations[0].evidence_block_count = 1342; return result(0, value);
      }
      if (args.includes('validate')) return validate(directory, args);
      if (args.includes('persist')) return persistResult(true);
      throw new Error('A safe persisted-artifact replay must not call a model or export new chunks');
    };
    expect((await run(directory, 'run-reconstruction-batch.mjs', BATCH_ARGS, spawn)).code).toBe(0);
    expect(batchReceipt(directory).completed[0]).toMatchObject({ mode: 'standard', replay: true });
  });
  it("keeps one shared source deadline and at most two outer generation attempts", async () => {
    const directory = root(); priority(directory); const deadlines: string[] = [];
    const spawn: Spawn = (_command, args, options) => {
      if (args.includes('scripts/reconstruction-inventory.ts')) return inventory();
      if (args.includes('scripts/run-next-priority-nemotron.mjs')) {
        deadlines.push(options.env.HHS_RECONSTRUCTION_DEADLINE_AT); return result(7);
      }
      throw new Error('Failed generation must not persist');
    };
    expect((await run(directory, 'run-reconstruction-batch.mjs', BATCH_ARGS, spawn)).code).toBe(2);
    expect(deadlines).toHaveLength(2); expect(new Set(deadlines).size).toBe(1);
    expect(Number(deadlines[0])).toBeGreaterThan(Date.now());
    expect(Number(deadlines[0])).toBeLessThanOrEqual(Date.now() + 480000);
  });
  it("budgets a multi-chunk source for its remaining requests while preserving completed chunks", async () => {
    const directory = root(); priority(directory, true);
    const runDir = '.runtime/reconstruction/oversized-runs/priority-0001-synthetic-source';
    put(directory, `${runDir}/parent-input.json`, exchange());
    put(directory, `${runDir}/manifest.json`, { chunks: Array.from({ length: 13 }, (_, index) => ({ chunk_number: index + 1 })) });
    put(directory, `${runDir}/chunk-001-output.json`, output());
    put(directory, `${runDir}/chunk-001-model.json`, receipt());
    let deadline = 0;
    const spawn: Spawn = (_command, args, options) => {
      if (args.includes('scripts/reconstruction-inventory.ts')) return inventory();
      if (args.includes('scripts/run-oversized-orchestrator.mjs')) { deadline = Number(options.env.HHS_RECONSTRUCTION_DEADLINE_AT); return result(7); }
      throw new Error('Failed generation must not persist');
    };
    expect((await run(directory, 'run-reconstruction-batch.mjs', BATCH_ARGS, spawn)).code).toBe(2);
    expect(deadline).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 40 * 60 * 1000);
    expect(get(directory, `${runDir}/chunk-001-model.json`)).toEqual(receipt());
  });
  it.each(["Error: standard validation failed after 3 attempts: unknown evidence reference", "Error: /usr/bin/node exited with status 10", "Error: Original user text is not fully represented by content blocks; repair source evidence before discovery.\n    at assertBrowserUserTextCoverage (/fixture/understanding-discovery.ts:784:13)\n    at prepareDiscoveryExchangeFromClient (/fixture/understanding-discovery.ts:235:5)"])("normal continuation preserves terminal content failures (%s)", async (reason) => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const heldPath = ".runtime/reconstruction/batch-receipts/batch-2026-01-01.json";
    const held = { schema_version: "hhs-reconstruction-batch/0.1.0", workspace: WORKSPACE,
      status: "failed", finished_at: "2026-01-01T00:00:00.000Z", completed: [],
      quarantined: [{ source_conversation_id: SOURCE, title: "Synthetic", reason }] };
    put(directory, heldPath, held);
    const preserved = fs.readFileSync(path.join(directory, `${BASE}-output.json`), "utf8");
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      throw new Error("A held source must not regenerate, validate or persist automatically");
    };
    await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn);
    expect(batchReceipt(directory)).toMatchObject({ status: "completed", selected: 0, skipped_quarantined_count: 1 });
    expect(get(directory, heldPath)).toEqual(held);
    expect(fs.readFileSync(path.join(directory, `${BASE}-output.json`), "utf8")).toBe(preserved);
  });

  it.each(["Error: Original user text is not fully represented by content blocks; repair source evidence before discovery.","Error: Original user text is not fully represented by content blocks; repair source evidence before discovery.\n    at assertBrowserUserTextCoverage (/fixture/understanding-discovery.ts:784:13)\n    at prepareDiscoveryExchangeFromClient (/fixture/understanding-discovery.ts:235:5)\nError: provider_error HTTP 503","Error: request_timeout"])("does not silently quarantine unknown or provider failures (%s)", async reason => {
    const directory=root();priority(directory);standardArtifacts(directory);
    put(directory,".runtime/reconstruction/batch-receipts/batch-2026-01-01.json",{schema_version:"hhs-reconstruction-batch/0.1.0",workspace:WORKSPACE,status:"failed",finished_at:"2026-01-01T00:00:00.000Z",completed:[],quarantined:[{source_conversation_id:SOURCE,reason}]});
    let writes=0;
    await run(directory,"run-reconstruction-batch.mjs",BATCH_ARGS,(_command,args)=>{
      if(args.includes("scripts/reconstruction-inventory.ts"))return inventory();
      if(args.includes("validate"))return validate(directory,args);
      if(args.includes("persist")){writes++;return persistResult();}
      throw new Error("Unexpected model generation");
    });
    expect(writes).toBe(1);
  });

  it("explicit targeted retry, other-workspace and unfinished receipts do not silently hold an eligible source", async () => {
    for (const mode of ["targeted", "other-workspace", "unfinished"]) {
      const directory = root(); priority(directory); standardArtifacts(directory);
      put(directory, ".runtime/reconstruction/batch-receipts/batch-2026-01-01.json", {
        schema_version: "hhs-reconstruction-batch/0.1.0", workspace: mode === "other-workspace" ? "other-workspace" : WORKSPACE,
        status: mode === "unfinished" ? "running" : "failed", ...(mode === "unfinished" ? {} : { finished_at: "2026-01-01T00:00:00.000Z" }),
        completed: [], quarantined: [{ source_conversation_id: SOURCE, reason: "Error: standard validation failed after 3 attempts: invalid source reference" }]
      });
      let writes = 0;
      const spawn: Spawn = (_command, args) => {
        if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
        if (args.includes("validate")) return validate(directory, args);
        if (args.includes("persist")) { writes++; return persistResult(); }
        throw new Error("Unexpected generation");
      };
      await run(directory, "run-reconstruction-batch.mjs", mode === "targeted" ? [...BATCH_ARGS, "--conversation", SOURCE] : BATCH_ARGS, spawn);
      expect(writes).toBe(1);
      expect(batchReceipt(directory)).toMatchObject({ selected: 1, completed: [{ replay: false }] });
    }
  });

  it("malformed same-workspace terminal quarantine receipts stop selection before processing", async () => {
    const directory = root(); priority(directory);
    put(directory, ".runtime/reconstruction/batch-receipts/batch-2026-01-01.json", {
      schema_version: "hhs-reconstruction-batch/0.1.0", workspace: WORKSPACE, status: "failed",
      finished_at: "2026-01-01T00:00:00.000Z", quarantined: [{ source_conversation_id: "../other", reason: "invalid reference" }]
    });
    await expect(run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      throw new Error("Unexpected processing");
    })).rejects.toThrow(/invalid preserved quarantine entry/i);
  });

  it("reuses completed artifacts and live discovery inventory without duplicating completed work", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    let processed = false;
    const calls: string[] = [];
    const spawn: Spawn = (_command, args) => {
      expect(argument(args, "workspace")).toBe(WORKSPACE);
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory(processed);
      if (args.includes("validate")) { calls.push("validate"); return validate(directory, args); }
      if (args.includes("persist")) { calls.push("persist"); processed = true; return persistResult(); }
      throw new Error(`Unexpected generation: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(batchReceipt(directory)).toMatchObject({ status: "completed", quarantined: [], completed: [{ replay: false }] });
    await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn);
    expect(calls).toEqual(["validate", "persist"]);
  });

  it("never selects a priority conversation outside the active workspace inventory", async () => {
    const directory = root();
    priority(directory);

    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) {
        return result(0, { workspace_id: WORKSPACE, conversations: [] });
      }
      throw new Error(`Unexpected processing outside active workspace inventory: ${args}`);
    };

    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(batchReceipt(directory)).toMatchObject({
      status: "completed",
      selected: 0,
      completed: [],
      quarantined: []
    });
  });

  it("completes an empty workspace without requiring the historical priority index", async () => {
    const directory = root();

    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) {
        return result(0, { workspace_id: WORKSPACE, conversations: [] });
      }
      throw new Error(`Unexpected processing for empty workspace: ${args}`);
    };

    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(batchReceipt(directory)).toMatchObject({
      status: "completed",
      selected: 0,
      completed: [],
      quarantined: []
    });
  });

  it("refuses to silently complete when an unprocessed workspace source lacks priority metadata", async () => {
    const directory = root();
    priority(directory);
    const workspaceOnlySource = "workspace-only-source";

    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) {
        return result(0, {
          workspace_id: WORKSPACE,
          conversations: [{
            source_conversation_id: workspaceOnlySource,
            discovery_status: "unprocessed",
            evidence_issue: false
          }]
        });
      }
      throw new Error(`Unexpected processing before priority coverage is proven: ${args}`);
    };

    await expect(
      run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)
    ).rejects.toThrow(/missing priority metadata.*workspace-only-source/i);
  });

  it("archives incomplete/generation-failed attempts and resumes with bounded fresh generation", async () => {
    const directory = root(); priority(directory); put(directory, `${BASE}-input.json`, exchange());
    let generations = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("scripts/run-next-priority-nemotron.mjs")) {
        expect(argument(args, "workspace")).toBe(WORKSPACE);
        expect(batchReceipt(directory)).toMatchObject({ status: "running" });
        expect(batchReceipt(directory).finished_at).toBeUndefined();
        generations += 1;
        standardArtifacts(directory); return result(generations === 1 ? 7 : 0);
      }
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return persistResult();
      throw new Error(`Unexpected: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(generations).toBe(2);
    const failed = path.join(directory, ".runtime/reconstruction/priority-runs/failed-attempts/priority-0001-synthetic-source");
    expect(fs.readdirSync(failed)).toHaveLength(2);
    for (const attempt of fs.readdirSync(failed)) expect(get(failed, `${attempt}/attempt.json`).workspace).toBe(WORKSPACE);
  });

  it("retries trusted-validation rejection before persistence without weakening attribution", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory, true);
    let generated = 0; let persisted = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("scripts/run-next-priority-nemotron.mjs")) { generated += 1; standardArtifacts(directory); return result(); }
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) { persisted += 1; return persistResult(); }
      throw new Error(`Unexpected: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(generated).toBe(1); expect(persisted).toBe(1);
  });

  it("retains validated artifacts on persistence failure and replays them without another model call", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const before = fs.readFileSync(path.join(directory, `${BASE}-output.json`), "utf8");
    let persists = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return ++persists === 1 ? result(1) : persistResult(true);
      throw new Error(`Unexpected regeneration: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(2);
    expect(batchReceipt(directory)).toMatchObject({ status: "failed", completed: [], quarantined: [{ source_conversation_id: SOURCE }] });
    expect(fs.readFileSync(path.join(directory, `${BASE}-output.json`), "utf8")).toBe(before);
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(batchReceipt(directory)).toMatchObject({ status: "completed", completed: [{ replay: true }] });
    expect(persists).toBe(2);
  });

  it("cannot report exhausted generation as complete", async () => {
    const directory = root(); priority(directory); let attempts = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("scripts/run-next-priority-nemotron.mjs")) { attempts += 1; return result(7); }
      throw new Error(`Unexpected persistence: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(2);
    expect(attempts).toBe(2);
    expect(batchReceipt(directory)).toMatchObject({ status: "failed", completed: [] });
  });
  it("resumes interrupted oversized preparation from the existing parent exchange without overwriting history", async () => {
    const directory = root(); priority(directory, true);
    const runDir = ".runtime/reconstruction/oversized-runs/priority-0001-synthetic-source";
    const input = exchange(); put(directory, `${runDir}/parent-input.json`, input);
    const before = fs.readFileSync(path.join(directory, `${runDir}/parent-input.json`), "utf8");
    let exports = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("export-chunks")) {
        exports += 1; expect(argument(args, "exchange")).toBe(`${runDir}/parent-input.json`);
        return result(0, { parent_exchange: input, chunks: [{ chunk_number: 1, chunk_count: 1,
          exchange: input, evidence_characters: 40000, exceeds_target: false }] });
      }
      if (args.includes("scripts/run-oversized-orchestrator.mjs")) {
        expect(argument(args, "workspace")).toBe(WORKSPACE);
        put(directory, `${runDir}/parent-output.json`, output(input));
        put(directory, `${runDir}/parent-model.json`, receipt()); return result();
      }
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return persistResult();
      throw new Error(`Unexpected: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(0);
    expect(exports).toBe(1);
    expect(fs.readFileSync(path.join(directory, `${runDir}/parent-input.json`), "utf8")).toBe(before);
    expect(batchReceipt(directory)).toMatchObject({ status: "completed", completed: [{ mode: "oversized" }] });
  });

  it("honors the explicit conversation target without changing priority rank or selecting another conversation", async () => {
    const directory = root(); priority(directory);
    const spawn: Spawn = (_command, args) => {
      expect(args).toContain("scripts/reconstruction-inventory.ts"); return inventory();
    };
    await expect(run(directory, "run-reconstruction-batch.mjs", [...BATCH_ARGS, "--conversation", "outside-inventory"], spawn))
      .rejects.toThrow(/not an eligible unprocessed reconstruction candidate/);
  });

});

function oversized(directory: string, count = 2): void {
  const chunks = Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    put(directory, `chunk-${number}-input.json`, exchange(`child-${number}`));
    return { chunk_number: index + 1, chunk_count: count, input_file: `chunk-${number}-input.json`, evidence_characters: 40000 };
  });
  const parent = exchange();
  parent.evidence = chunks.flatMap((chunk) => get(directory, chunk.input_file).evidence);
  parent.evidence_sha256 = sha256(parent.evidence);
  put(directory, "parent-input.json", parent);
  put(directory, "manifest.json", { source_conversation_id: SOURCE, title: "Synthetic", chunk_count: count, chunks });
}
function completeChunk(directory: string, number: string): void {
  put(directory, `chunk-${number}-output.json`, output(get(directory, `chunk-${number}-input.json`)));
  put(directory, `chunk-${number}-model.json`, receipt());
}
function completeParent(directory: string): void {
  const merged = get(directory, "parent-deterministic-merged-output.json");
  put(directory, "parent-output.json", merged); put(directory, "parent-model.json", receipt());
}
function orchestratorArgs(directory: string): string[] { return ["--run-dir", directory, "--workspace", WORKSPACE]; }

describe("existing oversized runner continuation", () => {
  it("subdivides a truncated chunk immediately, preserves its attempt and replays the merged result", async () => {
    const directory = root(); oversized(directory, 1);
    const left = exchange("left"), right = exchange("right"), combined = exchange("combined");
    combined.evidence = [...left.evidence, ...right.evidence]; combined.evidence_sha256 = sha256(combined.evidence);
    put(directory, "chunk-001-input.json", combined); put(directory, "parent-input.json", combined);
    let chunkCalls = 0, exports = 0, links = 0;
    const raw = { model: MODEL, choices: [{ finish_reason: "length" }] };
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("scripts/run-oversized-chunk-nemotron.mjs")) {
        chunkCalls++;
        const runDir = argument(args, "run-dir");
        if (runDir === directory) {
          put(directory, "chunk-001-attempt-001-openrouter-raw.json", raw);
          put(directory, "chunk-001-attempt-001-error.json", { category: "model_output_truncated" });
          return result(11);
        }
        const number = fs.existsSync(path.join(runDir,"chunk-001-output.json")) ? "002" : "001";
        completeChunk(runDir,number); return result();
      }
      if (args.includes("export-chunks")) {
        exports++; expect(args).toContain("--subdivide-messages");
        return result(0,{parent_exchange:combined,chunks:[left,right].map((child,index)=>({
          chunk_number:index+1,chunk_count:2,exchange:child,evidence_characters:1000,exceeds_target:false}))});
      }
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) { links++; completeParent(directory);return result(); }
      throw new Error("Unexpected work");
    };
    await run(directory,"run-oversized-orchestrator.mjs",orchestratorArgs(directory),spawn);
    expect(chunkCalls).toBe(3); expect(exports).toBe(1);
    expect(get(directory,"chunk-001-attempt-001-openrouter-raw.json")).toEqual(raw);
    expect(get(directory,"parent-output.json").observations).toHaveLength(2);
    await run(directory,"run-oversized-orchestrator.mjs",orchestratorArgs(directory),spawn);
    expect(chunkCalls).toBe(3);expect(links).toBe(1);
  });

  it("retains legacy linker attempts but counts every current-policy request, including torn requests, against resume", async () => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, '001');
    for (let index = 1; index <= 3; index++) put(directory, `parent-link-attempt-00${index}-raw.json`, { model: MODEL });
    for (let index = 4; index <= 5; index++) put(directory, `parent-link-attempt-00${index}-request.json`, { request_version: LINKING_REQUEST_VERSION });
    let calls = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes('validate')) return validate(directory, args);
      if (args.includes('scripts/run-oversized-linker-nemotron.mjs')) { calls++; put(directory, 'parent-link-attempt-006-request.json', { request_version: LINKING_REQUEST_VERSION }); return result(9); }
      throw new Error('Cached chunks must not regenerate');
    };
    await expect(run(directory, 'run-oversized-orchestrator.mjs', orchestratorArgs(directory), spawn)).rejects.toThrow('Linker attempt limit');
    expect(calls).toBe(1);
    await expect(run(directory, 'run-oversized-orchestrator.mjs', orchestratorArgs(directory), spawn)).rejects.toThrow('Linker attempt limit');
    expect(calls).toBe(1);
  });
  it("skips revalidated completed chunks, retries validation failures, retries linker failures, and replays without model work", async () => {
    const directory = root(); oversized(directory); completeChunk(directory, "001");
    let chunks = 0; let links = 0;
    const spawn: Spawn = (_command, args, options) => {
      expect(options.env.MEMORY_WORKSPACE_ID).toBe(WORKSPACE);
      if (args.includes("validate")) { expect(argument(args, "workspace")).toBe(WORKSPACE); return validate(directory, args); }
      if (args.includes("scripts/run-oversized-chunk-nemotron.mjs")) {
        chunks += 1; put(directory, `chunk-002-attempt-${String(chunks).padStart(3, "0")}-openrouter-raw.json`, { model: MODEL });
        if (chunks === 1) return result(9);
        completeChunk(directory, "002"); return result();
      }
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) {
        links += 1; put(directory, `parent-link-attempt-${String(links).padStart(3, "0")}-raw.json`, { model: MODEL });
        if (links === 1) return result(9);
        completeParent(directory); return result();
      }
      throw new Error(`Unexpected: ${args}`);
    };
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(chunks).toBe(2); expect(links).toBe(2);
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(chunks).toBe(2); expect(links).toBe(2);
  });

  it("Finding 9: recovers interrupted chunk and parent publication using preserved attempts/receipts without regenerating", async () => {
    const directory = root(); oversized(directory, 1);
    put(directory, "chunk-001-attempt-001-output.json", output(get(directory, "chunk-001-input.json")));
    put(directory, "chunk-001-model.json", receipt());
    let links = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) {
        links += 1;
        const merged = get(directory, "parent-deterministic-merged-output.json");
        put(directory, "parent-link-attempt-001-output.json", merged);
        put(directory, "parent-link-attempt-001-raw.json", { model: MODEL, json_repaired: true });
        put(directory, "parent-output.json", merged); return result();
      }
      throw new Error(`Unexpected regeneration: ${args}`);
    };
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(get(directory, "parent-model.json")).toMatchObject({ model: MODEL, validated: true, attempt: 1, recovered_from_attempt: true, json_repaired: true });
    expect(get(directory, "chunk-001-model.json")).not.toHaveProperty("recovered_from_attempt");
    expect(get(directory, "chunk-001-output.json")).toEqual(get(directory, "chunk-001-attempt-001-output.json"));
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(links).toBe(1);
  });

  it("revalidates a preserved rejected attempt after a validator repair without regeneration or overwrites", async () => {
    const directory = root(); oversized(directory, 1);
    const input = get(directory, "chunk-001-input.json");
    const candidate = output(input);
    candidate.observations[0]!.statement = "Business seats require two seats at $25/user/month.";
    candidate.observations[0]!.observation_kind = "pricing_detail";
    put(directory, "chunk-001-attempt-003-output.json", candidate);
    put(directory, "chunk-001-attempt-003-openrouter-raw.json", { model: MODEL, json_repaired: false });
    const original = fs.readFileSync(path.join(directory, "chunk-001-attempt-003-output.json"), "utf8");
    let links = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) { links++; completeParent(directory); return result(); }
      throw new Error("Must not regenerate or split the recovered chunk");
    };
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(get(directory, "chunk-001-model.json")).toMatchObject({ attempt: 3, recovered_from_attempt: true, validated: true, json_repaired: false });
    expect(fs.readFileSync(path.join(directory, "chunk-001-attempt-003-output.json"), "utf8")).toBe(original);
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(links).toBe(1);
  });

  it.each([
    { choices: [{ finish_reason: "length" }] },
    { usage: { cost: 1 } },
    { error: { code: 503 } }
  ])("does not recover truncated, paid or provider-error attempts: %j", async raw => {
    const directory = root(); oversized(directory, 1);
    for (let n = 1; n <= 3; n++) {
      put(directory, "chunk-001-attempt-00" + n + "-output.json", output(get(directory, "chunk-001-input.json")));
      put(directory, "chunk-001-attempt-00" + n + "-openrouter-raw.json", { model: MODEL, ...raw });
    }
    const spawn: Spawn = (_command, args) => {
      if (args.includes("export-chunks")) return result(0, { chunks: [exchange()] });
      throw new Error("Must not validate or publish a failed provider result");
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).rejects.toThrow(/unsplittable/);
    expect(fs.existsSync(path.join(directory, "chunk-001-model.json"))).toBe(false);
  });

  it("does not recover a preserved attempt that still invents user authority", async () => {
    const directory = root(); oversized(directory, 1);
    for (let n = 1; n <= 3; n++) {
      put(directory, `chunk-001-attempt-00${n}-output.json`, output(get(directory, "chunk-001-input.json"), true));
      put(directory, `chunk-001-attempt-00${n}-openrouter-raw.json`, { model: MODEL });
    }
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("export-chunks")) return result(0, { chunks: [exchange()] });
      throw new Error("Rejected attempts must not regenerate after the exhausted budget");
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).rejects.toThrow(/unsplittable/);
    expect(fs.existsSync(path.join(directory, "chunk-001-output.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "chunk-001-model.json"))).toBe(false);
  });

  it("bounds retries even without raw artifacts and refuses unsplittable failed work", async () => {
    const directory = root(); oversized(directory, 1); let attempts = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/run-oversized-chunk-nemotron.mjs")) { attempts += 1; return result(9); }
      if (args.includes("export-chunks")) return result(0, { chunks: [exchange()] });
      throw new Error(`Unexpected finalization: ${args}`);
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).rejects.toThrow(/unsplittable.*quarantined/);
    expect(attempts).toBe(3);
    expect(fs.existsSync(path.join(directory, "parent-output.json"))).toBe(false);
  });

  it("rejects an invalid cached chunk rather than falsely completing it", async () => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, "001");
    put(directory, "chunk-001-output.json", output(get(directory, "chunk-001-input.json"), true));
    const spawn: Spawn = (_command, args) => {
      expect(args).toContain("validate"); return validate(directory, args);
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).rejects.toThrow(/Validation failed/);
    expect(fs.existsSync(path.join(directory, "parent-output.json"))).toBe(false);
  });
  it("continues an existing recursive subrun without reprocessing its completed child", async () => {
    const directory = root(); oversized(directory, 1);
    for (let attempt = 1; attempt <= 3; attempt += 1) put(directory, `chunk-001-attempt-00${attempt}-openrouter-raw.json`, { model: MODEL });
    const subrun = path.join(directory, "chunk-001-subrun");
    oversized(subrun, 2); completeChunk(subrun, "001");
    const subParent = get(subrun, "parent-input.json");
    put(directory, "chunk-001-input.json", subParent); put(directory, "parent-input.json", subParent);
    let chunks = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("scripts/run-oversized-chunk-nemotron.mjs")) {
        expect(argument(args, "run-dir")).toBe(subrun);
        chunks += 1; completeChunk(subrun, "002"); return result();
      }
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) { completeParent(directory); return result(); }
      throw new Error(`Unexpected split/export of existing subrun: ${args}`);
    };
    await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn);
    expect(chunks).toBe(1);
    expect(get(directory, "chunk-001-model.json")).toMatchObject({ validated: true, merged_artifact: "chunk-001-deterministic-merged-output.json" });
  });

});

function provider(candidate: DiscoveryOutput, overloaded = false) {
  let calls = 0;
  return vi.fn(async (_url: string, options: any): Promise<any> => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (overloaded && calls === 1) return { ok: false, status: 429, json: async () => ({ error: { message: "rate limit" } }) };
    return { ok: true, status: 200, json: async () => ({ model: body.model, choices: [{ message: { content: JSON.stringify(candidate) } }] }) };
  });
}
describe("runner attribution normalization remains under trusted validation", () => {
  it("sends compact exact evidence but validates against the untouched full local exchange", async () => {
    const directory = root(); priority(directory);
    const input = exchange();
    const candidate = output(input); candidate.observations[0]!.evidence[0]!.evidence_ref = 'E1';
    const fetch = provider(candidate);
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("export")) return result(0, input);
      if (args.includes("validate")) { expect(get(directory, `${BASE}-input.json`)).toEqual(input); return validate(directory, args); }
      throw new Error("Unexpected subprocess");
    };
    expect((await run(directory, "run-next-priority-nemotron.mjs", ["--workspace", WORKSPACE], spawn, fetch)).code).toBe(0);
    const sent = JSON.parse(fetch.mock.calls[0]![1].body).messages[1].content;
    expect(sent).toContain('"evidence_ref":"E1"');
    expect(sent).toContain(input.evidence[0]!.text);
    expect(sent).not.toContain("resolution_observed_sha256");
    expect(providerAudit(directory).attempts[0]).toMatchObject({ category: "content_received", http_status: 200 });
  });
  it("preserves safe provider failure receipts without echoed messages or credentials", async () => {
    const directory = root(); priority(directory);
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("export")) return result(0, exchange());
      throw new Error("Unexpected persistence");
    };
    const fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "synthetic-secret credential" } }) });
    expect((await run(directory, "run-next-priority-nemotron.mjs", ["--workspace", WORKSPACE], spawn, fetch)).code).toBe(7);
    const saved = providerAudit(directory);
    expect(saved.attempts).toHaveLength(2);
    expect(saved.attempts.every((row: any) => row.category === "provider_auth")).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/synthetic-secret|synthetic-key/);
  });
  it("never repairs a length-truncated result into falsely completed historical discovery", async () => {
    for (const script of ['run-next-priority-nemotron.mjs', 'run-oversized-chunk-nemotron.mjs']) {
      const directory = root(); priority(directory);
      if (script.includes('chunk')) oversized(directory, 1);
      const spawn: Spawn = (_command, args) => {
        if (args.includes('scripts/reconstruction-inventory.ts')) return inventory();
        if (args.includes('export')) return result(0, exchange());
        throw new Error('Truncated output must never validate or persist');
      };
      const fetch = async () => ({ ok: true, status: 200, json: async () => ({ model: MODEL,
        choices: [{ finish_reason: 'length', message: { content: JSON.stringify(output()) } }] }) });
      const args = script.includes('chunk') ? ['--run-dir', directory] : ['--workspace', WORKSPACE];
      expect((await run(directory, script, args, spawn, fetch)).code).toBe(script.includes('chunk') ? 11 : 10);
      expect(fs.existsSync(path.join(directory, script.includes('chunk') ? 'chunk-001-output.json' : `${BASE}-output.json`))).toBe(false);
    }
  });
  it("validates and retains all source findings when the extra linker sees bounded representative anchors", async () => {
    const directory = root(); const input = exchange();
    const merged = output(input);
    merged.observations = Array.from({ length: 26 }, (_, index) => ({ ...merged.observations[0]!, statement: `Assistant proposal number ${index}.`, observation_ref: `chunk${String(Math.floor(index / 2) + 1).padStart(3, '0')}__o${index}` }));
    put(directory, 'parent-input.json', input); put(directory, 'parent-deterministic-merged-output.json', merged);
    const fetch = async (_url: string, options: any) => {
      const sent = JSON.parse(JSON.parse(options.body).messages[1].content.split('validated observations:\n\n')[1]);
      expect(sent.observations).toHaveLength(16);
      return { ok: true, status: 200, json: async () => ({ model: MODEL, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ links: [{
        from_observation_ref: sent.observations[0].observation_ref, to_observation_ref: sent.observations[1].observation_ref,
        link_kind: 'related', payload: {}, confidence: 0.5 }] }) } }] }) };
    };
    expect((await run(directory, 'run-oversized-linker-nemotron.mjs', ['--run-dir', directory], (_command, args) => validate(directory, args), fetch)).code).toBe(0);
    expect(get(directory, 'parent-output.json').observations).toEqual(merged.observations);
    expect(get(directory, 'parent-model.json')).toMatchObject({ validated: true, observations: 26, linking_anchors: 16, relationship_coverage: 'representative_anchors' });
  });
  it("retains linker truncation diagnostics and never validates or saves a truncated graph", async () => {
    const directory = root();
    put(directory, 'parent-input.json', exchange());
    put(directory, 'parent-deterministic-merged-output.json', output());
    const spawn = vi.fn(() => { throw new Error('Truncated graph must not validate or persist'); });
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ model: MODEL,
      choices: [{ finish_reason: 'length', message: { content: '{"links":[]}' } }] }) });
    expect((await run(directory, 'run-oversized-linker-nemotron.mjs', ['--run-dir', directory], spawn, fetch)).code).toBe(8);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, 'parent-output.json'))).toBe(false);
    expect(get(directory, 'parent-link-attempt-001-error.json')).toEqual({ category: 'output_truncated' });
  });
  it("requires an explicit workspace instead of selecting the persistent proof workspace", async () => {
    const directory = root();
    const spawn = vi.fn(() => { throw new Error("Unexpected subprocess"); });
    expect((await run(directory, "run-next-priority-nemotron.mjs", [], spawn)).code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("normalizes tool attribution to other, fills only claim_type, and safely retries a rate limit", async () => {
    const directory = root(); priority(directory);
    const candidate = output();
    Object.assign(candidate.observations[0]!.attribution, { subject: "tool", claim_type: "" });
    const fetch = provider(candidate, true);
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("export")) return result(0, exchange());
      if (args.includes("validate")) return validate(directory, args);
      throw new Error(`Unexpected persistence: ${args}`);
    };
    expect((await run(directory, "run-next-priority-nemotron.mjs", ["--workspace", WORKSPACE], spawn, fetch)).code).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(get(directory, `${BASE}-output.json`).observations[0].attribution).toEqual({ subject: "other", claim_type: "finding" });
  });

  it("does not allow normalization to convert assistant evidence into user authority", async () => {
    const directory = root(); priority(directory);
    const candidate = output(exchange(), true);
    Object.assign(candidate.observations[0]!.attribution, { subject: "tool", claim_type: "" });
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("export")) return result(0, exchange());
      if (args.includes("validate")) return validate(directory, args);
      throw new Error(`Unexpected persistence: ${args}`);
    };
    expect((await run(directory, "run-next-priority-nemotron.mjs", ["--workspace", WORKSPACE], spawn, provider(candidate))).code).toBe(10);
    expect(get(directory, `${BASE}-output.json`).observations[0].statement).toBe(candidate.observations[0]!.statement);
  });
  it("Finding 9: preserves rejected oversized attempts and publishes a later valid chunk with its model receipt", async () => {
    const directory = root(); oversized(directory, 1);
    const input = get(directory, "chunk-001-input.json");
    const spawn: Spawn = (_command, args) => { expect(args).toContain("validate"); return validate(directory, args); };
    const first = await run(directory, "run-oversized-chunk-nemotron.mjs", ["--run-dir", directory], spawn, provider(output(input, true)));
    expect(first.code).toBe(9);
    expect(fs.existsSync(path.join(directory, "chunk-001-output.json"))).toBe(false);
    const failed = fs.readFileSync(path.join(directory, "chunk-001-attempt-001-output.json"), "utf8");
    const second = await run(directory, "run-oversized-chunk-nemotron.mjs", ["--run-dir", directory], spawn, provider(output(input)));
    expect(second.code).toBe(0);
    expect(get(directory, "chunk-001-model.json")).toMatchObject({ validated: true, attempt: 2 });
    expect(get(directory, "chunk-001-model.json")).not.toHaveProperty("recovered_from_attempt");
    expect(fs.readFileSync(path.join(directory, "chunk-001-attempt-001-output.json"), "utf8")).toBe(failed);
    expect(get(directory, "chunk-001-output.json")).toEqual(get(directory, "chunk-001-attempt-002-output.json"));
  });

});


describe("Claude runner correctness regressions", () => {
  it("Finding 1: records actual selection and explicit target independently of the requested limit", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return persistResult();
      throw new Error(`Unexpected generation: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs",
      [...BATCH_ARGS, "--limit", "10", "--conversation", SOURCE], spawn)).code).toBe(0);
    const report = batchReceipt(directory);
    expect(report).toMatchObject({ requested: 10, selected: 1, conversation: SOURCE, status: "completed" });
    expect(report.completed).toHaveLength(1);
  });

  it("Finding 2: reports total persistence failure as failed with exit 2", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return result(1);
      throw new Error(`Unexpected generation: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(2);
    expect(batchReceipt(directory)).toMatchObject({ selected: 1, status: "failed", completed: [] });
    expect(batchReceipt(directory).quarantined).toHaveLength(1);
  });

  it("Finding 2: reports mixed persistence outcomes as partial with exit 2", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const second = "synthetic-source-2";
    const index = get(directory, ".runtime/reconstruction/business-priority-index-v1.json");
    index.conversations.push({ ...index.conversations[0], source_conversation_id: second, unprocessed_queue_rank: 2 });
    put(directory, ".runtime/reconstruction/business-priority-index-v1.json", index);
    const input = exchange("second");
    input.selection[0]!.source_conversation_id = second;
    input.evidence[0]!.source_conversation_id = second;
    input.evidence_sha256 = sha256(input.evidence);
    const candidate = output(input); candidate.observations[0]!.source_conversation_id = second;
    const base = `.runtime/reconstruction/priority-runs/priority-0002-${second}`;
    put(directory, `${base}-input.json`, input);
    put(directory, `${base}-output.json`, candidate);
    put(directory, `${base}-openrouter-raw.json`, { model: MODEL });
    let persists = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return result(0, { workspace_id: WORKSPACE,
        conversations: [SOURCE, second].map((id) => ({ source_conversation_id: id, source_version_id: "version", capture_version_id: null, discovery_status: "unprocessed" })) });
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return ++persists === 1 ? persistResult() : result(1);
      throw new Error(`Unexpected generation: ${args}`);
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", [...BATCH_ARGS, "--limit", "2"], spawn)).code).toBe(2);
    expect(batchReceipt(directory)).toMatchObject({ selected: 2, status: "partial" });
    expect(batchReceipt(directory).completed).toHaveLength(1);
    expect(batchReceipt(directory).quarantined).toHaveLength(1);
    expect(persists).toBe(2);
  });

  it("Finding 4: prints unavailable counts when statusSummary fails", async () => {
    const statusSummary = vi.fn(async () => { throw new Error("Synthetic report timeout"); });
    const close = vi.fn(async () => {});
    const diagnostics = Object.fromEntries(["docker", "supabase", "bindings", "migrations", "collector", "extension", "git", "publication"]
      .map((key) => [key, { state: "ready", detail: "Synthetic diagnostic" }]));
    const report = await run(root(), "hhs.ts", ["status"], () => { throw new Error("Unexpected subprocess"); }, undefined, {
      promisify, execFile: () => {}, collectDiagnostics: async () => diagnostics,
      MissionControlStore: class { statusSummary = statusSummary; close = close; }
    });
    expect(report.code).toBe(0);
    expect(statusSummary).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    const stdout = report.logs.join("\n");
    expect(stdout).toContain("Needs You: unavailable"); expect(stdout).toContain("Memory: unavailable");
    expect(stdout).not.toContain("Needs You: 0"); expect(stdout).not.toContain("0 messages");
  });

  it("Finding 5: standalone provider errors leave the full actual-attempt budget before splitting", async () => {
    const directory = root(); oversized(directory, 1);
    for (let attempt = 1; attempt <= 3; attempt += 1)
      put(directory, `chunk-001-attempt-00${attempt}-error.json`, { failed: true });
    let attempts = 0; let splits = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/run-oversized-chunk-nemotron.mjs")) {
        attempts += 1;
        put(directory, `chunk-001-attempt-${String(attempts + 3).padStart(3, "0")}-openrouter-raw.json`, { model: MODEL });
        return result(9);
      }
      if (args.includes("export-chunks")) { splits += 1; expect(attempts).toBe(3); return result(0, { chunks: [exchange()] }); }
      throw new Error(`Unexpected finalization: ${args}`);
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn))
      .rejects.toThrow(/unsplittable.*quarantined/);
    expect(attempts).toBe(3); expect(splits).toBe(1);
    expect(fs.existsSync(path.join(directory, "parent-output.json"))).toBe(false);
  });

  it("Finding 8: skips torn chunk publication before any provider call or attempt artifact", async () => {
    const directory = root(); oversized(directory, 1);
    put(directory, "chunk-001-model.json", receipt());
    const before = fs.readdirSync(directory).sort();
    const fetch = vi.fn(async () => { throw new Error("Provider must never be called"); });
    const report = await run(directory, "run-oversized-chunk-nemotron.mjs", ["--run-dir", directory],
      () => { throw new Error("Unexpected subprocess"); }, fetch);
    expect(report.code).toBe(0); expect(fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory).sort()).toEqual(before);
    expect(fs.readdirSync(directory).filter((name) => name.includes("-attempt-"))).toEqual([]);
    expect(fs.existsSync(path.join(directory, "chunk-001-output.json"))).toBe(false);
  });
});


describe("Finding 9: recovered receipt provenance", () => {
  it.each([true, false, undefined])("preserves available json_repaired=%s on a recovered chunk receipt", async (jsonRepaired) => {
    const directory = root(); oversized(directory, 1);
    const candidate = output(get(directory, "chunk-001-input.json"));
    put(directory, "chunk-001-attempt-001-output.json", candidate);
    put(directory, "chunk-001-output.json", candidate);
    put(directory, "chunk-001-attempt-001-openrouter-raw.json", { model: MODEL,
      ...(jsonRepaired === undefined ? {} : { json_repaired: jsonRepaired }) });
    let recoveredValidation = false;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("validate")) {
        if (argument(args, "output").endsWith("chunk-001-output.json") && !recoveredValidation) {
          expect(fs.existsSync(path.join(directory, "chunk-001-model.json"))).toBe(false);
          recoveredValidation = true;
        }
        return validate(directory, args);
      }
      if (args.includes("scripts/run-oversized-linker-nemotron.mjs")) { completeParent(directory); return result(); }
      throw new Error(`Unexpected generation: ${args}`);
    };
    expect((await run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).code).toBe(0);
    expect(recoveredValidation).toBe(true);
    const model = get(directory, "chunk-001-model.json");
    expect(model).toMatchObject({ recovered_from_attempt: true, validated: true, model: MODEL });
    if (jsonRepaired === undefined) expect(model).not.toHaveProperty("json_repaired");
    else expect(model.json_repaired).toBe(jsonRepaired);
    expect(get(directory, "parent-model.json")).not.toHaveProperty("recovered_from_attempt");
  });

  it("does not publish a recovered receipt when trusted validation rejects the attempt", async () => {
    const directory = root(); oversized(directory, 1);
    const candidate = output(get(directory, "chunk-001-input.json"), true);
    put(directory, "chunk-001-attempt-001-output.json", candidate);
    put(directory, "chunk-001-output.json", candidate);
    put(directory, "chunk-001-attempt-001-openrouter-raw.json", { model: MODEL, json_repaired: true });
    const spawn: Spawn = (_command, args) => { expect(args).toContain("validate"); return validate(directory, args); };
    await expect(run(directory, "run-oversized-orchestrator.mjs", orchestratorArgs(directory), spawn)).rejects.toThrow(/Validation failed/);
    expect(fs.existsSync(path.join(directory, "chunk-001-model.json"))).toBe(false);
  });
});


describe("Context Operations runner correlation and source refresh", () => {
  it("keeps optional operation identity in the existing batch receipt without changing CLI execution", async () => {
    const directory = root(); priority(directory); standardArtifacts(directory);
    const operation = `operation_${"a".repeat(32)}`;
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return inventory();
      if (args.includes("validate")) return validate(directory, args);
      if (args.includes("persist")) return persistResult();
      throw new Error("Unexpected generation");
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", [...BATCH_ARGS, "--operation-id", operation], spawn)).code).toBe(0);
    expect(batchReceipt(directory)).toMatchObject({ operation_id: operation, status: "completed", workspace: WORKSPACE });
    expect(fs.readdirSync(path.join(directory, ".runtime/reconstruction/batch-receipts"))[0]).toContain(operation);
    await expect(run(root(), "run-reconstruction-batch.mjs", [...BATCH_ARGS, "--operation-id", "../bad"], spawn)).rejects.toThrow("Invalid --operation-id");
  });
  it.each([false, true])("retains prepared artifacts and quarantines changed source identity (oversized=%s)", async oversized => {
    const directory = root(); priority(directory, oversized);
    let inputFile = `${BASE}-input.json`;
    if (oversized) {
      const runDir = ".runtime/reconstruction/oversized-runs/priority-0001-synthetic-source";
      inputFile = `${runDir}/parent-input.json`;
      put(directory, `${runDir}/manifest.json`, { source_conversation_id: SOURCE });
      put(directory, inputFile, exchange());
    } else standardArtifacts(directory);
    const before = fs.readFileSync(path.join(directory, inputFile), "utf8");
    const spawn: Spawn = (_command, args) => {
      if (args.includes("scripts/reconstruction-inventory.ts")) return result(0, { conversations: [{ source_conversation_id: SOURCE, source_version_id: "refreshed-version", capture_version_id: null, discovery_status: "unprocessed" }] });
      throw new Error("Source mismatch must prevent generation and persistence");
    };
    expect((await run(directory, "run-reconstruction-batch.mjs", BATCH_ARGS, spawn)).code).toBe(2);
    expect(batchReceipt(directory).status).toBe("failed");
    expect(batchReceipt(directory).quarantined[0].reason).toContain("prepared_source_identity_mismatch");
    expect(fs.readFileSync(path.join(directory, inputFile), "utf8")).toBe(before);
  });
});


describe("operation-specific oversized failure categories", () => {
  it.each(["request_timeout", "source_deadline", "incomplete_response"])("preserves %s without relabeling it as evidence validation", async category => {
    const directory = root(); oversized(directory, 1);
    const operation = "operation_" + "c".repeat(32);
    const spawn: Spawn = (_command, args) => {
      expect(args).toContain("scripts/run-oversized-chunk-nemotron.mjs");
      put(directory, "chunk-001-attempt-001-error.json", { category });
      return result(7);
    };
    await expect(run(directory, "run-oversized-orchestrator.mjs", [...orchestratorArgs(directory), "--operation-id", operation], spawn)).rejects.toThrow(/exit 7/);
    expect(get(directory, "failure-" + operation + ".json")).toMatchObject({
      workspace: WORKSPACE, operation_id: operation, source_conversation_id: SOURCE,
      failure_code: category
    });
    expect(fs.existsSync(path.join(directory, "chunk-001-output.json"))).toBe(false);
  });
});


it("reports a rejected cached output as current evidence validation, not an older failure", async () => {
  const directory = root(); oversized(directory, 1); completeChunk(directory, "001");
  const operation = "operation_" + "d".repeat(32);
  const spawn: Spawn = (_command, args) => { expect(args).toContain("validate"); return result(1); };
  await expect(run(directory, "run-oversized-orchestrator.mjs", [...orchestratorArgs(directory), "--operation-id", operation], spawn)).rejects.toThrow(/Validation failed/);
  expect(get(directory, "failure-" + operation + ".json").failure_code).toBe("evidence_validation");
});

describe('bounded source retry holds',()=>{
 it.each(['request_timeout','source_deadline','rate_limited','provider_unavailable','incomplete_response'])('two distinct %s operations defer a source without changing its evidence',async failure_code=>{
   const directory=root();priority(directory);standardArtifacts(directory);const before=fs.readFileSync(path.join(directory,BASE+'-input.json'),'utf8');
   for(const suffix of ['a','b'])put(directory,'.runtime/reconstruction/batch-receipts/'+suffix+'.json',{schema_version:'hhs-reconstruction-batch/0.1.0',workspace:WORKSPACE,operation_id:'operation_'+suffix.repeat(32),status:'failed',finished_at:'2026-01-01T00:00:00Z',completed:[],quarantined:[{source_conversation_id:SOURCE,reason:'exit 1',failure_code}]});
   await run(directory,'run-reconstruction-batch.mjs',BATCH_ARGS,(_command,args)=>{if(args.includes('scripts/reconstruction-inventory.ts'))return inventory();throw Error('Held source must not run');});
   expect(batchReceipt(directory)).toMatchObject({selected:0,skipped_quarantined_count:1});expect(fs.readFileSync(path.join(directory,BASE+'-input.json'),'utf8')).toBe(before);
 });
 it.each(['one','duplicate','auth','other-workspace'])('does not derive a source retry hold from %s',async mode=>{
   const directory=root();priority(directory);standardArtifacts(directory);
   for(const [index,suffix]of ['a','b'].entries()){if(mode==='one'&&index)continue;put(directory,'.runtime/reconstruction/batch-receipts/'+suffix+'.json',{schema_version:'hhs-reconstruction-batch/0.1.0',workspace:mode==='other-workspace'?'other':WORKSPACE,operation_id:'operation_'+(mode==='duplicate'?'a':suffix).repeat(32),status:'failed',finished_at:'2026-01-01T00:00:00Z',completed:[],quarantined:[{source_conversation_id:SOURCE,reason:'exit 1',failure_code:mode==='auth'?'provider_auth':'request_timeout'}]});}
   let writes=0;await run(directory,'run-reconstruction-batch.mjs',BATCH_ARGS,(_command,args)=>{if(args.includes('scripts/reconstruction-inventory.ts'))return inventory();if(args.includes('validate'))return validate(directory,args);if(args.includes('persist')){writes++;return persistResult();}throw Error('Unexpected model request');});expect(writes).toBe(1);
 });
 it.each([502,503,504,401,402,403])('classifies preserved provider HTTP %s without weakening hard failures',async code=>{
   const directory=root();oversized(directory,1);const operation='operation_'+'c'.repeat(32);
   await expect(run(directory,'run-oversized-orchestrator.mjs',[...orchestratorArgs(directory),'--operation-id',operation],(_command,args)=>{if(args.includes('scripts/run-oversized-chunk-nemotron.mjs')){put(directory,'chunk-001-attempt-001-error.json',{category:'provider_error',http_status:code,provider_error_code:code});return result(7);}throw Error('Unexpected work');})).rejects.toThrow(/stopped with exit/);
   expect(get(directory,'failure-'+operation+'.json').failure_code).toBe([502,503,504].includes(code)?'provider_unavailable':'reconstruction_failed');
 });
});

describe('typed content holds preserve other eligible work',()=>{
 it.each(['evidence_validation','model_output_truncated','malformed_model_json'])('holds exhausted %s output without regenerating or persisting it',async failure_code=>{
  const directory=root();priority(directory);standardArtifacts(directory);put(directory,'.runtime/reconstruction/batch-receipts/batch-2026-01-01-held.json',{schema_version:'hhs-reconstruction-batch/0.1.0',workspace:WORKSPACE,status:'failed',finished_at:'2026-01-01T00:00:00Z',completed:[],quarantined:[{source_conversation_id:SOURCE,reason:'exit 1',failure_code}]});
  await run(directory,'run-reconstruction-batch.mjs',BATCH_ARGS,(_cmd,args)=>{if(args.includes('scripts/reconstruction-inventory.ts'))return inventory();throw Error('Held source must not run');});expect(batchReceipt(directory)).toMatchObject({selected:0,skipped_quarantined_count:1});
 });
 it('processes a healthy second source while leaving the failed source and receipt unchanged',async()=>{
  const directory=root();priority(directory);standardArtifacts(directory);const second='healthy-source',held={schema_version:'hhs-reconstruction-batch/0.1.0',workspace:WORKSPACE,status:'failed',finished_at:'2026-01-01T00:00:00Z',completed:[],quarantined:[{source_conversation_id:SOURCE,reason:'exit 1',failure_code:'evidence_validation'}]};
  put(directory,'.runtime/reconstruction/batch-receipts/batch-2026-01-01-held.json',held);const index=get(directory,'.runtime/reconstruction/business-priority-index-v1.json');index.conversations.push({...index.conversations[0],source_conversation_id:second,unprocessed_queue_rank:2});put(directory,'.runtime/reconstruction/business-priority-index-v1.json',index);
  const input=exchange('healthy');input.selection[0]!.source_conversation_id=second;input.evidence[0]!.source_conversation_id=second;input.evidence_sha256=sha256(input.evidence);const candidate=output(input);candidate.observations[0]!.source_conversation_id=second;const base='.runtime/reconstruction/priority-runs/priority-0002-'+second;put(directory,base+'-input.json',input);put(directory,base+'-output.json',candidate);put(directory,base+'-openrouter-raw.json',{model:MODEL});
  let writes=0;await run(directory,'run-reconstruction-batch.mjs',BATCH_ARGS,(_cmd,args)=>{if(args.includes('scripts/reconstruction-inventory.ts'))return result(0,{workspace_id:WORKSPACE,conversations:[SOURCE,second].map(id=>({source_conversation_id:id,source_version_id:'version',capture_version_id:null,discovery_status:'unprocessed'}))});if(args.includes('validate'))return validate(directory,args);if(args.includes('persist')){writes++;return persistResult();}throw Error('No model call expected');});
  expect(writes).toBe(1);expect(batchReceipt(directory)).toMatchObject({selected:1,skipped_quarantined_count:1,completed:[{source_conversation_id:second}]});expect(get(directory,'.runtime/reconstruction/batch-receipts/batch-2026-01-01-held.json')).toEqual(held);expect(get(directory,BASE+'-output.json')).toEqual(output());
 });
});


describe('standard provider terminal failure propagation', () => {
  it('correlates safe native diagnostics to the owned operation and preserves failed attempts', async () => {
    const directory = root(); priority(directory);
    const operation = 'operation_' + 'a'.repeat(32);
    let generated = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes('scripts/reconstruction-inventory.ts')) return inventory();
      if (args.includes('scripts/run-next-priority-nemotron.mjs')) {
        expect(argument(args, 'operation-id')).toBe(operation);
        generated++;
        const stamp = Date.now();
        put(directory, `${BASE}-${stamp}-${123 + generated}-provider-attempts.json`, {
          schema_version: 'hhs-provider-attempts/1', workspace: WORKSPACE, source_conversation_id: SOURCE,
          operation_id: operation, attempts: [
            { model: 'nvidia/nemotron-3-super-120b-a12b:free', attempt: 1, at: new Date(stamp).toISOString(), category: 'provider_error', http_status: 404, provider_error_code: 404 },
            { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', attempt: 1, at: new Date(stamp).toISOString(), category: 'request_timeout' }
          ]
        });
        put(directory, `${BASE}-input.json`, exchange()); return result(7);
      }
      throw new Error('No persistence or unrelated subprocess authorized');
    };
    expect((await run(directory, 'run-reconstruction-batch.mjs', [...BATCH_ARGS, '--limit', '5', '--operation-id', operation], spawn)).code).toBe(2);
    expect(generated).toBe(2);
    const failed = batchReceipt(directory).quarantined[0];
    expect(failed.failure_code).toBe('request_timeout');
    expect(failed.provider_failure_evidence).toHaveLength(2);
    expect(fs.readdirSync(path.join(directory, '.runtime/reconstruction/priority-runs/failed-attempts/priority-0001-synthetic-source'))).toHaveLength(2);
    for (const name of failed.provider_failure_evidence) expect(fs.existsSync(path.join(directory, '.runtime/reconstruction/priority-runs', name))).toBe(true);
  });
});


describe('current-operation oversized linker failure propagation', () => {
  it.each([
    [{ category: 'provider_error', http_status: 200, provider_error_code: 503 }, 'provider_unavailable'],
    [{ category: 'request_timeout' }, 'request_timeout'],
    [{ category: 'provider_error', http_status: 401 }, 'provider_auth'],
    [{ category: 'provider_error', http_status: 402 }, 'provider_credit'],
    [{ category: 'provider_error', http_status: 403 }, 'provider_auth'],
    [{ category: 'provider_policy' }, 'provider_policy'],
    [{ category: 'request_failed' }, 'reconstruction_failed'],
    [{ category: 'provider_error', http_status: 400 }, 'reconstruction_failed'],
    [{ category: 'provider_error', http_status: 200, provider_error_code: 503, attempts: [{ category: 'provider_auth' }, { category: 'provider_error', provider_error_code: 503 }] }, 'provider_auth']
  ])('preserves typed linker failure %j without persisting or regenerating validated chunks', async (diagnostic, expected) => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, '001');
    const operation = 'operation_' + 'a'.repeat(32);
    const chunkBefore = fs.readFileSync(path.join(directory, 'chunk-001-output.json'));
    const spawn: Spawn = (_command, args) => {
      if (args.includes('validate')) return validate(directory, args);
      if (args.includes('scripts/run-oversized-linker-nemotron.mjs')) {
        put(directory, 'parent-link-attempt-001-request.json', { request_version: LINKING_REQUEST_VERSION });
        put(directory, 'parent-link-attempt-001-error.json', diagnostic); return result(7);
      }
      throw Error('No chunk regeneration or persistence permitted');
    };
    await expect(run(directory, 'run-oversized-orchestrator.mjs', [...orchestratorArgs(directory), '--operation-id', operation], spawn)).rejects.toThrow(/Linker stopped/);
    expect(get(directory, 'failure-' + operation + '.json').failure_code).toBe(expected);
    expect(fs.readFileSync(path.join(directory, 'chunk-001-output.json'))).toEqual(chunkBefore);
    expect(fs.existsSync(path.join(directory, 'parent-output.json'))).toBe(false);
  });
  it('does not use an older linker 503 to explain a new failure without diagnostics', async () => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, '001');
    put(directory, 'parent-link-attempt-001-error.json', { category: 'provider_error', provider_error_code: 503 });
    const operation = 'operation_' + 'b'.repeat(32);
    const spawn: Spawn = (_command, args) => args.includes('validate') ? validate(directory, args) : result(7);
    await expect(run(directory, 'run-oversized-orchestrator.mjs', [...orchestratorArgs(directory), '--operation-id', operation], spawn)).rejects.toThrow();
    expect(get(directory, 'failure-' + operation + '.json').failure_code).toBe('reconstruction_failed');
  });
  it('resumes the same validated chunks after a failed linker, preserving the original failed operation', async () => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, '001');
    const operation = 'operation_' + 'c'.repeat(32);
    const chunk = fs.readFileSync(path.join(directory, 'chunk-001-output.json'));
    let fail = true, calls = 0;
    const spawn: Spawn = (_command, args) => {
      if (args.includes('validate')) return validate(directory, args);
      if (args.includes('scripts/run-oversized-linker-nemotron.mjs')) {
        calls++;
        if (fail) { put(directory, 'parent-link-attempt-001-error.json', { category: 'provider_error', http_status: 200, provider_error_code: 503 }); return result(7); }
        completeParent(directory); return result();
      }
      throw Error('Validated chunks must be reused');
    };
    await expect(run(directory, 'run-oversized-orchestrator.mjs', [...orchestratorArgs(directory), '--operation-id', operation], spawn)).rejects.toThrow();
    const failed = fs.readFileSync(path.join(directory, 'failure-' + operation + '.json'));
    fail = false;
    expect((await run(directory, 'run-oversized-orchestrator.mjs', [...orchestratorArgs(directory), '--operation-id', 'operation_' + 'd'.repeat(32)], spawn)).code).toBe(0);
    expect(calls).toBe(2);
    expect(fs.readFileSync(path.join(directory, 'failure-' + operation + '.json'))).toEqual(failed);
    expect(fs.readFileSync(path.join(directory, 'chunk-001-output.json'))).toEqual(chunk);
  });
  it.each([401, 402, 403])('the linker stops after hard HTTP %s without a fallback, while preserving safe attempt metadata', async status => {
    const directory = root(); oversized(directory, 1); completeChunk(directory, '001');
    put(directory, 'parent-deterministic-merged-output.json', output(get(directory, 'parent-input.json')));
    let calls = 0;
    const fetch = async () => { calls++; return { ok: false, status, json: async () => ({ error: { code: status, message: 'private echoed source' } }) }; };
    expect((await run(directory, 'run-oversized-linker-nemotron.mjs', ['--run-dir', directory], () => { throw Error('No validation after provider denial'); }, fetch)).code).toBe(7);
    expect(calls).toBe(1);
    const diagnostic = get(directory, 'parent-link-attempt-001-error.json');
    expect(diagnostic.attempts).toHaveLength(1);
    expect(JSON.stringify(diagnostic)).not.toContain('private echoed source');
    expect(get(directory, 'parent-link-attempt-001-provider-attempts.json').attempts).toHaveLength(1);
  });
});
