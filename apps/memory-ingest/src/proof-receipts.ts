import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert, transaction } from "./db.js";

export const PROOF_RECEIPT_SCHEMA_VERSION = "hhs.memory-proof-receipt/1.1.0";
export type ProofKind = "clean_first_ingestion" | "idempotent_replay" | "interrupted_resume" | "workspace_isolation" |
  "invalid_evidence_quarantine" | "failure_cannot_complete" | "changed_pipeline_coexistence" |
  "database_immutability" | "exact_provenance_resolution" | "completed_insert_rejection" |
  "fatal_quarantine_terminal" | "retry_lineage" | "legacy_provenance_repair" | "review_approval_query";

export interface ProofReceiptInput {
  proofRoot: string;
  proofKind: ProofKind;
  workspaceId: string;
  ingestionRunId: string;
  pipelineVersion: string;
  captureId: string;
  archiveTreeSha256: string;
  assertions: Record<string, unknown>;
}

export interface StoredProofReceipt {
  proofReceiptId: string;
  proofKind: ProofKind;
  directory: string;
  receiptSha256: string;
  manifestSha256: string;
}

export async function writeAndPersistProofReceipt(input: ProofReceiptInput): Promise<StoredProofReceipt> {
  const stored = await writeProofReceipt(input);
  const pool = createPool("writer");
  try {
    await transaction(pool, input.workspaceId, async (client) => {
      const natural = [input.proofKind, input.pipelineVersion, stored.receiptSha256];
      const body = {
        workspace_id: input.workspaceId,
        proof_receipt_id: stored.proofReceiptId,
        ingestion_run_id: input.ingestionRunId,
        pipeline_version: input.pipelineVersion,
        proof_kind: input.proofKind,
        schema_version: PROOF_RECEIPT_SCHEMA_VERSION,
        receipt_locator: stored.directory,
        receipt_sha256: stored.receiptSha256,
        archive_tree_sha256: input.archiveTreeSha256,
        idempotency_key: idempotencyKey("proof_receipt", input.workspaceId, natural),
        created_at: new Date().toISOString()
      };
      await immutableInsert(client, "proof_receipts", "proof_receipt_id", { ...body, record_sha256: sha256(body) });
    });
    return stored;
  } finally { await pool.end(); }
}

export async function writeProofReceipt(input: ProofReceiptInput): Promise<StoredProofReceipt> {
  await mkdir(input.proofRoot, { recursive: true });
  const now = new Date().toISOString();
  const proofReceiptId = `proof_receipt_${sha256([input.proofKind, input.pipelineVersion, now, randomUUID()]).slice(0, 32)}`;
  const leaf = `${now.replace(/[-:.]/g, "")}_${input.proofKind}_${proofReceiptId.slice(-8)}`;
  const staging = path.join(input.proofRoot, `.tmp-${randomUUID()}`);
  const destination = path.join(input.proofRoot, leaf);
  await mkdir(staging, { recursive: false });
  const receipt = {
    schema_version: PROOF_RECEIPT_SCHEMA_VERSION,
    proof_receipt_id: proofReceiptId,
    proof_kind: input.proofKind,
    created_at: now,
    workspace_id: input.workspaceId,
    ingestion_run_id: input.ingestionRunId,
    pipeline_version: input.pipelineVersion,
    capture_id: input.captureId,
    archive_tree_sha256: input.archiveTreeSha256,
    assertions: input.assertions
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const receiptSha256 = digest(receiptBytes);
  const manifest = {
    schema_version: "hhs.memory-proof-manifest/1.0.0",
    proof_receipt_id: proofReceiptId,
    created_at: now,
    files: [{ path: "receipt.json", sha256: receiptSha256, bytes: receiptBytes.length }]
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = digest(manifestBytes);
  const hashIndex = `${receiptSha256}  receipt.json\n${manifestSha256}  manifest.json\n`;
  await writeFile(path.join(staging, "receipt.json"), receiptBytes, { flag: "wx" });
  await writeFile(path.join(staging, "manifest.json"), manifestBytes, { flag: "wx" });
  await writeFile(path.join(staging, "hashes.sha256"), hashIndex, { flag: "wx" });
  await verifyProofDirectory(staging);
  await rename(staging, destination);
  return { proofReceiptId, proofKind: input.proofKind, directory: destination, receiptSha256, manifestSha256 };
}

export async function verifyProofRoot(proofRoot: string): Promise<{ receiptDirectories: number; verified: number; failures: string[] }> {
  const entries = await readdir(proofRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-")).map((entry) => path.join(proofRoot, entry.name));
  const failures: string[] = [];
  let verified = 0;
  for (const directory of directories) {
    try { await verifyProofDirectory(directory); verified++; }
    catch (error) { failures.push(`${path.basename(directory)}:${error instanceof Error ? error.message : String(error)}`); }
  }
  return { receiptDirectories: directories.length, verified, failures };
}

export async function archiveTreeSha256(capturePath: string): Promise<string> {
  const files = await listFiles(capturePath);
  const lines: string[] = [];
  for (const file of files.sort()) lines.push(`${path.relative(capturePath, file).split(path.sep).join("/")}\0${digest(await readFile(file))}`);
  return digest(Buffer.from(lines.join("\n"), "utf8"));
}

async function verifyProofDirectory(directory: string): Promise<void> {
  const hashText = await readFile(path.join(directory, "hashes.sha256"), "utf8");
  const lines = hashText.trim().split(/\r?\n/);
  if (lines.length !== 2) throw new Error("proof hash index must contain exactly two entries");
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(receipt\.json|manifest\.json)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("malformed proof hash entry");
    const file = path.join(directory, match[2]);
    if (!(await stat(file)).isFile() || digest(await readFile(file)) !== match[1]) throw new Error(`${match[2]} hash mismatch`);
  }
  const receipt = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8")) as Record<string, unknown>;
  if (receipt.schema_version !== PROOF_RECEIPT_SCHEMA_VERSION) throw new Error("unsupported proof receipt schema");
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(full)); else if (entry.isFile()) output.push(full);
  }
  return output;
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
