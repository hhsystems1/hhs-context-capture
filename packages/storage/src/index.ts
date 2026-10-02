import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CaptureBundle, EvidenceRecord } from "@hhs/canonical-schema";
import type { CaptureComparison } from "@hhs/capture-comparison";
import type { InventoryRun } from "@hhs/inventory-schema";
import { validateInventoryIntegrity } from "@hhs/inventory-schema";

export function approvedArchiveRoot(): string {
  const configured = process.env.HHS_ARCHIVE_ROOT?.trim();
  if (!configured) throw new Error("HHS_ARCHIVE_ROOT must be set in ignored local configuration.");
  return path.resolve(configured);
}

function codeRoot(): string {
  return path.resolve(process.env.HHS_CODE_ROOT?.trim() || process.cwd());
}

export interface ArchiveResult {
  archivePath: string;
  messageCount: number;
  hashes: Record<string, string>;
}

export type ArchiveFailureStage =
  | "prepare_paths"
  | "create_staging"
  | "write_payloads"
  | "write_hash_index"
  | "verify_hashes"
  | "finalize_archive"
  | "update_manifest";

export type ArchiveFailureCode =
  | "EACCES" | "EEXIST" | "EIO" | "EMFILE" | "ENFILE"
  | "ENOENT" | "ENOSPC" | "EPERM" | "EXDEV" | "UNKNOWN";

export interface ArchiveFailureDiagnostic {
  stage: ArchiveFailureStage;
  code: ArchiveFailureCode;
  cleanup: "completed" | "failed" | "not_needed";
}

export class ArchiveCaptureError extends Error {
  readonly diagnostic: ArchiveFailureDiagnostic;

