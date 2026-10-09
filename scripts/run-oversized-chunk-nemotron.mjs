import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { jsonrepair } from "jsonrepair";

const ROOT = process.cwd();
const PROVIDER = "openrouter";
const RUNNER_VERSION = "hhs-oversized-nemotron-runner/0.1.0";
const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free"
];

const runDirectory = flag("run-dir");
if (!runDirectory) {
  throw new Error("Usage: run-oversized-chunk-nemotron.mjs --run-dir DIRECTORY");
}
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is not loaded.");
}

const manifestPath = path.join(runDirectory, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const pending = manifest.chunks.find((chunk) => {
  const number = String(chunk.chunk_number).padStart(3, "0");
  return !fs.existsSync(path.join(runDirectory, "chunk-" + number + "-output.json"))
    && !fs.existsSync(path.join(runDirectory, "chunk-" + number + "-model.json"));
});

if (!pending) {
  console.log("NO CHUNKS REQUIRE GENERATION; resume/revalidate cached artifacts through the oversized orchestrator.");
  process.exit(0);
}

const chunkNumber = String(pending.chunk_number).padStart(3, "0");
const inputPath = path.join(runDirectory, pending.input_file);
const canonicalOutputPath = path.join(
  runDirectory,
  "chunk-" + chunkNumber + "-output.json"
);
const exchange = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const sourceConversationId = exchange.selection[0].source_conversation_id;

const attemptNumber = nextAttemptNumber(runDirectory, chunkNumber);
const attempt = String(attemptNumber).padStart(3, "0");
const attemptBase = path.join(
  runDirectory,
  "chunk-" + chunkNumber + "-attempt-" + attempt
);
const rawPath = attemptBase + "-openrouter-raw.json";
const attemptOutputPath = attemptBase + "-output.json";
const errorPath = attemptBase + "-error.json";

console.log("=== OVERSIZED DISCOVERY CHUNK ===");
console.log("title:", manifest.title);
console.log("conversation:", manifest.source_conversation_id);
console.log("chunk:", pending.chunk_number + "/" + pending.chunk_count);
console.log("evidence_rows:", exchange.evidence.length);
console.log("evidence_characters:", pending.evidence_characters);
console.log("attempt:", attemptNumber);

const systemPrompt = [
  "You are the semantic discovery worker for the HHS Company Reconstruction pipeline.",
  "Analyze this chronological CHUNK of one larger conversation.",
  "Extract every distinct, meaningful, evidence-supported observation in this chunk.",
  "Do not assume this chunk contains the beginning or end of the conversation.",
  "Preserve historical states, changes, corrections, rejected approaches, unresolved questions, and attribution.",
  "Never convert an assistant proposal into a user decision.",
  "A user decision, requirement, preference, instruction, rejection, approval, or commitment requires user-authored evidence.",
  "When describing assistant planning, assistant inference, or assistant interpretation, do not phrase it as a user decision, requirement, preference, instruction, rejection, approval, or commitment unless cited user-authored evidence directly supports that claim.",
  "If assistant-authored text refers to user preferences but no user-authored evidence supports the preference, describe it as assistant-inferred context or omit the unsupported preference clause.",
  "Use only evidence_ref values present in this child exchange.",
  "Return only valid JSON with no Markdown or surrounding prose.",
  "The object must contain exactly:",
  JSON.stringify({
    schema_version: "hhs-understanding-output/0.2.0",
    exchange_id: exchange.exchange_id,
    observations: [],
    links: []
  }),
  "Each observation requires observation_ref, source_conversation_id, observation_kind, statement, payload, attribution, confidence, and evidence.",
  "Every observation must repeat ALL required fields. Never inherit fields from a preceding observation.",
  "Each element of observations[] must be one complete standalone observation object. Never split one observation across two adjacent JSON objects.",
  "The attribution object must contain both subject and claim_type.",
  "confidence must be a JSON number from 0 through 1.",
  "evidence must be a non-empty array of objects shaped exactly as { evidence_ref: valid_reference }.",
  "Never return evidence as an array of strings. Never omit attribution, confidence, or evidence.",
  "attribution.subject must be user, assistant, other, or unresolved.",
  "Return links as an empty array. Conversation-wide links are created by a separate validated linker.",
  "source_conversation_id must be " + sourceConversationId + ".",
  "The supplied model rules are authoritative:",
  JSON.stringify(exchange.model_instructions)
].join("\n\n");

const userPrompt =
  "Deeply digest this bounded conversation chunk and return the required discovery JSON:\n\n"
  + JSON.stringify(exchange);

let modelResult;

for (const model of MODELS) {
  modelResult = await callModel(model, systemPrompt, userPrompt);
  if (modelResult.ok) break;
  console.log("Moving on from " + model + ".");
}

if (!modelResult?.ok) {
  fs.writeFileSync(
    errorPath,
    JSON.stringify(modelResult?.error ?? { message: "All models failed" }, null, 2) + "\n",
    { flag: "wx" }
  );
  console.error("STOP: all authorized models failed. No persistence occurred.");
  process.exit(7);
}

fs.writeFileSync(
  rawPath,
  JSON.stringify(modelResult.data, null, 2) + "\n",
  { flag: "wx" }
);
console.log("MODEL USED:", modelResult.model);
console.log("raw response saved:", rawPath);

let output;
let jsonRepaired = false;

try {
  output = JSON.parse(modelResult.content);
} catch (initialError) {
  try {
    output = JSON.parse(jsonrepair(modelResult.content));
    jsonRepaired = true;
    console.log("MODEL JSON: REPAIRED LOCALLY");
  } catch (repairError) {
    fs.writeFileSync(
      errorPath,
      JSON.stringify({
        message: "Model response could not be repaired as JSON.",
        initial_cause: String(initialError),
        repair_cause: String(repairError)
      }, null, 2) + "\n",
      { flag: "wx" }
    );
    console.error("STOP: model response could not be repaired as JSON.");
    process.exit(8);
  }
}

output.schema_version = "hhs-understanding-output/0.2.0";
output.exchange_id = exchange.exchange_id;

for (const observation of output.observations ?? []) {
  if (
    !observation.payload
    || typeof observation.payload !== "object"
    || Array.isArray(observation.payload)
  ) {
    observation.payload =
      observation.payload == null
        ? {}
        : { value: observation.payload };
  }

  if (Array.isArray(observation.evidence)) {
    observation.evidence = observation.evidence.map((citation) =>
      typeof citation === "string"
        ? { evidence_ref: citation }
        : citation
    );
  }

  const subject = observation?.attribution?.subject;
  if (subject === "both" || subject === "tool" || subject === "system") {
    observation.attribution.subject = "other";
  }
  if (
    observation.attribution
    && (
      typeof observation.attribution.claim_type !== "string"
      || !observation.attribution.claim_type.trim()
    )
    && typeof observation.observation_kind === "string"
    && observation.observation_kind.trim()
  ) {
    observation.attribution.claim_type = observation.observation_kind.trim();
  }
}

const normalizedStatements = new Map();

for (const observation of output.observations ?? []) {
  const key =
    String(observation.observation_ref ?? "")
    + "\n"
    + String(observation.statement ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const complete =
    observation.attribution
    && typeof observation.attribution.subject === "string"
    && typeof observation.attribution.claim_type === "string"
    && typeof observation.confidence === "number"
    && Array.isArray(observation.evidence)
    && observation.evidence.length > 0;

  const previous = normalizedStatements.get(key);

  if (!previous || (!previous.complete && complete)) {
    normalizedStatements.set(key, { observation, complete });
  }
}

output.observations = [...normalizedStatements.values()]
  .map((entry) => entry.observation);

const validRefs = new Set(
  output.observations.map((observation) => observation.observation_ref)
);

output.links = (output.links ?? [])
  .map((link) => ({
    from_observation_ref:
      link.from_observation_ref ?? link.source_observation_ref,
    to_observation_ref:
      link.to_observation_ref ?? link.target_observation_ref,
    link_kind: link.link_kind,
    payload:
      link.payload
      && typeof link.payload === "object"
      && !Array.isArray(link.payload)
        ? link.payload
        : {},
    confidence:
      typeof link.confidence === "number"
        ? link.confidence
        : 0.8
  }))
  .filter(
    (link) =>
      validRefs.has(link.from_observation_ref)
      && validRefs.has(link.to_observation_ref)
      && link.from_observation_ref !== link.to_observation_ref
  );

fs.writeFileSync(
  attemptOutputPath,
  JSON.stringify(output, null, 2) + "\n",
  { flag: "wx" }
);

const validation = spawnSync(
  "npx",
  [
    "tsx",
    "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts",
    "validate",
    "--exchange",
    inputPath,
    "--output",
    attemptOutputPath,
    "--provider",
    PROVIDER,
    "--model",
    modelResult.model,
    "--runner-version",
    RUNNER_VERSION
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  }
);

process.stdout.write(validation.stdout);
if (validation.status !== 0) {
  process.stderr.write(validation.stderr);
  console.error("STOP: chunk validation failed. No persistence occurred.");
  console.error("Retrying creates a new attempt without overwriting this one.");
  process.exit(9);
}

const canonicalModelPath = path.join(runDirectory, "chunk-" + chunkNumber + "-model.json");
if (fs.existsSync(canonicalModelPath)) throw new Error("Validated chunk receipt already exists; resume through the oversized orchestrator.");
const temporaryModel = `${canonicalModelPath}.tmp-${process.pid}`;
fs.writeFileSync(
  temporaryModel,
  JSON.stringify({
    provider: PROVIDER,
    model: modelResult.model,
    runner_version: RUNNER_VERSION,
    attempt: attemptNumber,
    json_repaired: jsonRepaired,
    validated: true
  }, null, 2) + "\n",
  { flag: "wx" }
);
fs.renameSync(temporaryModel, canonicalModelPath);
// Publish the canonical output last, after its validated attempt receipt exists.
const temporaryOutput = `${canonicalOutputPath}.tmp-${process.pid}`;
fs.copyFileSync(attemptOutputPath, temporaryOutput, fs.constants.COPYFILE_EXCL);
fs.renameSync(temporaryOutput, canonicalOutputPath);

console.log("CHUNK VALIDATED:", pending.chunk_number + "/" + pending.chunk_count);
console.log("observations:", output.observations?.length ?? 0);
console.log("links:", output.links?.length ?? 0);
console.log("DATABASE WRITES: NONE");

function nextAttemptNumber(directory, number) {
  const pattern = new RegExp(
    "^chunk-" + number + "-attempt-(\\d+)-(?:openrouter-raw|output|error)\\.json$"
  );
  let highest = 0;
  for (const name of fs.readdirSync(directory)) {
    const match = name.match(pattern);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

async function callModel(model, system, user) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log("Trying " + model + " - attempt " + attempt + "/3");
    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ],
            temperature: 0.2
          })
        }
      );
      const data = await response.json();
      const embeddedError = data?.error;
      if (response.ok && !embeddedError) {
        const responseContent = data?.choices?.[0]?.message?.content;
        if (responseContent) {
          return { ok: true, model, data, content: responseContent };
        }
      }

      const message =
        embeddedError?.message
        ?? ("HTTP " + response.status);
      console.log("Model failed: " + message);
      const retryable =
        response.status === 429
        || response.status === 502
        || response.status === 503
        || /overload|temporar|rate.?limit/i.test(message);

      if (!retryable || attempt === 3) {
        return { ok: false, model, error: data };
      }
    } catch (error) {
      console.log("Request error: " + error.message);
      if (attempt === 3) {
        return {
          ok: false,
          model,
          error: { message: error.message }
        };
      }
    }

    const waitMs = attempt * 5000;
    console.log("Waiting " + waitMs / 1000 + "s before retry...");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function flag(name) {
  const index = process.argv.indexOf("--" + name);
  return index < 0 ? undefined : process.argv[index + 1];
}
