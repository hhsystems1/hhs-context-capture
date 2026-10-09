import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const RUN_DIR = required("run-dir");
const WORKSPACE = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
const MAX_ATTEMPTS = Number(flag("max-attempts") ?? 3);
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
    if (resumeValidatedOutput(directory, `chunk-${number}`, path.join(directory, chunk.input_file))) {
      console.log(`SKIP ${chunk.chunk_number}/${chunk.chunk_count}`);
      continue;
    }

    let remainingAttempts = Math.max(0, MAX_ATTEMPTS - attempts(directory, number));
    while (
      !fs.existsSync(output)
      && remainingAttempts-- > 0
    ) {
      const result = run(process.execPath, [
        "scripts/run-oversized-chunk-nemotron.mjs", "--run-dir", directory
      ]);
      if (result.status === 0 && resumeValidatedOutput(directory, `chunk-${number}`, path.join(directory, chunk.input_file))) break;
      if (![8, 9].includes(result.status)) {
        throw new Error(`Chunk ${number} stopped with exit ${result.status}; review required.`);
      }

      if (result.status === 8) {
        console.error(
          `Chunk ${number} returned unrecoverable model JSON; preserving attempt and retrying/splitting.`
        );
      }

      if (result.status === 9) {
        console.error(
          `Chunk ${number} failed trusted validation; preserving attempt and retrying/splitting.`
        );
      }
    }

    if (resumeValidatedOutput(directory, `chunk-${number}`, path.join(directory, chunk.input_file))) continue;

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
  fs.mkdirSync(subrun, { recursive: true });
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
  writeIfMissing(path.join(directory, `chunk-${number}-model.json`), {
    provider: PROVIDER, model: MODEL, runner_version: VERSION,
    composition: `${manifest.chunk_count} automatically validated subchunks`,
    merged_artifact: path.basename(merged), validated: true
  });
  copy(merged, path.join(directory, `chunk-${number}-output.json`));
  console.log(`CHUNK ASSEMBLED ${chunk.chunk_number}/${chunk.chunk_count}`);
}

function finalize(directory) {
  const parentInput = path.join(directory, "parent-input.json");
  if (resumeValidatedOutput(directory, "parent", parentInput)) return;
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
    if (result.status === 0 && resumeValidatedOutput(directory, "parent", parentInput)) return;
    if (![8, 9].includes(result.status)) throw new Error(`Linker stopped with exit ${result.status}.`);
  }
  throw new Error("Linker attempt limit reached.");
}

function validate(exchange, output, model = MODEL, version = VERSION) {
  const result = run("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", "validate",
    "--workspace", WORKSPACE,
    "--exchange", exchange, "--output", output,
    "--provider", PROVIDER, "--model", model,
    "--runner-version", version
  ]);
  if (result.status !== 0) throw new Error(`Validation failed: ${output}`);
}

// Revalidate cached artifacts before skipping. Recover a torn publication only
// from its existing validated attempt/receipt; never guess a model or evidence.
function resumeValidatedOutput(directory, prefix, input) {
  const output = path.join(directory, `${prefix}-output.json`);
  const modelFile = path.join(directory, `${prefix}-model.json`);
  if (!fs.existsSync(output) && !fs.existsSync(modelFile)) return false;
  let receipt;
  let source = output;
  if (fs.existsSync(modelFile)) {
    receipt = read(modelFile);
    if (!fs.existsSync(output)) {
      source = receipt.merged_artifact
        ? path.join(directory, receipt.merged_artifact)
        : path.join(directory, prefix === "parent"
          ? `parent-link-attempt-${pad(receipt.attempt)}-output.json`
          : `${prefix}-attempt-${pad(receipt.attempt)}-output.json`);
    }
  } else {
    const pattern = prefix === "parent"
      ? /^parent-link-attempt-(\d+)-raw\.json$/
      : new RegExp(`^${prefix}-attempt-(\\d+)-openrouter-raw\\.json$`);
    for (const name of fs.readdirSync(directory).sort()) {
      const match = name.match(pattern);
      if (!match) continue;
      const attempted = path.join(directory, prefix === "parent"
        ? `parent-link-attempt-${match[1]}-output.json`
        : `${prefix}-attempt-${match[1]}-output.json`);
      if (!fs.existsSync(attempted) || !fs.readFileSync(attempted).equals(fs.readFileSync(output))) continue;
      const raw = read(path.join(directory, name));
      const model = raw.model;
      if (typeof model !== "string" || !model.trim()) continue;
      receipt = { provider: PROVIDER, model, attempt: Number(match[1]), validated: true, recovered_from_attempt: true,
        ...(typeof raw.json_repaired === "boolean" ? { json_repaired: raw.json_repaired } : {}),
        runner_version: prefix === "parent" ? "hhs-oversized-linker/0.1.0" : "hhs-oversized-nemotron-runner/0.1.0" };
      break;
    }
  }
  if (receipt?.validated !== true || typeof receipt.model !== "string" || !receipt.model.trim()
      || typeof receipt.runner_version !== "string" || !fs.existsSync(source)) {
    throw new Error(`Incomplete validated model receipt for ${prefix}; review required.`);
  }
  validate(input, source, receipt.model, receipt.runner_version);
  writeIfMissing(modelFile, receipt);
  copy(source, output);
  return true;
}

function attempts(directory, number) {
  const pattern = new RegExp(`^chunk-${number}-attempt-(\\d+)-(?:openrouter-raw|output)\\.json$`);
  return new Set(fs.readdirSync(directory).map((name) => name.match(pattern)?.[1]).filter(Boolean)).size;
}
function linkerAttempts(directory) {
  return fs.readdirSync(directory).filter((name) => /^parent-link-attempt-\d+-raw\.json$/.test(name)).length;
}
function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, env: { ...process.env, MEMORY_WORKSPACE_ID: WORKSPACE }, stdio: "inherit" });
}
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed.`);
  return result;
}
function write(file, value) {
  if (fs.existsSync(file)) {
    if (JSON.stringify(read(file)) !== JSON.stringify(value)) throw new Error(`Immutable artifact collision: ${file}`);
    return;
  }
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
