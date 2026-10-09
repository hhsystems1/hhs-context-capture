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
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "hhs-runner-unit-")); roots.push(value); return value; }
function put(directory: string, file: string, value: unknown): void {
  const destination = path.resolve(directory, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(value, null, 2) + "\n");
}
function get(directory: string, file: string): any { return JSON.parse(fs.readFileSync(path.resolve(directory, file), "utf8")); }
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
    expect(attempts).toBe(3);
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