  constructor(diagnostic: ArchiveFailureDiagnostic) {
    super(`Capture archive failed during ${diagnostic.stage} (${diagnostic.code}).`);
    this.name = "ArchiveCaptureError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export interface ArchiveFileSystem {
  appendFile: typeof appendFile;
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
}

const archiveFileSystem: ArchiveFileSystem = { appendFile, mkdir, open, readFile, rename, rm, stat };

export interface ArchiveCaptureOptions {
  fileSystem?: ArchiveFileSystem;
  stagingId?: string;
}

export interface InventoryArchiveResult {
  inventoryPath: string;
  evidencePath: string;
  hashes: Record<string, string>;
  hashesVerified: boolean;
}

export interface ComparisonArchiveResult {
  comparisonPath: string;
  reportSha256: string;
  hashesVerified: boolean;
}

export async function archiveComparison(comparison: CaptureComparison, platformId: string, opaqueAccountReference: string, conversationId: string): Promise<ComparisonArchiveResult> {
  const archiveRoot = approvedArchiveRoot();
  assertArchiveBoundaries(archiveRoot);
  const parent = containedPath(archiveRoot, "comparisons", safeSegment(platformId), accountArchiveSegment(opaqueAccountReference), `conversation-${shortHash(conversationId)}`);
  const finalPath = containedPath(parent, safeSegment(comparison.comparison_id));
  const reportPath = path.join(finalPath, "comparison.json");
  try {
    const existing = await readFile(reportPath, "utf8");
    const parsed = JSON.parse(existing) as CaptureComparison;
    if (parsed.comparison_sha256 !== comparison.comparison_sha256) throw new Error(`Immutable comparison conflict: ${comparison.comparison_id}`);
    return { comparisonPath: finalPath, reportSha256: sha256(existing), hashesVerified: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingPath = containedPath(parent, `.staging-${safeSegment(comparison.comparison_id)}`);
  await mkdir(stagingPath, { recursive: true });
  const serialized = stableJson(comparison);
  await writeExclusive(path.join(stagingPath, "comparison.json"), serialized);
  const reportHash = sha256(serialized);
  await writeExclusive(path.join(stagingPath, "hashes.sha256"), `${reportHash}  comparison.json\n`);
  const actual = sha256(await readFile(path.join(stagingPath, "comparison.json")));
  if (actual !== reportHash) throw new Error("Post-write comparison hash verification failed.");
  await rename(stagingPath, finalPath);
  await mkdir(path.join(archiveRoot, "manifests"), { recursive: true });
  await appendFile(path.join(archiveRoot, "manifests", "comparisons.jsonl"), `${JSON.stringify({ comparison_id: comparison.comparison_id, comparison_path: finalPath, report_sha256: reportHash })}\n`, { encoding: "utf8", flag: "a" });
  return { comparisonPath: finalPath, reportSha256: reportHash, hashesVerified: true };
}

export async function archiveInventory(inventory: InventoryRun): Promise<InventoryArchiveResult> {
  const archiveRoot = approvedArchiveRoot();
  assertArchiveBoundaries(archiveRoot);
  const failures = validateInventoryIntegrity(inventory);
  if (failures.length > 0) throw new Error(`Inventory integrity validation failed: ${failures.join(", ")}`);
  const account = accountArchiveSegment(inventory.account.opaque_account_reference);
  const compactTime = inventory.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const inventorySegment = safeSegment(`${compactTime}_${inventory.inventory_id.slice(0, 12)}`);
  const parent = containedPath(archiveRoot, "inventories", inventory.platform.platform_id, account);
  const finalPath = containedPath(parent, inventorySegment);
  const existing = await readExistingInventory(finalPath, inventory);
  if (existing) return existing;
  const stagingPath = containedPath(parent, `.staging-${inventorySegment}`);
  await mkdir(path.join(stagingPath, "raw"), { recursive: true });
  await mkdir(path.join(stagingPath, "normalized"), { recursive: true });
  await mkdir(path.join(stagingPath, "verification"), { recursive: true });
  const files = new Map<string, string>();
  files.set("raw/sanitized-inventory-evidence.json", stableJson(inventory.evidence));
  files.set("normalized/inventory.json", stableJson(inventory));
  files.set("inventory-manifest.json", stableJson({
    schema_version: inventory.schema_version,
    inventory_id: inventory.inventory_id,
    platform: inventory.platform,
    account: inventory.account,
    started_at: inventory.started_at,
    completed_at: inventory.completed_at,
    status: inventory.status,
    snapshot_sha256: inventory.snapshot_sha256,
    observation_count: inventory.observations.length
  }));
  files.set("verification/report.json", stableJson({
    status: inventory.status,
    boundary_verification: inventory.boundary_verification,
    warnings: inventory.warnings,
    evidence_count: inventory.evidence.length,
    evidence_hashes_verified_before_write: true
  }));
  const hashes: Record<string, string> = {};
  for (const [relative, value] of files) {
    await writeExclusive(containedPath(stagingPath, ...relative.split("/")), value);
    hashes[relative] = sha256(value);
  }
  await writeExclusive(path.join(stagingPath, "hashes.sha256"), renderHashes(hashes));
  await verifyStoredHashes(stagingPath, hashes);
  await rename(stagingPath, finalPath);
  await mkdir(path.join(archiveRoot, "manifests"), { recursive: true });
  await appendFile(path.join(archiveRoot, "manifests", "inventories.jsonl"), `${JSON.stringify({ inventory_id: inventory.inventory_id, inventory_path: finalPath, completed_at: inventory.completed_at, manifest_sha256: hashes["inventory-manifest.json"] })}\n`, { encoding: "utf8", flag: "a" });
  return { inventoryPath: finalPath, evidencePath: path.join(finalPath, "raw", "sanitized-inventory-evidence.json"), hashes, hashesVerified: true };
}

export function catalogPathFor(platformId: string, opaqueAccountReference: string): string {
  const archiveRoot = approvedArchiveRoot();
  assertArchiveBoundaries(archiveRoot);
  return containedPath(archiveRoot, "catalog", safeSegment(platformId), accountArchiveSegment(opaqueAccountReference));
}

export function operationalPathFor(kind: "recapture" | "review", platformId: string, opaqueAccountReference: string): string {
  const archiveRoot = approvedArchiveRoot();
  assertArchiveBoundaries(archiveRoot);
  return containedPath(archiveRoot, "operations", kind, safeSegment(platformId), accountArchiveSegment(opaqueAccountReference));
}

export function accountArchiveSegment(opaqueAccountReference: string): string {
  return `account-${shortHash(opaqueAccountReference)}`;
}

export async function archiveCapture(bundle: CaptureBundle, options: ArchiveCaptureOptions = {}): Promise<ArchiveResult> {
  const fs = options.fileSystem ?? archiveFileSystem;
  let stage: ArchiveFailureStage = "prepare_paths";
  let stagingPath: string | undefined;
  let stagingCreated = false;
  let finalized = false;
  try {
    const archiveRoot = approvedArchiveRoot();
    assertArchiveBoundaries(archiveRoot);
    const account = accountArchiveSegment(bundle.account.opaque_account_reference);
    const conversation = `conversation-${shortHash(bundle.conversation.conversation_id)}`;
    const compactTime = bundle.capture.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const capture = safeSegment(`${compactTime}_${bundle.capture.capture_id.slice(0, 12)}`);
    const parent = containedPath(archiveRoot, "captures", bundle.platform.id, account, conversation);
    const finalPath = containedPath(parent, capture);
    stagingPath = containedPath(parent, `.staging-${capture}-${safeSegment(options.stagingId ?? randomUUID())}`);

    stage = "create_staging";
    if (await pathExists(finalPath, fs)) throw errnoError("EEXIST");
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(stagingPath, { recursive: false });
    stagingCreated = true;
    await fs.mkdir(path.join(stagingPath, "raw", "screenshots"), { recursive: true });
    await fs.mkdir(path.join(stagingPath, "canonical"), { recursive: true });
    await fs.mkdir(path.join(stagingPath, "normalized"), { recursive: true });
    await fs.mkdir(path.join(stagingPath, "verification"), { recursive: true });

    const files = new Map<string, string | Buffer>();
    const sanitizedDom = bundle.evidence.filter((item) => item.kind === "sanitized_dom");
    files.set("raw/sanitized-dom-evidence.json", stableJson(sanitizedDom));
    files.set("raw/extraction-observations.json", stableJson(bundle.platform_metadata));
    files.set("canonical/conversation.json", stableJson({ conversation: bundle.conversation, messages: bundle.messages, branches: bundle.branches, attachments: bundle.attachments, citations: bundle.citations, artifacts: bundle.artifacts, tool_events: bundle.tool_events }));
    files.set("canonical/active-branch.txt", renderExactAccessibleTranscript(bundle));
    files.set("normalized/conversation.json", stableJson(bundle));
    files.set("capture-manifest.json", stableJson({ schema_version: bundle.schema_version, capture: bundle.capture, platform: bundle.platform, account: bundle.account, conversation: bundle.conversation }));

    for (const evidence of bundle.evidence.filter((item) => item.kind === "screenshot")) {
      const extension = evidence.media_type === "image/png" ? "png" : "bin";
      files.set(`raw/screenshots/${safeSegment(`${evidence.portion}-${evidence.evidence_id.slice(0, 12)}`)}.${extension}`, decodeInlineEvidence(evidence));
    }

    const requiredBeforeVerification = [...files.keys()];
    files.set("verification/report.json", stableJson({
      status: bundle.verification.status,
      capture_verification: bundle.verification,
      archive_checks: [
        { check_id: "archive.required_files_staged", status: "pass", message: `${requiredBeforeVerification.length} required archive payloads prepared before finalization.` },
        { check_id: "archive.exclusive_writes", status: "pass", message: "Archive payloads use create-new exclusive writes and cannot overwrite existing capture files." },
        { check_id: "archive.hashes_planned", status: "pass", message: "Every stored payload, including this report, will receive an independent collector SHA-256 hash." }
      ]
    }));

    stage = "write_payloads";
    const hashes: Record<string, string> = {};
    for (const [relative, value] of files) {
      await writeExclusive(containedPath(stagingPath, ...relative.split("/")), value, fs);
      hashes[relative] = sha256(value);
    }
    stage = "write_hash_index";
    await writeExclusive(path.join(stagingPath, "hashes.sha256"), renderHashes(hashes), fs);

    stage = "verify_hashes";
    await verifyStoredHashes(stagingPath, hashes, fs);

    stage = "finalize_archive";
    await fs.rename(stagingPath, finalPath);
    finalized = true;
    stage = "update_manifest";
    await fs.mkdir(path.join(archiveRoot, "manifests"), { recursive: true });
    await fs.appendFile(path.join(archiveRoot, "manifests", "captures.jsonl"), `${JSON.stringify({ capture_id: bundle.capture.capture_id, archive_path: finalPath, captured_at: bundle.capture.completed_at, manifest_sha256: hashes["capture-manifest.json"] })}\n`, { encoding: "utf8", flag: "a" });
    return { archivePath: finalPath, messageCount: bundle.messages.length, hashes };
  } catch (error) {
    let cleanup: ArchiveFailureDiagnostic["cleanup"] = finalized || !stagingCreated || !stagingPath ? "not_needed" : "completed";
    if (!finalized && stagingCreated && stagingPath) {
      try {
        await fs.rm(stagingPath, { recursive: true, force: true });
      } catch {
        cleanup = "failed";
      }
    }
    throw new ArchiveCaptureError({ stage, code: safeArchiveFailureCode(error), cleanup });
  }
}

export function assertArchiveBoundaries(archiveRoot: string): void {
  const resolved = path.resolve(archiveRoot);
  const approved = approvedArchiveRoot();
  if (resolved.toLowerCase() !== approved.toLowerCase()) throw new Error("Collector archive root is not the approved archive directory.");
  const repositoryRoot = codeRoot();
  if (isWithin(repositoryRoot, resolved) || isWithin(resolved, repositoryRoot)) throw new Error("Code and archive roots must remain separate.");
}

function containedPath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  if (!isWithin(root, resolved)) throw new Error("Archive path traversal rejected.");
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new Error("Unsafe empty archive path segment.");
  return safe;
}

async function writeExclusive(destination: string, value: string | Buffer, fs: Pick<ArchiveFileSystem, "open"> = archiveFileSystem): Promise<void> {
  const handle = await fs.open(destination, "wx");
  try { await handle.writeFile(value); } finally { await handle.close(); }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function decodeInlineEvidence(evidence: EvidenceRecord): Buffer {
  const comma = evidence.inline_data.indexOf(",");
  const payload = comma >= 0 ? evidence.inline_data.slice(comma + 1) : evidence.inline_data;
  return Buffer.from(payload, "base64");
}

function renderExactAccessibleTranscript(bundle: CaptureBundle): string {
  const lines = [
    `Exact accessible rendered transcript`,
    `Platform: ${bundle.platform.id}`,
    `Conversation: ${bundle.conversation.title}`,
    `Source: ${bundle.conversation.source_url}`,
    "",
  ];
  for (const message of bundle.messages) {
    const rendered = message.representations.find((item) => item.kind === "canonical_text")?.value ?? "";
    lines.push(`----- ${message.sequence} ${message.role} -----`, rendered, "");
  }
  return lines.join("\n");
}

function renderHashes(hashes: Record<string, string>): string {
  return Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => `${hash}  ${file}`).join("\n") + "\n";
}

async function verifyStoredHashes(root: string, hashes: Record<string, string>, fs: Pick<ArchiveFileSystem, "readFile"> = archiveFileSystem): Promise<void> {
  for (const [relative, expected] of Object.entries(hashes)) {
    const actual = sha256(await fs.readFile(containedPath(root, ...relative.split("/"))));
    if (actual !== expected) throw new Error(`Post-write hash verification failed for ${relative}.`);
  }
}

async function pathExists(candidate: string, fs: Pick<ArchiveFileSystem, "stat">): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("Archive filesystem operation rejected."), { code });
}

