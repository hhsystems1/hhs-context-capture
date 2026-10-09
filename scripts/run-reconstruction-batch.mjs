import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const WORKSPACE = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
const LIMIT = Number(flag("limit") ?? "10");
const CHUNK_CHARACTERS = Number(flag("chunk-characters") ?? "75000");
const TARGET_CONVERSATION = flag("conversation");
const OPERATION_ID = flag("operation-id");
if (process.argv.includes("--operation-id") && (OPERATION_ID === undefined || !/^operation_[0-9a-f]{32}$/.test(OPERATION_ID))) throw new Error("Invalid --operation-id.");
const SINGLE_RUN_TOKENS = 75000;
const PRIORITY_PATH = ".runtime/reconstruction/business-priority-index-v1.json";
const PRIORITY_RUNS = ".runtime/reconstruction/priority-runs";
const OVERSIZED_RUNS = ".runtime/reconstruction/oversized-runs";
const PROVIDER = "openrouter";
const STANDARD_VERSION = "hhs-priority-nemotron-runner/0.1.0";
const OVERSIZED_VERSION = "hhs-oversized-linker/0.1.0";
const STANDARD_MAX_ATTEMPTS = 3;

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
const eligible = priority.conversations
  .filter((item) => !item.evidence_issue && !persisted.has(item.source_conversation_id))
  .sort((a, b) => a.unprocessed_queue_rank - b.unprocessed_queue_rank);

const candidates = TARGET_CONVERSATION
  ? eligible
      .filter((item) => item.source_conversation_id === TARGET_CONVERSATION)
      .slice(0, LIMIT)
  : eligible.slice(0, LIMIT);

if (TARGET_CONVERSATION && candidates.length === 0) {
  throw new Error(
    `Conversation ${TARGET_CONVERSATION} is not an eligible unprocessed reconstruction candidate.`
  );
}

const receipt = {
  schema_version: "hhs-reconstruction-batch/0.1.0",
  started_at: new Date().toISOString(),
  workspace: WORKSPACE,
  ...(OPERATION_ID ? { operation_id: OPERATION_ID } : {}),
  requested: LIMIT,
  selected: candidates.length,
  ...(TARGET_CONVERSATION ? { conversation: TARGET_CONVERSATION } : {}),
  status: "running",
  completed: [],
  quarantined: []
};
writeReceipt(receipt);

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
receipt.status = receipt.quarantined.length > 0
  ? (receipt.completed.length > 0 ? "partial" : "failed")
  : "completed";
writeReceipt(receipt);
console.log("\n=== BATCH FINISHED ===");
console.log("status:", receipt.status);
console.log("completed:", receipt.completed.length);
console.log("quarantined:", receipt.quarantined.length);
console.log("receipt:", receiptPath());

if (receipt.quarantined.length > 0) {
  process.exitCode = 2;
}

function processStandard(candidate) {
  const rank = String(candidate.unprocessed_queue_rank).padStart(4, "0");
  const base = `priority-${rank}-${candidate.source_conversation_id}`;
  const exchange = path.join(PRIORITY_RUNS, `${base}-input.json`);
  const output = path.join(PRIORITY_RUNS, `${base}-output.json`);
  const raw = path.join(PRIORITY_RUNS, `${base}-openrouter-raw.json`);

  if (fs.existsSync(exchange)) assertPreparedIdentity(candidate, exchange);

  let lastValidationError;

  for (let attempt = 1; attempt <= STANDARD_MAX_ATTEMPTS; attempt += 1) {
    const complete =
      fs.existsSync(exchange)
      && fs.existsSync(output)
      && fs.existsSync(raw);

    if (!complete) {
      const partial =
        fs.existsSync(exchange)
        || fs.existsSync(output)
        || fs.existsSync(raw);

      if (partial) {
        archiveStandardAttempt(
          base,
          [exchange, output, raw],
          attempt,
          "incomplete artifact set before generation"
        );
      }

      try {
        checked(process.execPath, [
          "scripts/run-next-priority-nemotron.mjs",
          "--workspace", WORKSPACE,
          "--conversation", candidate.source_conversation_id
        ]);
      } catch (error) {
        archiveStandardAttempt(
          base,
          [exchange, output, raw],
          attempt,
          `generation failed: ${String(error)}`
        );

        if (attempt === STANDARD_MAX_ATTEMPTS) throw error;

        console.error(
          `STANDARD GENERATION ATTEMPT ${attempt}/${STANDARD_MAX_ATTEMPTS} FAILED; retrying with preserved artifacts.`
        );
        continue;
      }
    }

    if (!fs.existsSync(exchange) || !fs.existsSync(output) || !fs.existsSync(raw)) {
      const error = new Error("standard run did not produce a complete artifact set");

      archiveStandardAttempt(
        base,
        [exchange, output, raw],
        attempt,
        error.message
      );

      if (attempt === STANDARD_MAX_ATTEMPTS) throw error;
      continue;
    }

    let model;
    try {
      model = read(raw).model;
      if (typeof model !== "string" || !model.trim()) throw new Error("standard raw response does not identify its model");
      validate(exchange, output, model, STANDARD_VERSION);
    } catch (error) {
      lastValidationError = error;

      archiveStandardAttempt(
        base,
        [exchange, output, raw],
        attempt,
        `validation failed: ${String(error)}`
      );

      if (attempt === STANDARD_MAX_ATTEMPTS) break;

      console.error(
        `STANDARD VALIDATION ATTEMPT ${attempt}/${STANDARD_MAX_ATTEMPTS} FAILED; retrying with a fresh model output.`
      );
      continue;
    }

    // Once trusted validation passes, do NOT regenerate merely because
    // persistence fails. Keep the validated artifacts for a safe replay.
    const persistedResult = persist(
      exchange,
      output,
      model,
      STANDARD_VERSION
    );

    return summary(candidate, "standard", persistedResult);
  }

  throw new Error(
    `standard validation failed after ${STANDARD_MAX_ATTEMPTS} attempts: ${String(lastValidationError)}`
  );
}

