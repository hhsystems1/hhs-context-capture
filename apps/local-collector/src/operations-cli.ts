import path from "node:path";
import { approvedArchiveRoot } from "@hhs/storage";
import { operationStoreFromEnvironment } from "./operations.js";
import { proveCaptureOperations } from "./operations-prove.js";

const command = process.argv[2] ?? "report";
const archiveRoot = approvedArchiveRoot();
const store = operationStoreFromEnvironment(archiveRoot);

try {
  if (command === "report") {
    const latest = await store.latest();
    const operations = await store.list(true);
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      mode: "read_only",
      authoritative_store: "local_postgresql",
      latest_operation: latest,
      stuck_or_nonterminal: operations.filter((operation) => operation.stuck || !["completed", "needs_review", "failed", "interrupted", "canceled"].includes(operation.status)),
      operation_count: operations.length
    }, null, 2));
  } else if (command === "reconcile") {
    const operationId = process.argv[3];
    if (!operationId) throw new Error("Usage: operations:reconcile -- <operation-id> [timeout-seconds]");
    const timeout = Number(process.argv[4] ?? 900);
    console.log(JSON.stringify(await store.reconcile(operationId, timeout), null, 2));
  } else if (command === "prove") {
    await store.close();
    console.log(JSON.stringify(await proveCaptureOperations({
      archiveRoot,
      approvedCapturePath: required("MEMORY_APPROVED_CAPTURE_PATH"),
      existingMemoryProofRoot: required("MEMORY_PROOF_ROOT"),
      workspaceId: required("MEMORY_WORKSPACE_ID"),
      writerDatabaseUrl: required("MEMORY_INGEST_DATABASE_URL"),
      readerDatabaseUrl: required("MEMORY_REPORT_DATABASE_URL"),
      adminDatabaseUrl: required("MEMORY_DATABASE_URL"),
      operationsRoot: path.join(archiveRoot, "operations", "capture-operations-v1"),
      proofRoot: path.join(archiveRoot, "operations", "proofs", "capture-operations-v1")
    }), null, 2));
  } else throw new Error("Usage: operations-cli.ts <report|reconcile|prove>");
} finally {
  if (command !== "prove") await store.close();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