function safeArchiveFailureCode(error: unknown): ArchiveFailureCode {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN";
  const allowed = new Set<ArchiveFailureCode>(["EACCES", "EEXIST", "EIO", "EMFILE", "ENFILE", "ENOENT", "ENOSPC", "EPERM", "EXDEV", "UNKNOWN"]);
  return allowed.has(code as ArchiveFailureCode) ? code as ArchiveFailureCode : "UNKNOWN";
}

async function readExistingInventory(finalPath: string, inventory: InventoryRun): Promise<InventoryArchiveResult | undefined> {
  try {
    const stored = JSON.parse(await readFile(path.join(finalPath, "normalized", "inventory.json"), "utf8")) as InventoryRun;
    if (stored.inventory_id !== inventory.inventory_id || stored.snapshot_sha256 !== inventory.snapshot_sha256) throw new Error(`Immutable inventory identity conflict at ${finalPath}.`);
    const hashText = await readFile(path.join(finalPath, "hashes.sha256"), "utf8");
    const hashes = Object.fromEntries(hashText.trim().split(/\r?\n/).map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid stored inventory hash line: ${line}`);
      return [match[2]!, match[1]!];
    }));
    await verifyStoredHashes(finalPath, hashes);
    return { inventoryPath: finalPath, evidencePath: path.join(finalPath, "raw", "sanitized-inventory-evidence.json"), hashes, hashesVerified: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
