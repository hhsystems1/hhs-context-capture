import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [inventoryArgument, catalogArgument] = process.argv.slice(2);
if (!inventoryArgument || !catalogArgument) {
  console.error("Usage: npm run audit:inventory -- <inventory-archive-path> <catalog-path>");
  process.exitCode = 2;
} else {
  const result = auditInventory(path.resolve(inventoryArgument), path.resolve(catalogArgument));
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 1;
}

export function auditInventory(inventoryRoot, catalogRoot) {
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const inventory = readJson(containedPath(inventoryRoot, "normalized", "inventory.json"));
  const manifest = readJson(containedPath(inventoryRoot, "inventory-manifest.json"));
  const report = readJson(containedPath(inventoryRoot, "verification", "report.json"));
  const inventoryPayload = { ...inventory };
  delete inventoryPayload.snapshot_sha256;
  const evidenceHashFailures = inventory.evidence.filter((item) => sha256(item.value) !== item.sha256).map((item) => item.evidence_id);
  const archiveHashFailures = [];
  const hashLines = fs.readFileSync(containedPath(inventoryRoot, "hashes.sha256"), "utf8").trim().split(/\r?\n/);
  for (const line of hashLines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) { archiveHashFailures.push(`invalid:${line}`); continue; }
    let file;
    try { file = containedPath(inventoryRoot, ...match[2].split("/")); }
    catch { archiveHashFailures.push(`unsafe-path:${match[2]}`); continue; }
    if (!fs.existsSync(file)) { archiveHashFailures.push(`missing:${match[2]}`); continue; }
    if (sha256(fs.readFileSync(file)) !== match[1]) archiveHashFailures.push(`mismatch:${match[2]}`);
  }

  const identities = countBy(inventory.observations, (item) => item.conversation_id);
  const positions = countBy(inventory.observations, (item) => item.sidebar_position);
  const ordered = [...inventory.observations].sort((a, b) => a.sidebar_position - b.sidebar_position);
  const catalog = readJson(containedPath(catalogRoot, "catalog.json"));
  const inventoryRecord = catalog.inventories[inventory.inventory_id];
  const records = Object.values(catalog.conversations).filter((record) => record.classification.inventory_id === inventory.inventory_id);
  const classifications = { new: 0, possibly_changed: 0, unchanged: 0, missing: 0, needs_review: 0 };
  for (const record of records) classifications[record.classification.classification] += 1;
  const transaction = findTransaction(catalogRoot, inventoryRecord?.transaction_id);
  const transactionPayload = transaction ? { ...transaction } : undefined;
  if (transactionPayload) delete transactionPayload.transaction_sha256;
  const transactionHashValid = Boolean(transaction && sha256(stableJson(transactionPayload)) === transaction.transaction_sha256);
  const transactionApplied = Boolean(transaction && catalog.applied_transactions.includes(transaction.transaction_id));
  const duplicateIds = [...identities].filter(([, count]) => count > 1);
  const duplicatePositions = [...positions].filter(([, count]) => count > 1);
  const inventorySnapshotHashValid = sha256(stableJson(inventoryPayload)) === inventory.snapshot_sha256;
  const statusesAgree = inventory.status === manifest.status && inventory.status === report.status;
  const verified = statusesAgree && inventorySnapshotHashValid && evidenceHashFailures.length === 0 && archiveHashFailures.length === 0 && duplicateIds.length === 0 && duplicatePositions.length === 0 && transactionHashValid && transactionApplied;

  return {
    verified,
    inventoryId: inventory.inventory_id,
    status: inventory.status,
    statusesAgree,
    observedCount: inventory.observations.length,
    evidenceCount: inventory.evidence.length,
    warnings: inventory.warnings,
    boundaryVerification: inventory.boundary_verification,
    latestSidebarItem: summarize(ordered[0]),
    earliestSidebarItem: summarize(ordered.at(-1)),
    reviewObservations: inventory.observations.filter((item) => item.review_status === "needs_review").length,
    duplicateConversationIds: duplicateIds,
    duplicateSidebarPositions: duplicatePositions,
    inventorySnapshotHashValid,
    evidenceHashFailures,
    archiveHashEntries: hashLines.length,
    archiveHashFailures,
    catalogRevision: catalog.revision,
    currentCatalogRecords: records.length,
    classifications,
    transactionHashValid,
    transactionApplied
  };
}

function findTransaction(catalogRoot, transactionId) {
  if (!transactionId) return undefined;
  const transactionRoot = containedPath(catalogRoot, "transactions");
  for (const name of fs.readdirSync(transactionRoot).filter((item) => item.endsWith(".json"))) {
    const transaction = JSON.parse(fs.readFileSync(containedPath(transactionRoot, name), "utf8"));
    if (transaction.transaction_id === transactionId) return transaction;
  }
  return undefined;
}

function countBy(values, keyFor) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function summarize(item) {
  return item ? { sidebarPosition: item.sidebar_position, conversationId: item.conversation_id, title: item.title, sourceUrl: item.source_url ?? null, accessibleTimestamp: item.platform_metadata?.accessible_timestamp ?? null } : null;
}

function containedPath(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Audit path escapes the supplied root: ${resolved}`);
  return resolved;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
}
