import fs from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { jsonrepair } from "jsonrepair";

const ROOT = process.cwd();
const PRIORITY_PATH = ".runtime/reconstruction/business-priority-index-v1.json";
const RUNS_DIR = ".runtime/reconstruction/priority-runs";

const WORKSPACE = flag("workspace");
const PROVIDER = "openrouter";
const MAX_TOKENS_FOR_NOW = 75000;
const requestedConversationId = flag("conversation");

if (!WORKSPACE) {
  console.error("STOP: --workspace is required.");
  process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("STOP: OPENROUTER_API_KEY is not loaded.");
  process.exit(1);
}

const priority = JSON.parse(await readFile(PRIORITY_PATH, "utf8"));

const inventoryResult = spawnSync(
  "npx",
  [
    "tsx",
    "--env-file=.env.memory-v1.local",
    "scripts/reconstruction-inventory.ts",
    "json",
    "--workspace",
    WORKSPACE
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100
  }
);

if (inventoryResult.status !== 0) {
  console.error("STOP: live reconstruction inventory failed.");
  console.error(inventoryResult.stderr);
  process.exit(1);
}

const liveInventory = JSON.parse(inventoryResult.stdout);
const persistedConversationIds = new Set(
  liveInventory.conversations
    .filter((conversation) => conversation.discovery_status === "discovery_processed")
    .map((conversation) => conversation.source_conversation_id)
);

const candidates = priority.conversations
  .filter((c) => !persistedConversationIds.has(c.source_conversation_id) && !c.evidence_issue)
  .sort((a, b) => a.unprocessed_queue_rank - b.unprocessed_queue_rank);

if (!candidates.length) {
  console.log("NO ELIGIBLE UNPROCESSED CONVERSATIONS");
  process.exit(0);
}

const deferredOversized = candidates.filter(
  (candidate) => candidate.estimated_input_tokens > MAX_TOKENS_FOR_NOW
);
const next = requestedConversationId
  ? candidates.find(
      (candidate) =>
        candidate.source_conversation_id === requestedConversationId
        && candidate.estimated_input_tokens <= MAX_TOKENS_FOR_NOW
    )
  : candidates.find(
      (candidate) => candidate.estimated_input_tokens <= MAX_TOKENS_FOR_NOW
    );

if (!next) {
  console.error(
    `STOP: all ${candidates.length} remaining eligible conversations exceed the current ${MAX_TOKENS_FOR_NOW}-token single-run limit.`
  );
  process.exit(2);
}

if (deferredOversized.length > 0) {
  console.log("=== DEFERRED OVERSIZED CONVERSATIONS ===");
  for (const candidate of deferredOversized) {
    console.log(
      `rank ${candidate.unprocessed_queue_rank}: ${candidate.title} · ${candidate.estimated_input_tokens} estimated tokens`
    );
  }
  console.log("These remain unprocessed by this single-run worker; use the existing reconstruction batch runner for chunked discovery.");
  console.log("");
}

console.log("=== NEXT PRIORITY CONVERSATION ===");
console.log("rank:", next.unprocessed_queue_rank);
console.log("tier:", next.priority_tier);
console.log("title:", next.title);
console.log("conversation:", next.source_conversation_id);
console.log("estimated_tokens:", next.estimated_input_tokens);
console.log("theme:", next.dominant_theme);

if (process.argv.includes("--select-only")) {
  console.log("SELECT ONLY: no artifacts created, no model called, no database writes.");
  process.exit(0);
}

await mkdir(RUNS_DIR, { recursive: true });

const safeRank = String(next.unprocessed_queue_rank).padStart(4, "0");
const base = `priority-${safeRank}-${next.source_conversation_id}`;

const exchangePath = path.join(RUNS_DIR, `${base}-input.json`);
const outputPath = path.join(RUNS_DIR, `${base}-output.json`);
const rawPath = path.join(RUNS_DIR, `${base}-openrouter-raw.json`);

if (fs.existsSync(exchangePath) || fs.existsSync(outputPath) || fs.existsSync(rawPath)) {
  console.error("STOP: artifacts already exist for this priority conversation.");
  console.error(exchangePath);
  console.error(outputPath);
  console.error(rawPath);
  process.exit(3);
}

console.log("\n=== EXPORTING BOUNDED EVIDENCE ===");

const exported = spawnSync(
  "npx",
  [
    "tsx",
    "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts",
    "export",
    "--workspace",
    WORKSPACE,
    "--conversation",
    next.source_conversation_id
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100
  }
);

if (exported.status !== 0) {
  console.error("STOP: trusted HHS export failed.");
  console.error(exported.stderr);
  process.exit(4);
}

