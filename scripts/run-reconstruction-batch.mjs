import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const WORKSPACE = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
const LIMIT = Number(flag("limit") ?? "10");
const CHUNK_CHARACTERS = Number(flag("chunk-characters") ?? "75000");
const SINGLE_RUN_TOKENS = 75000;
const PRIORITY_PATH = ".runtime/reconstruction/business-priority-index-v1.json";
const PRIORITY_RUNS = ".runtime/reconstruction/priority-runs";
const OVERSIZED_RUNS = ".runtime/reconstruction/oversized-runs";
const PROVIDER = "openrouter";
const STANDARD_VERSION = "hhs-priority-nemotron-runner/0.1.0";
const OVERSIZED_VERSION = "hhs-oversized-linker/0.1.0";

if (!WORKSPACE) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");
if (!Number.isInteger(LIMIT) || LIMIT < 1) throw new Error("--limit must be a positive integer.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not loaded.");

const priority = read(PRIORITY_PATH);
const inventory = inventoryJson();
const persisted = new Set(
  inventory.conversations
    .filter((item) => item.discovery_status === "discovery_processed")
    .map((item) => item.source_conversation_id)
);
const candidates = priority.conversations
  .filter((item) => !item.evidence_issue && !persisted.has(item.source_conversation_id))
  .sort((a, b) => a.unprocessed_queue_rank - b.unprocessed_queue_rank)
  .slice(0, LIMIT);

const receipt = {
  schema_version: "hhs-reconstruction-batch/0.1.0",
  started_at: new Date().toISOString(),
  workspace: WORKSPACE,
  requested: LIMIT,
  completed: [],
  quarantined: []
};

for (const candidate of candidates) {
  console.log(`\n=== ${candidate.unprocessed_queue_rank}: ${candidate.title} ===`);
  try {
    const result = candidate.estimated_input_tokens > SINGLE_RUN_TOKENS
      ? processOversized(candidate)
      : processStandard(candidate);
    receipt.completed.push(result);
  } catch (error) {
    const item = {
      source_conversation_id: candidate.source_conversation_id,
      title: candidate.title,
      reason: String(error)
    };
    receipt.quarantined.push(item);
    console.error("QUARANTINED:", item.reason);
  }
  writeReceipt(receipt);
}

receipt.finished_at = new Date().toISOString();
writeReceipt(receipt);
console.log("\n=== BATCH COMPLETE ===");
console.log("completed:", receipt.completed.length);
console.log("quarantined:", receipt.quarantined.length);
console.log("receipt:", receiptPath());

function processStandard(candidate) {
  const rank = String(candidate.unprocessed_queue_rank).padStart(4, "0");
  const base = `priority-${rank}-${candidate.source_conversation_id}`;
  const exchange = path.join(PRIORITY_RUNS, `${base}-input.json`);
  const output = path.join(PRIORITY_RUNS, `${base}-output.json`);
  const raw = path.join(PRIORITY_RUNS, `${base}-openrouter-raw.json`);

  if (!fs.existsSync(output)) {
    checked(process.execPath, [
      "scripts/run-next-priority-nemotron.mjs",
      "--conversation", candidate.source_conversation_id
    ]);
  }
  if (!fs.existsSync(exchange) || !fs.existsSync(output) || !fs.existsSync(raw)) {
    throw new Error("standard run did not produce a complete validated artifact set");
  }
  const model = read(raw).model;
  if (!model) throw new Error("standard raw response does not identify its model");
  validate(exchange, output, model, STANDARD_VERSION);
  const persistedResult = persist(exchange, output, model, STANDARD_VERSION);
  return summary(candidate, "standard", persistedResult);
}

