/** CLI boundary for a provider-neutral discovery exchange. No model SDK lives here. */
import { readFile } from "node:fs/promises";
import {
  listPilotCandidates,
  prepareDiscoveryExchange,
  splitDiscoveryExchange,
  suggestDiversePilot,
  validateAndPersistDiscovery,
  validateDiscoveryOutput,
  type DiscoveryExchange,
  type TrustedDiscoveryModel
} from "../apps/memory-ingest/src/understanding-discovery.js";

const command = process.argv[2];
const workspaceId = flag("workspace") ?? process.env.MEMORY_WORKSPACE_ID;
if (!workspaceId) throw new Error("--workspace or MEMORY_WORKSPACE_ID is required.");

if (command === "select") {
  const limit = Number(flag("limit") ?? "20");
  const inventory = await listPilotCandidates(workspaceId);
  console.log(JSON.stringify({ clean_inventory_count: inventory.length, suggested: suggestDiversePilot(inventory, limit) }, null, 2));
} else if (command === "export") {
  const conversations = flags("conversation");
  console.log(JSON.stringify(await prepareDiscoveryExchange(workspaceId, conversations), null, 2));
} else if (command === "export-chunks") {
  const conversations = flags("conversation");
  const exchangePath = flag("exchange");
  const maxEvidenceCharacters = Number(
    flag("max-evidence-characters") ?? "300000"
  );
  const parentExchange = exchangePath
    ? JSON.parse(await readFile(exchangePath, "utf8")) as DiscoveryExchange
    : await prepareDiscoveryExchange(workspaceId, conversations);
  const chunks = splitDiscoveryExchange(parentExchange, maxEvidenceCharacters);
  console.log(JSON.stringify({
    parent_exchange: parentExchange,
    chunks
  }, null, 2));
} else if (command === "validate" || command === "persist") {
  const exchangePath = requiredFlag("exchange");
  const outputPath = requiredFlag("output");
  const exchange = JSON.parse(await readFile(exchangePath, "utf8")) as DiscoveryExchange;
  const output: unknown = JSON.parse(await readFile(outputPath, "utf8"));
  const trustedModel = trustedModelConfig();
  if (command === "validate") {
    const result = validateDiscoveryOutput(exchange, output, trustedModel);
    console.log(JSON.stringify({ valid: result.issues.length === 0, issues: result.issues,
      ...(result.valid ? { trusted_model: result.valid.trusted_model } : {}) }, null, 2));
    if (result.issues.length) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(await validateAndPersistDiscovery(workspaceId, exchange, output, trustedModel), null, 2));
  }
} else {
  throw new Error("Usage: understanding-discovery.ts <select|export|export-chunks|validate|persist> [--workspace ID] [--limit 20] [--conversation UUID ...] [--exchange FILE --output FILE --provider NAME --model NAME --model-version VERSION]");
}

function trustedModelConfig(): TrustedDiscoveryModel {
  const provider = flag("provider") ?? process.env.DISCOVERY_MODEL_PROVIDER;
  const name = flag("model") ?? process.env.DISCOVERY_MODEL_NAME;
  const version = flag("model-version") ?? process.env.DISCOVERY_MODEL_VERSION;
  const runnerVersion = flag("runner-version") ?? "understanding-discovery-cli/0.2.0";
  if (!provider || !name) throw new Error("--provider and --model (or DISCOVERY_MODEL_PROVIDER/DISCOVERY_MODEL_NAME) are required for validate/persist.");
  return { provider, name, ...(version ? { version } : {}), runner_version: runnerVersion };
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
function flags(name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) result.push(process.argv[index + 1]!);
  }
  return result;
}
function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
