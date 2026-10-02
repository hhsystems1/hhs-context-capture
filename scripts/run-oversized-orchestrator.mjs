import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const RUN_DIR = required("run-dir");
const WORKSPACE = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
const MAX_ATTEMPTS = Number(flag("max-attempts") ?? 2);
const MAX_DEPTH = Number(flag("max-depth") ?? 3);
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const PROVIDER = "openrouter";
const VERSION = "hhs-oversized-orchestrator/0.1.0";

if (!WORKSPACE) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not loaded.");
if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS < 1) throw new Error("Invalid --max-attempts.");
if (!Number.isInteger(MAX_DEPTH) || MAX_DEPTH < 1) throw new Error("Invalid --max-depth.");

console.log("=== RESUMABLE OVERSIZED RECONSTRUCTION ===");
processRun(RUN_DIR, 0);
finalize(RUN_DIR);
console.log("DATABASE WRITES: NONE");

function processRun(directory, depth) {
  const manifest = read(path.join(directory, "manifest.json"));
  for (const chunk of manifest.chunks) {
    const number = pad(chunk.chunk_number);
    const output = path.join(directory, `chunk-${number}-output.json`);
    if (fs.existsSync(output)) {
      console.log(`SKIP ${chunk.chunk_number}/${chunk.chunk_count}`);
      continue;
    }

    while (
      !fs.existsSync(output)
      && attempts(directory, number) < MAX_ATTEMPTS
    ) {
      const result = run(process.execPath, [
        "scripts/run-oversized-chunk-nemotron.mjs", "--run-dir", directory
      ]);
      if (result.status === 0 && fs.existsSync(output)) break;
      if (result.status !== 8) {
        throw new Error(`Chunk ${number} stopped with exit ${result.status}; review required.`);
      }
    }

    if (fs.existsSync(output)) continue;

    if (depth >= MAX_DEPTH) throw new Error(`Chunk ${number} reached split-depth limit.`);
    const subrun = prepareSubrun(directory, chunk, depth + 1);
    processRun(subrun, depth + 1);
    merge(directory, chunk, subrun);
  }
}

function prepareSubrun(directory, chunk, depth) {
  const number = pad(chunk.chunk_number);
  const subrun = path.join(directory, `chunk-${number}-subrun`);
  if (fs.existsSync(path.join(subrun, "manifest.json"))) return subrun;
  const input = path.join(directory, chunk.input_file);
  const target = Math.max(12000, Math.floor(chunk.evidence_characters / 2));
  const result = capture("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", "export-chunks",
    "--workspace", WORKSPACE, "--exchange", input,
    "--max-evidence-characters", String(target)
  ]);
  const bundle = JSON.parse(result.stdout);
  if (bundle.chunks.length < 2) {
    throw new Error(`Chunk ${number} is one unsplittable message; quarantined.`);
  }
  fs.mkdirSync(subrun);
  write(path.join(subrun, "parent-input.json"), bundle.parent_exchange);
  const selection = bundle.parent_exchange.selection?.[0];
  const manifest = {
    schema_version: "hhs-oversized-discovery-run/0.1.0",
    parent_exchange_id: bundle.parent_exchange.exchange_id,
    source_conversation_id: selection.source_conversation_id,
    title: `${selection.title} — automatic split depth ${depth}`,
    max_evidence_characters: target,
    chunk_count: bundle.chunks.length,
    chunks: []
  };
  for (const child of bundle.chunks) {
    const childNumber = pad(child.chunk_number);
    const inputFile = `chunk-${childNumber}-input.json`;
    write(path.join(subrun, inputFile), child.exchange);
    manifest.chunks.push({
      chunk_number: child.chunk_number, chunk_count: child.chunk_count,
      input_file: inputFile, exchange_id: child.exchange.exchange_id,
      evidence_rows: child.exchange.evidence.length,
      message_count: child.exchange.selection[0].message_count,
      evidence_characters: child.evidence_characters,
      exceeds_target: child.exceeds_target, status: "prepared"
    });
  }
  write(path.join(subrun, "manifest.json"), manifest);
  console.log(`SPLIT chunk ${number} into ${bundle.chunks.length}`);
  return subrun;
}