function processOversized(candidate) {
  const rank = String(candidate.unprocessed_queue_rank).padStart(4, "0");
  const directory = path.join(
    OVERSIZED_RUNS,
    `priority-${rank}-${candidate.source_conversation_id}`
  );
  if (!fs.existsSync(path.join(directory, "manifest.json"))) {
    prepareOversized(candidate, directory);
  }
  if (!fs.existsSync(path.join(directory, "parent-output.json"))) {
    checked(process.execPath, [
      "scripts/run-oversized-orchestrator.mjs",
      "--run-dir", directory,
      "--workspace", WORKSPACE
    ]);
  }
  const exchange = path.join(directory, "parent-input.json");
  const output = path.join(directory, "parent-output.json");
  const modelFile = path.join(directory, "parent-model.json");
  if (!fs.existsSync(modelFile)) throw new Error("oversized parent model receipt is missing");
  const model = read(modelFile).model;
  validate(exchange, output, model, OVERSIZED_VERSION);
  const persistedResult = persist(exchange, output, model, OVERSIZED_VERSION);
  return summary(candidate, "oversized", persistedResult);
}

function prepareOversized(candidate, directory) {
  const result = captured("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", "export-chunks",
    "--workspace", WORKSPACE,
    "--conversation", candidate.source_conversation_id,
    "--max-evidence-characters", String(CHUNK_CHARACTERS)
  ]);
  const bundle = JSON.parse(result.stdout);
  const selection = bundle.parent_exchange.selection?.[0];
  if (!selection) throw new Error("oversized export has no selected conversation");
  fs.mkdirSync(directory, { recursive: true });
  write(path.join(directory, "parent-input.json"), bundle.parent_exchange);
  const manifest = {
    schema_version: "hhs-oversized-discovery-run/0.1.0",
    parent_exchange_id: bundle.parent_exchange.exchange_id,
    source_conversation_id: selection.source_conversation_id,
    title: selection.title,
    max_evidence_characters: CHUNK_CHARACTERS,
    chunk_count: bundle.chunks.length,
    chunks: []
  };
  for (const chunk of bundle.chunks) {
    const number = String(chunk.chunk_number).padStart(3, "0");
    const inputFile = `chunk-${number}-input.json`;
    write(path.join(directory, inputFile), chunk.exchange);
    manifest.chunks.push({
      chunk_number: chunk.chunk_number,
      chunk_count: chunk.chunk_count,
      input_file: inputFile,
      exchange_id: chunk.exchange.exchange_id,
      evidence_rows: chunk.exchange.evidence.length,
      message_count: chunk.exchange.selection[0].message_count,
      evidence_characters: chunk.evidence_characters,
      exceeds_target: chunk.exceeds_target,
      status: "prepared"
    });
  }
  write(path.join(directory, "manifest.json"), manifest);
}

function validate(exchange, output, model, version) {
  checked("npx", discoveryArgs("validate", exchange, output, model, version));
}

function persist(exchange, output, model, version) {
  const result = captured("npx", discoveryArgs("persist", exchange, output, model, version));
  process.stdout.write(result.stdout);
  return JSON.parse(result.stdout);
}

function discoveryArgs(command, exchange, output, model, version) {
  return [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", command,
    "--workspace", WORKSPACE,
    "--exchange", exchange,
    "--output", output,
    "--provider", PROVIDER,
    "--model", model,
    "--runner-version", version
  ];
}

function inventoryJson() {
  return JSON.parse(captured("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/reconstruction-inventory.ts", "json",
    "--workspace", WORKSPACE
  ]).stdout);
}

function summary(candidate, mode, result) {
  return {
    source_conversation_id: candidate.source_conversation_id,
    title: candidate.title,
    priority_rank: candidate.unprocessed_queue_rank,
    mode,
    observations_inserted: result.observations_inserted,
    observation_links_inserted: result.observation_links_inserted,
    provenance_edges_inserted: result.provenance_edges_inserted,
    replay: result.replay
  };
}

function receiptPath() {
  return path.join(
    ".runtime/reconstruction/batch-receipts",
    `batch-${receipt.started_at.replace(/[:.]/g, "-")}.json`
  );
}

function writeReceipt(value) {
  const destination = receiptPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, destination);
}

function checked(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result;
}

function captured(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  return result;
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
