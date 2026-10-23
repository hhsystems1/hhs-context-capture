import { readStandardProviderFailure } from "./reconstruction-provider.mjs";
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
const SINGLE_RUN_CHARACTERS = 60000;
const SOURCE_BUDGET_MS = 8 * 60 * 1000;
const PRIORITY_PATH = ".runtime/reconstruction/business-priority-index-v1.json";
const PRIORITY_RUNS = ".runtime/reconstruction/priority-runs";
const OVERSIZED_RUNS = ".runtime/reconstruction/oversized-runs";
const PROVIDER = "openrouter";

function priorityRank(item) {
  const rank = item.unprocessed_queue_rank ?? item.overall_priority_rank;
  if (!Number.isInteger(rank) || rank < 1) throw new Error(`Missing valid priority rank for ${item.source_conversation_id}`);
  return rank;
}

const STANDARD_VERSION = "hhs-priority-nemotron-runner/0.1.0";
const OVERSIZED_VERSION = "hhs-oversized-linker/0.1.0";
const STANDARD_MAX_ATTEMPTS = 2;

if (!WORKSPACE) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");
if (!Number.isInteger(LIMIT) || LIMIT < 1) throw new Error("--limit must be a positive integer.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not loaded.");

const inventory = inventoryJson();
const pendingInventory = inventory.conversations.filter(
  (item) => item.discovery_status !== "discovery_processed" && !item.evidence_issue
);
const priority = pendingInventory.length === 0
  ? { conversations: [] }
  : read(PRIORITY_PATH);

const prioritySourceIds = new Set(
  priority.conversations.map((item) => item.source_conversation_id)
);
const missingPrioritySourceIds = pendingInventory
  .map((item) => item.source_conversation_id)
  .filter((sourceId) => !prioritySourceIds.has(sourceId));

if (missingPrioritySourceIds.length > 0) {
  throw new Error(
    `Missing priority metadata for active workspace source(s): ${missingPrioritySourceIds.join(", ")}`
  );
}

const inventorySourceIds = new Set(
  inventory.conversations.map((item) => item.source_conversation_id)
);
const persisted = new Set(
  inventory.conversations
    .filter((item) => item.discovery_status === "discovery_processed")
    .map((item) => item.source_conversation_id)
);
const held = quarantinedSources();
const eligible = priority.conversations
  .filter((item) =>
    inventorySourceIds.has(item.source_conversation_id)
    && !item.evidence_issue
    && !persisted.has(item.source_conversation_id)
    // A normal continuation advances past preserved failures. A deliberate
    // targeted retry remains available after the operator reviews/repairs one.
    && (TARGET_CONVERSATION || !held.has(item.source_conversation_id))
  )
  .sort((a, b) => priorityRank(a) - priorityRank(b));

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
  skipped_quarantined_count: TARGET_CONVERSATION ? 0 : priority.conversations.filter(item =>
    inventorySourceIds.has(item.source_conversation_id) && !item.evidence_issue
    && !persisted.has(item.source_conversation_id) && held.has(item.source_conversation_id)
  ).length,
  ...(TARGET_CONVERSATION ? { conversation: TARGET_CONVERSATION } : {}),
  status: "running",
  completed: [],
  quarantined: []
};
writeReceipt(receipt);