function merge(directory, chunk, subrun) {
  const number = pad(chunk.chunk_number);
  const parentInput = path.join(directory, chunk.input_file);
  const parent = read(parentInput);
  const manifest = read(path.join(subrun, "manifest.json"));
  const observations = [];
  const links = [];
  for (const child of manifest.chunks) {
    const childNumber = pad(child.chunk_number);
    const data = read(path.join(subrun, `chunk-${childNumber}-output.json`));
    const refs = new Map();
    for (const observation of data.observations ?? []) {
      const ref = `sub${childNumber}__${observation.observation_ref}`;
      refs.set(observation.observation_ref, ref);
      observations.push({ ...observation, observation_ref: ref });
    }
    for (const link of data.links ?? []) {
      const from = refs.get(link.from_observation_ref);
      const to = refs.get(link.to_observation_ref);
      if (from && to) links.push({ ...link, from_observation_ref: from, to_observation_ref: to });
    }
  }
  const merged = path.join(directory, `chunk-${number}-deterministic-merged-output.json`);
  if (!fs.existsSync(merged)) write(merged, {
    schema_version: "hhs-understanding-output/0.2.0",
    exchange_id: parent.exchange_id, observations, links
  });
  validate(parentInput, merged);
  copy(merged, path.join(directory, `chunk-${number}-output.json`));
  writeIfMissing(path.join(directory, `chunk-${number}-model.json`), {
    provider: PROVIDER, model: MODEL, runner_version: VERSION,
    composition: `${manifest.chunk_count} automatically validated subchunks`,
    merged_artifact: path.basename(merged), validated: true
  });
  console.log(`PROMOTED ${chunk.chunk_number}/${chunk.chunk_count}`);
}

function finalize(directory) {
  const finalOutput = path.join(directory, "parent-output.json");
  if (fs.existsSync(finalOutput)) return;
  const parentInput = path.join(directory, "parent-input.json");
  const parent = read(parentInput);
  const manifest = read(path.join(directory, "manifest.json"));
  const merged = path.join(directory, "parent-deterministic-merged-output.json");
  if (!fs.existsSync(merged)) {
    const observations = [];
    const links = [];
    for (const chunk of manifest.chunks) {
      const number = pad(chunk.chunk_number);
      const data = read(path.join(directory, `chunk-${number}-output.json`));
      const refs = new Map();
      for (const observation of data.observations ?? []) {
        const ref = `chunk${number}__${observation.observation_ref}`;
        refs.set(observation.observation_ref, ref);
        observations.push({ ...observation, observation_ref: ref });
      }
      for (const link of data.links ?? []) {
        const from = refs.get(link.from_observation_ref);
        const to = refs.get(link.to_observation_ref);
        if (from && to) links.push({ ...link, from_observation_ref: from, to_observation_ref: to });
      }
    }
    write(merged, {
      schema_version: "hhs-understanding-output/0.2.0",
      exchange_id: parent.exchange_id, observations, links
    });
  }
  validate(parentInput, merged);
  for (let index = linkerAttempts(directory); index < MAX_ATTEMPTS; index += 1) {
    const result = run(process.execPath, [
      "scripts/run-oversized-linker-nemotron.mjs", "--run-dir", directory
    ]);
    if (result.status === 0 && fs.existsSync(finalOutput)) return;
    if (result.status !== 8) throw new Error(`Linker stopped with exit ${result.status}.`);
  }
  throw new Error("Linker attempt limit reached.");
}

function validate(exchange, output) {
  const result = run("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", "validate",
    "--exchange", exchange, "--output", output,
    "--provider", PROVIDER, "--model", MODEL,
    "--runner-version", VERSION
  ]);
  if (result.status !== 0) throw new Error(`Validation failed: ${output}`);
}

function attempts(directory, number) {
  const pattern = new RegExp(`^chunk-${number}-attempt-(\\d+)-openrouter-raw\\.json$`);
  return new Set(fs.readdirSync(directory).map((name) => name.match(pattern)?.[1]).filter(Boolean)).size;
}
function linkerAttempts(directory) {
  return fs.readdirSync(directory).filter((name) => /^parent-link-attempt-\d+-raw\.json$/.test(name)).length;
}
function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
}
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed.`);
  return result;
}
function write(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporary, file);
}
function writeIfMissing(file, value) { if (!fs.existsSync(file)) write(file, value); }
function copy(source, destination) {
  if (fs.existsSync(destination)) return;
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temporary, destination);
}
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function pad(value) { return String(value).padStart(3, "0"); }
function flag(name) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; }
function required(name) { const value = flag(name); if (!value) throw new Error(`--${name} is required.`); return value; }
