/** Read-only CLI for the deterministic HHS reconstruction inventory. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_RECONSTRUCTION_BATCH_SIZE,
  buildDiscoveryReceipt,
  formatReconstructionReport,
  loadReconstructionInventory,
  type DiscoveryReceipt
} from "../apps/memory-ingest/src/reconstruction-inventory.js";
import type { DiscoveryExchange, DiscoveryOutput } from "../apps/memory-ingest/src/understanding-discovery.js";

const USAGE = "Usage: reconstruction-inventory.ts <json|report> --workspace ID [--batch-size 10] "
  + "[--receipt-exchange FILE --receipt-output FILE ...] [--generated-at ISO] [--output NEW_FILE]";

const command = process.argv[2];
if (command !== "json" && command !== "report") throw new Error(USAGE);
const workspaceId = requiredFlag("workspace");
const batchSize = Number(flag("batch-size") ?? String(DEFAULT_RECONSTRUCTION_BATCH_SIZE));
const generatedAt = flag("generated-at") ?? new Date().toISOString();

const receipts = await loadSuppliedReceipts(receiptPairs());
const snapshot = await loadReconstructionInventory(workspaceId, receipts, generatedAt, batchSize);

if (command === "json") {
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  const destination = flag("output");
  if (destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, serialized, { encoding: "utf8", flag: "wx" });
    console.error(`RECONSTRUCTION_INVENTORY_WRITTEN=${path.resolve(destination)}`);
  } else {
    process.stdout.write(serialized);
  }
} else {
  console.log(formatReconstructionReport(snapshot));
}

/**
 * Pairs repeatable receipt artifacts by supplied order.
 *
 * `--pilot-exchange`/`--pilot-output` remain accepted spellings of the same
 * inputs so the original bounded pilot invocation keeps working. Argv is walked
 * once so mixed spellings still pair positionally.
 */
function receiptPairs(): Array<{ exchange_path: string; output_path: string }> {
  const exchanges: string[] = [];
  const outputs: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const value = process.argv[index + 1];
    if (!value) continue;
    if (process.argv[index] === "--receipt-exchange" || process.argv[index] === "--pilot-exchange") exchanges.push(value);
    if (process.argv[index] === "--receipt-output" || process.argv[index] === "--pilot-output") outputs.push(value);
  }
  if (exchanges.length !== outputs.length) {
    throw new Error(`Each discovery receipt needs one exchange and one output; observed ${exchanges.length} exchange(s) and ${outputs.length} output(s).`);
  }
  return exchanges.map((exchange_path, index) => ({ exchange_path, output_path: outputs[index]! }));
}

/**
 * Turns validated artifact pairs into receipts. Receipt identity and membership
 * come from the validated exchange, never from a file path or a batch number,
 * and receipt size is deliberately unconstrained: a receipt covers exactly the
 * conversations its own exchange selected.
 */
async function loadSuppliedReceipts(pairs: Array<{ exchange_path: string; output_path: string }>): Promise<DiscoveryReceipt[]> {
  const receipts: DiscoveryReceipt[] = [];
  const seenExchangeIds = new Map<string, string>();
  for (const pair of pairs) {
    const label = `${pair.exchange_path} + ${pair.output_path}`;
    let receipt: DiscoveryReceipt;
    try {
      const exchange = JSON.parse(await readFile(pair.exchange_path, "utf8")) as DiscoveryExchange;
      const output = JSON.parse(await readFile(pair.output_path, "utf8")) as DiscoveryOutput;
      receipt = buildDiscoveryReceipt(exchange, output);
    } catch (cause) {
      throw new Error(`Discovery receipt rejected (${label}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    const duplicate = seenExchangeIds.get(receipt.exchange_id);
    if (duplicate) throw new Error(`Exchange ${receipt.exchange_id} was supplied twice (${duplicate}, then ${label}).`);
    seenExchangeIds.set(receipt.exchange_id, label);
    console.error(`RECONSTRUCTION_RECEIPT_LOADED=${receipt.exchange_id} conversations=${receipt.source_conversation_ids.length} artifacts="${label}"`);
    receipts.push(receipt);
  }
  if (receipts.length === 0) console.error("RECONSTRUCTION_RECEIPTS_LOADED=0 (no validated discovery receipts supplied)");
  return receipts;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requiredFlag(name: string): string {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required; environment fallback is intentionally disabled.`);
  return value;
}