for (const candidate of candidates) {
  console.log(`\n=== ${priorityRank(candidate)}: ${candidate.title} ===`);
  const priorDeadline = process.env.HHS_RECONSTRUCTION_DEADLINE_AT;
  const sourceStartedAt = Date.now();
  try {
    // Include the measured per-block prompt overhead, not only source prose.
    // The shared deadline also propagates through chunk/linker subprocesses.
    const inheritedDeadline = priorDeadline === undefined ? Infinity : Number(priorDeadline);
    if (priorDeadline !== undefined && !Number.isSafeInteger(inheritedDeadline)) throw new Error("Invalid inherited source deadline");
    process.env.HHS_RECONSTRUCTION_DEADLINE_AT = String(Math.min(Date.now() + SOURCE_BUDGET_MS, inheritedDeadline));
    const current = inventory.conversations.find(row => row.source_conversation_id === candidate.source_conversation_id);
    const base = path.join(PRIORITY_RUNS, `priority-${String(priorityRank(candidate)).padStart(4, "0")}-${candidate.source_conversation_id}`);
    const replayable = ["-input.json", "-output.json", "-openrouter-raw.json"].every(suffix => fs.existsSync(base + suffix));
    const preparedChunks = fs.existsSync(path.join(OVERSIZED_RUNS, path.basename(base), "manifest.json"));
    if (fs.existsSync(base + "-input.json")) assertPreparedIdentity(candidate, base + "-input.json");
    const estimatedCharacters = candidate.estimated_input_tokens * 4 + (current?.evidence_block_count ?? 0) * 160;
    const chunked = !replayable && (preparedChunks || !Number.isFinite(estimatedCharacters) || estimatedCharacters > SINGLE_RUN_CHARACTERS);
    receipt.current_source = { source_conversation_id: candidate.source_conversation_id, title: candidate.title,
      priority_rank: priorityRank(candidate), mode: chunked ? 'chunks' : 'standard', stage: 'preparing' };
    sourceStage('preparing');
    const result = chunked
      ? processOversized(candidate, sourceStartedAt, inheritedDeadline)
      : processStandard(candidate);
    receipt.completed.push(result);
    sourceStage('complete');
  } catch (error) {
    const item = {
      source_conversation_id: candidate.source_conversation_id,
      title: candidate.title,
      reason: String(error),
      ...(receipt.current_source?.mode === 'standard' && /^Error: .+ exited with status 14$/.test(String(error))
        ? { failure_code: 'evidence_validation', failure_detail: 'original_user_text_gap' }
        : receipt.current_source?.mode === 'standard' && /^Error: .+ exited with status 7$/.test(String(error))
        ? readStandardProviderFailure(path.join(ROOT, PRIORITY_RUNS), { workspace: WORKSPACE,
          source_conversation_id: candidate.source_conversation_id, priority_rank: priorityRank(candidate), operation_id: OPERATION_ID,
          started_at: new Date(sourceStartedAt).toISOString(), finished_at: new Date().toISOString() }) ?? {}
        : oversizedFailure(candidate) ? { failure_code: oversizedFailure(candidate) } : {})
    };
    receipt.quarantined.push(item);
    console.error("QUARANTINED:", item.reason);
  } finally {
    if (priorDeadline === undefined) delete process.env.HHS_RECONSTRUCTION_DEADLINE_AT;
    else process.env.HHS_RECONSTRUCTION_DEADLINE_AT = priorDeadline;
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
  sourceStage('generating');
  const rank = String(priorityRank(candidate)).padStart(4, "0");
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
          "--conversation", candidate.source_conversation_id,
          ...(OPERATION_ID ? ["--operation-id", OPERATION_ID] : [])
        ]);
      } catch (error) {
        archiveStandardAttempt(
          base,
          [exchange, output, raw],
          attempt,
          `generation failed: ${String(error)}`
        );

        // Retrying cannot recreate absent original user evidence. The batch
        // records a typed hold, keeps this source unprocessed and advances.
        if (/^Error: .+ exited with status 14$/.test(String(error))) throw error;
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


function processOversized(candidate, sourceStartedAt, inheritedDeadline) {
  const rank = String(priorityRank(candidate)).padStart(4, "0");
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
  const pendingChunks = read(path.join(directory, "manifest.json")).chunks.filter(chunk => {
    const number = String(chunk.chunk_number).padStart(3, "0");
    return !fs.existsSync(path.join(directory, `chunk-${number}-output.json`))
      || !fs.existsSync(path.join(directory, `chunk-${number}-model.json`));
  });
  const requestUnits = pendingChunks.reduce((sum, chunk) => sum + (chunk.exceeds_target && chunk.message_count === 1
    && Number.isFinite(chunk.evidence_characters) ? Math.max(1, Math.ceil(chunk.evidence_characters / Math.max(12000, CHUNK_CHARACTERS / 2))) : 1), 0);
  // Measured valid free-model chunks can take over two minutes. Budget one
  // bounded request per pending chunk plus the linker, up to one hour total.
  // Cached chunks remain revalidated, and an explicit caller deadline still wins.
  const chunkRequestBudget = Number(process.env.HHS_RECONSTRUCTION_REQUEST_TIMEOUT_MS ?? 180000);
  const oversizedBudget = Math.max(SOURCE_BUDGET_MS, Math.min(60 * 60 * 1000, (requestUnits + 1) * chunkRequestBudget + 60000));
  if (!Number.isSafeInteger(oversizedBudget)) throw new Error("Invalid oversized source budget");
  process.env.HHS_RECONSTRUCTION_DEADLINE_AT = String(Math.min(sourceStartedAt + oversizedBudget, inheritedDeadline));
  sourceStage('generating');
  if (!fs.existsSync(path.join(directory, "parent-output.json")) || !fs.existsSync(path.join(directory, "parent-model.json"))) {
    checked(process.execPath, [
      "scripts/run-oversized-orchestrator.mjs",
      "--run-dir", directory,
      "--workspace", WORKSPACE,
      ...(OPERATION_ID ? ["--operation-id", OPERATION_ID] : [])
    ]);
  }
  const exchange = path.join(directory, "parent-input.json");
  const output = path.join(directory, "parent-output.json");
  const modelFile = path.join(directory, "parent-model.json");
  if (!fs.existsSync(modelFile)) throw new Error("oversized parent model receipt is missing");
  const model = read(modelFile).model;
  sourceStage('saving');
  validate(exchange, output, model, OVERSIZED_VERSION);
  const persistedResult = persist(exchange, output, model, OVERSIZED_VERSION);
  return summary(candidate, "oversized", persistedResult);
}

function oversizedFailure(candidate) {
  if (!OPERATION_ID) return undefined;
  const directory = path.join(OVERSIZED_RUNS, "priority-" + String(priorityRank(candidate)).padStart(4, "0") + "-" + candidate.source_conversation_id);
  const file = path.join(directory, "failure-" + OPERATION_ID + ".json");
  if (!fs.existsSync(file)) return undefined;
  const failure = read(file);
  if (failure.workspace !== WORKSPACE || failure.operation_id !== OPERATION_ID || failure.source_conversation_id !== candidate.source_conversation_id) return undefined;
  return ["model_output_truncated", "malformed_model_json", "evidence_validation", "request_timeout", "source_deadline", "rate_limited", "provider_unavailable", "incomplete_response"].includes(failure.failure_code) ? failure.failure_code : undefined;
}

function sourceStage(stage) {
  if (!receipt.current_source) return;
  receipt.current_source.stage = stage;
  receipt.progress_updated_at = new Date().toISOString();
  writeReceipt(receipt);
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
  sourceStage('saving');
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

function sourceEvidenceHold(reason) {
  return /(?:^|\n)Error: Original user text is not fully represented by content blocks; repair source evidence before discovery\.(?:\n|$)/.test(reason)
  && /at assertBrowserUserTextCoverage \(/.test(reason) && /at prepareDiscoveryExchangeFromClient \(/.test(reason)
  && !/provider_error|request_timeout|HTTP[ :]+[45]\d\d|ECONN\w+|AbortError/i.test(reason);
}

function quarantinedSources() {
  const directory = path.join(ROOT, ".runtime/reconstruction/batch-receipts");
  if (!fs.existsSync(directory)) return new Set();
  const sources = new Set(), temporary = new Map();
  const transient = new Set(['request_timeout', 'source_deadline', 'rate_limited', 'provider_unavailable', 'incomplete_response']);
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const prior = read(path.join(directory, name));
    if (prior.workspace !== WORKSPACE || !prior.finished_at || prior.status === "running") continue;
    if (prior.schema_version !== "hhs-reconstruction-batch/0.1.0" || !Number.isFinite(Date.parse(prior.finished_at))
      || !["completed", "partial", "failed"].includes(prior.status) || !Array.isArray(prior.quarantined)) {
      throw new Error(`Invalid preserved quarantine receipt: ${name}`);
    }
    for (const item of prior.quarantined) {
      if (!item || typeof item.source_conversation_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.source_conversation_id)
        || typeof item.reason !== "string" || !item.reason.trim()) throw new Error(`Invalid preserved quarantine entry: ${name}`);
      if (['evidence_validation', 'model_output_truncated', 'malformed_model_json'].includes(item.failure_code)) sources.add(item.source_conversation_id);
      // Two distinct terminal operations exhaust automatic retries for this source.
      // Keep the source unprocessed and its evidence intact; explicit targeted repair remains available.
      if (transient.has(item.failure_code) && /^operation_[0-9a-f]{32}$/.test(prior.operation_id ?? '')) {
        const operations = temporary.get(item.source_conversation_id) ?? new Set();
        operations.add(prior.operation_id); temporary.set(item.source_conversation_id, operations);
        if (operations.size >= 2) sources.add(item.source_conversation_id);
      }
      // Content/identity failures need review. Preserve the existing automatic
      // artifact replay for transient generation or database-persistence errors.
      // The existing priority entrypoint also reports trusted-validation failure
      // through exit 10; older terminal receipts preserve that numeric outcome.
      if (sourceEvidenceHold(item.reason) || /standard validation failed after \d+ attempts|exited with status 10$|prepared_source_identity_mismatch|Discovery exchange does not match current trusted database evidence/.test(item.reason)) {
        sources.add(item.source_conversation_id);
      }
    }
  }
  return sources;
}

function summary(candidate, mode, result) {
  return {
    source_conversation_id: candidate.source_conversation_id,
    title: candidate.title,
    priority_rank: priorityRank(candidate),
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
