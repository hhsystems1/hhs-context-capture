import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { jsonrepair } from "jsonrepair";

const ROOT = process.cwd();
const PROVIDER = "openrouter";
const RUNNER_VERSION = "hhs-oversized-linker/0.1.0";
const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free"
];

const runDirectory = flag("run-dir");
if (!runDirectory) {
  throw new Error("Usage: run-oversized-linker-nemotron.mjs --run-dir DIRECTORY");
}
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is not loaded.");
}

const parentInputPath = path.join(runDirectory, "parent-input.json");
const mergedInputPath = path.join(
  runDirectory,
  "parent-deterministic-merged-output.json"
);
const canonicalOutputPath = path.join(runDirectory, "parent-output.json");

if (fs.existsSync(canonicalOutputPath)) {
  console.log("PARENT OUTPUT ALREADY EXISTS");
  process.exit(0);
}

const parentExchange = JSON.parse(
  fs.readFileSync(parentInputPath, "utf8")
);
const merged = JSON.parse(
  fs.readFileSync(mergedInputPath, "utf8")
);
const validRefs = new Set(
  merged.observations.map((item) => item.observation_ref)
);

const existingAttempts = fs.readdirSync(runDirectory)
  .filter((name) =>
    name.startsWith("parent-link-attempt-")
    && name.endsWith("-raw.json")
  )
  .map((name) => Number(name.split("-")[3]))
  .filter(Number.isFinite);

const attemptNumber = Math.max(0, ...existingAttempts) + 1;
const attempt = String(attemptNumber).padStart(3, "0");
const attemptBase = path.join(
  runDirectory,
  "parent-link-attempt-" + attempt
);
const rawPath = attemptBase + "-raw.json";
const linksPath = attemptBase + "-links.json";
const outputPath = attemptBase + "-output.json";

const systemPrompt = [
  "You are the conversation-wide relationship linker for HHS Company Reconstruction.",
  "The supplied observations were independently extracted and already validated against immutable evidence.",
  "Do not rewrite, remove, combine, or invent observations.",
  "Your only task is to identify meaningful relationships among the existing observation_ref values.",
  "Prioritize relationships across different chunk prefixes, while also including important within-chunk relationships.",
  "Preserve chronology, corrections, rejection, approval, dependency, implementation, production, supersession, and refinement relationships.",
  "Do not claim that an assistant proposal was approved unless an existing user-authored observation establishes approval.",
  "Return only valid JSON with exactly one top-level key named links.",
  "Each link must contain from_observation_ref, to_observation_ref, link_kind, payload, and confidence.",
  "Use only observation_ref values present in the supplied observations.",
  "confidence must be a JSON number from 0 through 1.",
  "Do not include self-links or duplicate links."
].join("\n\n");

const userPrompt =
  "Create the relationship graph for these validated observations:\n\n"
  + JSON.stringify({
    source_conversation_id:
      parentExchange.selection[0].source_conversation_id,
    title: parentExchange.selection[0].title,
    observations: merged.observations
  });

let result;
for (const model of MODELS) {
  result = await callModel(model, systemPrompt, userPrompt);
  if (result.ok) break;
  console.log("Moving on from " + model + ".");
}

if (!result?.ok) {
  console.error("STOP: all linker models failed.");
  process.exit(7);
}

fs.writeFileSync(
  rawPath,
  JSON.stringify(result.data, null, 2) + "\n",
  { flag: "wx" }
);
console.log("MODEL USED:", result.model);
console.log("raw response saved:", rawPath);

let candidate;
try {
  candidate = JSON.parse(result.content);
} catch (initialError) {
  try {
    candidate = JSON.parse(jsonrepair(result.content));
    console.log("LINKER JSON: REPAIRED LOCALLY");
  } catch (repairError) {
    fs.writeFileSync(
      attemptBase + "-error.json",
      JSON.stringify({
        message: "Linker response could not be repaired as JSON.",
        initial_cause: String(initialError),
        repair_cause: String(repairError)
      }, null, 2) + "\n",
      { flag: "wx" }
    );
    console.error("STOP: linker response could not be repaired as JSON.");
    process.exit(8);
  }
}

const suppliedLinks = Array.isArray(candidate.links)
  ? candidate.links
  : [];
const seen = new Set();
const links = [];

for (const link of suppliedLinks) {
  const from = link?.from_observation_ref ?? link?.source_observation_ref;
  const to = link?.to_observation_ref ?? link?.target_observation_ref;
  const kind =
    typeof link?.link_kind === "string"
      ? link.link_kind.trim()
      : "";
  if (
    !validRefs.has(from)
    || !validRefs.has(to)
    || from === to
    || !kind
  ) continue;

  const key = from + "\n" + to + "\n" + kind;
  if (seen.has(key)) continue;
  seen.add(key);

  links.push({
    from_observation_ref: from,
    to_observation_ref: to,
    link_kind: kind,
    payload:
      link.payload
      && typeof link.payload === "object"
      && !Array.isArray(link.payload)
        ? link.payload
        : {},
    confidence:
      typeof link.confidence === "number"
      && link.confidence >= 0
      && link.confidence <= 1
        ? link.confidence
        : 0.8
  });
}

fs.writeFileSync(
  linksPath,
  JSON.stringify({ links }, null, 2) + "\n",
  { flag: "wx" }
);

const finalOutput = {
  schema_version: "hhs-understanding-output/0.2.0",
  exchange_id: parentExchange.exchange_id,
  observations: merged.observations,
  links: [...merged.links, ...links]
};

fs.writeFileSync(
  outputPath,
  JSON.stringify(finalOutput, null, 2) + "\n",
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
    parentInputPath,
    "--output",
    outputPath,
    "--provider",
    PROVIDER,
    "--model",
    result.model,
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
  console.error("STOP: parent validation failed.");
  process.exit(9);
}

fs.copyFileSync(
  outputPath,
  canonicalOutputPath,
  fs.constants.COPYFILE_EXCL
);

fs.writeFileSync(
  path.join(runDirectory, "parent-model.json"),
  JSON.stringify({
    provider: PROVIDER,
    model: result.model,
    runner_version: RUNNER_VERSION,
    attempt: attemptNumber,
    observations: merged.observations.length,
    generated_links: links.length,
    validated: true
  }, null, 2) + "\n",
  { flag: "wx" }
);

console.log("PARENT VALIDATED");
console.log("observations:", merged.observations.length);
console.log("links:", finalOutput.links.length);
console.log("DATABASE WRITES: NONE");

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
            temperature: 0.1
          })
        }
      );
      const data = await response.json();
      const error = data?.error;
      const responseContent =
        data?.choices?.[0]?.message?.content;

      if (response.ok && !error && responseContent) {
        return {
          ok: true,
          model,
          data,
          content: responseContent
        };
      }

      const message = error?.message ?? ("HTTP " + response.status);
      console.log("Model failed: " + message);
      if (
        attempt === 3
        || !(
          response.status === 429
          || response.status === 502
          || response.status === 503
          || /overload|temporar|rate.?limit/i.test(message)
        )
      ) {
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