await writeFile(exchangePath, exported.stdout, { encoding: "utf8", flag: "wx" });

const exchange = JSON.parse(exported.stdout);

if (exchange.selection?.length !== 1) {
  console.error("STOP: exported exchange does not contain exactly one conversation.");
  process.exit(5);
}

if (exchange.selection[0]?.source_conversation_id !== next.source_conversation_id) {
  console.error("STOP: exported conversation does not match selected priority conversation.");
  process.exit(6);
}

console.log("exchange_id:", exchange.exchange_id);
console.log("evidence_rows:", exchange.evidence?.length ?? 0);

const systemPrompt = `
You are the semantic discovery worker for the HHS Company Reconstruction pipeline.

Your job is to deeply understand ONE supplied conversation.

Do not summarize it shallowly.

Extract every meaningful structural observation supported by the evidence.

Return ONLY valid JSON.
No Markdown.
No code fences.
No prose outside JSON.

The final object must contain exactly:

{
  "schema_version": "hhs-understanding-output/0.2.0",
  "exchange_id": "${exchange.exchange_id}",
  "observations": [],
  "links": []
}

OBSERVATION SHAPE:

{
  "observation_ref": "unique exchange-local alias",
  "source_conversation_id": "${next.source_conversation_id}",
  "observation_kind": "free-text semantic kind",
  "statement": "clear evidence-supported statement",
  "payload": {},
  "attribution": {
    "subject": "user | assistant | other | unresolved",
    "claim_type": "free-text claim type"
  },
  "confidence": 0.0,
  "evidence": [
    {
      "evidence_ref": "valid exchange-local evidence_ref"
    }
  ]
}

Allowed attribution.subject values are ONLY:

user
assistant
other
unresolved

Never use "both", "tool", or "system".

For tool-produced, retrieved-document, or system-derived evidence,
use subject "other" and preserve the source distinction in claim_type
and/or payload, for example:

{ "subject": "other", "claim_type": "document_content" }
{ "subject": "other", "claim_type": "tool_result" }
{ "subject": "other", "claim_type": "system_event" }

For mixed authorship use "other" and explain the distinction in statement/payload.

LINK SHAPE:

{
  "from_observation_ref": "existing observation_ref",
  "to_observation_ref": "existing observation_ref",
  "link_kind": "free-text semantic relationship",
  "payload": {},
  "confidence": 0.0
}

SEMANTIC DISCOVERY RULES:

Read the entire conversation in message order.

Discover what is actually there rather than forcing a predetermined ontology.

Capture meaningful:
- user ideas
- user requirements
- user preferences
- decisions
- rejected approaches
- assistant proposals
- products
- projects
- people
- companies
- systems
- workflows
- tools
- business models
- implementation details
- architecture
- unresolved questions
- changes
- contradictions
- dependencies
- recurring needs
- potential capabilities
- potential skills
- personal context where materially relevant
- absence of company meaning where appropriate
- other meaningful structures

Do not collapse a rich conversation into one broad observation.

Separate materially different ideas into separate observations.

AUTHORITY DISCIPLINE:

Never convert an assistant suggestion into a user decision.

If claiming the user decided, required, preferred, rejected, instructed, approved or committed to something, support it with user-authored evidence.

Distinguish:
- user-authored statement
- assistant suggestion
- tool/system observation
- inference
- historical state
- unresolved state

TEMPORAL DISCIPLINE:

Preserve earlier states, later changes, possible supersession and unresolved conflicts.

Do not flatten history into one current truth.

EVIDENCE DISCIPLINE:

Use ONLY evidence_ref values actually present in this exchange.
Never invent evidence references.

Every meaningful claim must be evidence-backed.

CAPABILITIES / SKILLS:

Potential reusable capabilities, skills, SOPs or automations may be recorded as provisional observations.

Do NOT represent them as approved or implemented unless evidence proves that.

The supplied exchange model rules are also authoritative:

${JSON.stringify(exchange.model_instructions, null, 2)}

Return ONLY the JSON object.
`;

console.log("\n=== NEMOTRON DEEP DIGESTION ===");


