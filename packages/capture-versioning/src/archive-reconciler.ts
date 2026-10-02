import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CaptureBundle } from "@hhs/canonical-schema";
import type { ReconciliationCandidate } from "./index.js";
import { createImmutableCaptureVersion, sha256 } from "./index.js";

export interface ArchiveScanResult {
  candidates: ReconciliationCandidate[];
  warnings: Array<{ archive_path: string; reason: string }>;
}

export async function scanCaptureArchiveReadOnly(captureRoot: string, expected: { platform_id: string; opaque_account_reference: string }): Promise<ArchiveScanResult> {
  const root = path.resolve(captureRoot);
  const manifestDirectories = await findManifestDirectories(root);
  const candidates: ReconciliationCandidate[] = [];
  const warnings: ArchiveScanResult["warnings"] = [];
  for (const archivePath of manifestDirectories) {
    try {
      const hashes = await readHashManifest(archivePath);
      const failures = await verifyArchiveHashes(archivePath, hashes);
      if (failures.length > 0) { warnings.push({ archive_path: archivePath, reason: `archive_hash_failure:${failures.join(",")}` }); continue; }
      const bundle = JSON.parse(await readFile(containedPath(archivePath, "normalized", "conversation.json"), "utf8")) as CaptureBundle;
      if (bundle.platform.id !== expected.platform_id || bundle.account.opaque_account_reference !== expected.opaque_account_reference) {
        warnings.push({ archive_path: archivePath, reason: "platform_or_opaque_account_mismatch" });
        continue;
      }
      const manifestHash = hashes["capture-manifest.json"];
      if (!manifestHash) { warnings.push({ archive_path: archivePath, reason: "capture_manifest_hash_missing" }); continue; }
      candidates.push({ version: createImmutableCaptureVersion(bundle, archivePath, manifestHash), source_archive_path: archivePath, source_hashes_verified: true });
    } catch (error) {
      warnings.push({ archive_path: archivePath, reason: `scan_error:${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { candidates, warnings };
}

async function findManifestDirectories(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = containedPath(root, path.relative(root, directory), entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === "capture-manifest.json") results.push(directory);
    }
  }
  await visit(root);
  return [...new Set(results)].sort();
}

async function readHashManifest(archivePath: string): Promise<Record<string, string>> {
  const text = await readFile(containedPath(archivePath, "hashes.sha256"), "utf8");
  return Object.fromEntries(text.trim().split(/\r?\n/).map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid hash manifest line: ${line}`);
    return [match[2]!, match[1]!];
  }));
}

async function verifyArchiveHashes(archivePath: string, hashes: Record<string, string>): Promise<string[]> {
  const failures: string[] = [];
  for (const [relative, expected] of Object.entries(hashes)) {
    try {
      const actual = sha256(await readFile(containedPath(archivePath, ...relative.split("/"))));
      if (actual !== expected) failures.push(relative);
    } catch { failures.push(relative); }
  }
  return failures;
}

function containedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Archive reconciliation path traversal rejected.");
  return resolved;
}