function archiveStandardAttempt(base, files, attempt, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(
    PRIORITY_RUNS,
    "failed-attempts",
    base,
    `${stamp}-try-${attempt}`
  );

  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const attemptDirectory = fs.mkdtempSync(`${directory}-`);

  for (const file of files) {
    if (!fs.existsSync(file)) continue;

    fs.renameSync(
      file,
      path.join(attemptDirectory, path.basename(file))
    );
  }

  fs.writeFileSync(
    path.join(attemptDirectory, "attempt.json"),
    JSON.stringify({
      schema_version: "hhs-standard-reconstruction-attempt/0.1.0",
      workspace: WORKSPACE,
      base,
      attempt,
      failed_at: new Date().toISOString(),
      reason
    }, null, 2) + "\n"
  );

  console.error(`STANDARD ATTEMPT PRESERVED: ${attemptDirectory}`);
}


function processOversized(candidate) {
  const rank = String(candidate.unprocessed_queue_rank).padStart(4, "0");
  const directory = path.join(
    OVERSIZED_RUNS,
    `priority-${rank}-${candidate.source_conversation_id}`
  );
  if (fs.existsSync(path.join(directory, "manifest.json"))) {
    assertPreparedIdentity(candidate, path.join(directory, "parent-input.json"));
  }
  if (!fs.existsSync(path.join(directory, "manifest.json"))) {
    prepareOversized(candidate, directory);
  }
  if (!fs.existsSync(path.join(directory, "parent-output.json")) || !fs.existsSync(path.join(directory, "parent-model.json"))) {
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

// Fail closed before using or regenerating a prepared exchange after a source refresh.
// Full evidence/hash equality is still checked by the existing trusted persist path.
function assertPreparedIdentity(candidate, exchangeFile) {
  const current = inventory.conversations.find(item => item.source_conversation_id === candidate.source_conversation_id);
  const prepared = read(exchangeFile).selection;
  if (!current?.source_version_id || !Array.isArray(prepared) || prepared.length !== 1
    || prepared[0].source_conversation_id !== current.source_conversation_id
    || prepared[0].source_version_id !== current.source_version_id
    || (prepared[0].capture_version_id ?? null) !== (current.capture_version_id ?? null)) {
    throw new Error("prepared_source_identity_mismatch: retained artifacts require trusted corpus-version review");
  }
}

function prepareOversized(candidate, directory) {
  const parentInput = path.join(directory, "parent-input.json");
  const result = captured("npx", [
    "tsx", "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts", "export-chunks",
    "--workspace", WORKSPACE,
    ...(fs.existsSync(parentInput) ? ["--exchange", parentInput] : ["--conversation", candidate.source_conversation_id]),
    "--max-evidence-characters", String(CHUNK_CHARACTERS)
  ]);
  const bundle = JSON.parse(result.stdout);
  const selection = bundle.parent_exchange.selection?.[0];
  if (selection?.source_conversation_id !== candidate.source_conversation_id || bundle.chunks.length === 0) {
    throw new Error("oversized export does not match the selected conversation or has no chunks");
  }
  fs.mkdirSync(directory, { recursive: true });
  write(parentInput, bundle.parent_exchange);
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
    `batch-${receipt.started_at.replace(/[:.]/g, "-")}${OPERATION_ID ? `-${OPERATION_ID}` : ""}.json`
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
  if (fs.existsSync(file)) {
    if (JSON.stringify(read(file)) !== JSON.stringify(value)) throw new Error(`Immutable artifact collision: ${file}`);
    return;
  }
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporary, file);
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