const preferredModels = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callModel(model) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`Trying ${model} - attempt ${attempt}/3`);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                "Deeply digest this complete bounded HHS conversation evidence and return the required discovery JSON:\n\n" +
                JSON.stringify(exchange)
            }
          ],
          temperature: 0.2
        })
      });

      const data = await response.json();
      const embeddedError = data?.error;

      if (!response.ok || embeddedError) {
        const message = embeddedError?.message ?? `HTTP ${response.status}`;
        console.log(`Model failed: ${message}`);

        const retryable =
          response.status === 429 ||
          response.status === 502 ||
          response.status === 503 ||
          /overload|temporar|rate.?limit/i.test(message);

        if (!retryable) {
          return { ok: false, model, error: data };
        }

        if (attempt < 3) {
          const waitMs = attempt * 5000;
          console.log(`Waiting ${waitMs / 1000}s before retry...`);
          await sleep(waitMs);
          continue;
        }

        return { ok: false, model, error: data };
      }

      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        return {
          ok: false,
          model,
          error: { message: "Successful API response contained no model content." }
        };
      }

      return { ok: true, model, data, content };
    } catch (error) {
      console.log(`Request error: ${error.message}`);

      if (attempt < 3) {
        const waitMs = attempt * 5000;
        console.log(`Waiting ${waitMs / 1000}s before retry...`);
        await sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        model,
        error: { message: error.message }
      };
    }
  }
}

let modelResult = null;

for (const model of preferredModels) {
  const result = await callModel(model);

  if (result.ok) {
    modelResult = result;
    break;
  }

  console.log(`Moving on from ${model}.`);
}

if (!modelResult) {
  console.error("STOP: all authorized free Nemotron models failed.");
  console.error("No persistence occurred.");
  console.error("No next conversation was processed.");
  process.exit(7);
}

const apiResponse = modelResult.data;
const content = modelResult.content;
const MODEL_USED = modelResult.model;

console.log("MODEL USED:", MODEL_USED);


if (!content) {
  console.error("STOP: model returned no content.");
  process.exit(8);
}

await writeFile(
  rawPath,
  JSON.stringify(apiResponse, null, 2) + "\n",
  { encoding: "utf8", flag: "wx" }
);

console.log("raw response saved:", rawPath);

let output;
let jsonRepaired = false;

try {
  output = JSON.parse(content);
} catch (initialError) {
  try {
    output = JSON.parse(jsonrepair(content));
    jsonRepaired = true;
    console.log("MODEL JSON: REPAIRED LOCALLY");
  } catch (repairError) {
    console.error("STOP: model response could not be repaired as JSON.");
    console.error(String(initialError));
    console.error(String(repairError));
    process.exit(9);
  }
}

/*
  Deterministic wrapper normalization only.

  These values come from trusted local HHS data.
  No semantic statement, evidence reference, observation or link is invented here.
*/
output.schema_version = "hhs-understanding-output/0.2.0";
output.exchange_id = exchange.exchange_id;

/*
  Normalize mechanical attribution enum/shape issues before trusted validation.
*/
for (const observation of output.observations ?? []) {
  if (
    !observation.payload
    || typeof observation.payload !== "object"
    || Array.isArray(observation.payload)
  ) {
    observation.payload = observation.payload == null
      ? {}
      : { value: observation.payload };
  }
  if (Array.isArray(observation.evidence)) {
    observation.evidence = observation.evidence.map((citation) =>
      typeof citation === "string" ? { evidence_ref: citation } : citation
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

const validObservationRefs = new Set(
  (output.observations ?? []).map((observation) => observation.observation_ref)
);

output.links = (output.links ?? []).filter((link) =>
  validObservationRefs.has(link.from_observation_ref) &&
  validObservationRefs.has(link.to_observation_ref)
);

await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" }
);

console.log("observations:", Array.isArray(output.observations) ? output.observations.length : "missing");
console.log("links:", Array.isArray(output.links) ? output.links.length : "missing");
console.log("prompt_tokens:", apiResponse.usage?.prompt_tokens);
console.log("completion_tokens:", apiResponse.usage?.completion_tokens);
console.log("cost:", apiResponse.usage?.cost);
console.log("json_repaired:", jsonRepaired);

console.log("\n=== HHS TRUSTED VALIDATION ===");

const validation = spawnSync(
  "npx",
  [
    "tsx",
    "--env-file=.env.memory-v1.local",
    "scripts/understanding-discovery.ts",
    "validate",
    "--exchange",
    exchangePath,
    "--output",
    outputPath,
    "--provider",
    PROVIDER,
    "--model",
    MODEL_USED,
    "--runner-version",
    "hhs-priority-nemotron-runner/0.1.0"
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  }
);

console.log(validation.stdout);

if (validation.status !== 0) {
  console.error("STOP: HHS validation FAILED.");
  console.error("No persistence occurred.");
  console.error("No next conversation was processed.");
  process.exit(10);
}

console.log("=== PRIORITY DIGESTION PASS ===");
console.log("title:", next.title);
console.log("conversation:", next.source_conversation_id);
console.log("exchange:", exchangePath);
console.log("output:", outputPath);
console.log("raw:", rawPath);
console.log("DATABASE WRITES: NONE");
console.log("OBSERVATION PERSISTENCE: NONE");
console.log("NEXT CONVERSATION: NOT PROCESSED");

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
