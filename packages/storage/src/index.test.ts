import { createHash } from "node:crypto";
import {
  appendFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, writeFile
} from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveCaptureError, approvedArchiveRoot, archiveCapture, assertArchiveBoundaries, catalogPathFor,
  type ArchiveFileSystem
} from "./index.js";
import { realisticCaptureBundle, realisticLargeCaptureBundle } from "./test-fixtures.js";

const testRuntimeRoot = path.join(process.cwd(), ".test-runtime");
const codeBoundary = path.join(process.cwd(), ".test-code-boundary");
let archiveRoot: string;

const realFileSystem: ArchiveFileSystem = { appendFile, mkdir, open, readFile, rename, rm, stat };
const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

beforeEach(async () => {
  await mkdir(testRuntimeRoot, { recursive: true });
  archiveRoot = await mkdtemp(path.join(testRuntimeRoot, "storage-"));
  process.env.HHS_ARCHIVE_ROOT = archiveRoot;
  process.env.HHS_CODE_ROOT = codeBoundary;
});

afterEach(async () => {
  await rm(archiveRoot, { recursive: true, force: true });
  delete process.env.HHS_ARCHIVE_ROOT;
  delete process.env.HHS_CODE_ROOT;
});

afterAll(async () => {
  await rmdir(testRuntimeRoot);
});

describe("archive boundaries", () => {
  it("accepts only the approved root", () => {
    expect(approvedArchiveRoot()).toBe(archiveRoot);
    expect(() => assertArchiveBoundaries(archiveRoot)).not.toThrow();
    expect(() => assertArchiveBoundaries(path.join(testRuntimeRoot, "other"))).toThrow();
  });

  it("places opaque-account catalogs only beneath the approved archive root", () => {
    const catalogPath = catalogPathFor("chatgpt", "account-opaque-fixture");
    expect(catalogPath.startsWith(archiveRoot)).toBe(true);
    expect(catalogPath).not.toContain("account-opaque-fixture");
    expect(catalogPath).toMatch(/catalog[\\/]chatgpt[\\/]account-[a-f0-9]{16}$/);
  });
});

describe("archiveCapture", () => {
  it("stages, exclusively writes, verifies, renames, and manifests a realistic canonical bundle", async () => {
    const openFlags: string[] = [];
    const renameCalls: Array<[string, string]> = [];
    let stagingExistedAtRename = false;
    const fileSystem: ArchiveFileSystem = {
      ...realFileSystem,
      open: async (...args) => {
        openFlags.push(String(args[1]));
        return open(...args);
      },
      rename: async (...args) => {
        renameCalls.push([String(args[0]), String(args[1])]);
        stagingExistedAtRename = (await stat(args[0])).isDirectory();
        return rename(...args);
      }
    };
    const bundle = realisticCaptureBundle();

    const result = await archiveCapture(bundle, { fileSystem, stagingId: "behavior-success" });

    expect(result.messageCount).toBe(bundle.messages.length);
    expect(stagingExistedAtRename).toBe(true);
    expect(openFlags.length).toBe(Object.keys(result.hashes).length + 1);
    expect(new Set(openFlags)).toEqual(new Set(["wx"]));
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]![0]).toContain(".staging-");
    expect(renameCalls[0]![1]).toBe(result.archivePath);
    await expect(stat(renameCalls[0]![0])).rejects.toMatchObject({ code: "ENOENT" });

    const expectedFiles = [
      "canonical/active-branch.txt",
      "canonical/conversation.json",
      "capture-manifest.json",
      "hashes.sha256",
      "normalized/conversation.json",
      "raw/extraction-observations.json",
      "raw/sanitized-dom-evidence.json",
      "raw/screenshots/latest_boundary-evidence-scr.png",
      "verification/report.json"
    ];
    await expect(relativeFiles(result.archivePath)).resolves.toEqual(expectedFiles);

    for (const [relative, expected] of Object.entries(result.hashes)) {
      expect(digest(await readFile(path.join(result.archivePath, ...relative.split("/"))))).toBe(expected);
    }
    const hashLines = (await readFile(path.join(result.archivePath, "hashes.sha256"), "utf8")).trim().split(/\r?\n/);
    expect(hashLines).toHaveLength(Object.keys(result.hashes).length);
    expect(hashLines).toEqual([...hashLines].sort((a, b) => a.slice(66).localeCompare(b.slice(66))));

    const manifestLines = (await readFile(path.join(archiveRoot, "manifests", "captures.jsonl"), "utf8")).trim().split(/\r?\n/);
    expect(manifestLines).toHaveLength(1);
    expect(JSON.parse(manifestLines[0]!)).toEqual({
      capture_id: bundle.capture.capture_id,
      archive_path: result.archivePath,
      captured_at: bundle.capture.completed_at,
      manifest_sha256: result.hashes["capture-manifest.json"]
    });
  });

  it("archives a realistic large conversation through the same verified path", async () => {
    const bundle = realisticLargeCaptureBundle();
    const result = await archiveCapture(bundle, { stagingId: "large-success" });
    const normalized = await readFile(path.join(result.archivePath, "normalized", "conversation.json"));

    expect(result.messageCount).toBe(420);
    expect(normalized.byteLength).toBeGreaterThan(5_000_000);
    expect(digest(normalized)).toBe(result.hashes["normalized/conversation.json"]);
    expect(JSON.parse(normalized.toString("utf8")).messages).toHaveLength(420);
  }, 20_000);

  it("rejects duplicate capture destinations without overwriting archive files or appending the manifest", async () => {
    const bundle = realisticCaptureBundle();
    const first = await archiveCapture(bundle, { stagingId: "first-attempt" });
    const markerPath = path.join(first.archivePath, "capture-manifest.json");
    const before = await readFile(markerPath);

    await expect(archiveCapture(bundle, { stagingId: "duplicate-attempt" })).rejects.toMatchObject({
      diagnostic: { stage: "create_staging", code: "EEXIST", cleanup: "not_needed" }
    });

    expect(await readFile(markerPath)).toEqual(before);
    expect((await readFile(path.join(archiveRoot, "manifests", "captures.jsonl"), "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
    expect((await findStagingDirectories(archiveRoot))).toEqual([]);
  });

  it("does not collide with or remove a legacy deterministic staging directory", async () => {
    const bundle = realisticCaptureBundle();
    const account = digest(bundle.account.opaque_account_reference).slice(0, 16);
    const conversation = digest(bundle.conversation.conversation_id).slice(0, 16);
    const legacyStaging = path.join(
      archiveRoot, "captures", bundle.platform.id, `account-${account}`, `conversation-${conversation}`,
      `.staging-20260723T183000Z_${bundle.capture.capture_id.slice(0, 12)}`
    );
    await mkdir(legacyStaging, { recursive: true });
    await writeFile(path.join(legacyStaging, "partial-marker.txt"), "prior failed attempt", { flag: "wx" });

    const result = await archiveCapture(bundle, { stagingId: "fresh-retry" });

    expect((await stat(result.archivePath)).isDirectory()).toBe(true);
    expect(await readFile(path.join(legacyStaging, "partial-marker.txt"), "utf8")).toBe("prior failed attempt");
  });

  it("cleans only its staging directory and emits sanitized diagnostics after an exclusive-write failure", async () => {
    const forbidden = "raw-message-sentinel; authentication-data-sentinel; environment-value-sentinel";
    let openCount = 0;
    const fileSystem: ArchiveFileSystem = {
      ...realFileSystem,
      open: async (...args) => {
        openCount += 1;
        if (openCount === 3) throw Object.assign(new Error(forbidden), { code: "ENOSPC" });
        return open(...args);
      }
    };
    const unrelated = path.join(archiveRoot, "unrelated-marker.txt");
    await writeFile(unrelated, "preserve", { flag: "wx" });

    const failure = await archiveCapture(realisticCaptureBundle(), {
      fileSystem,
      stagingId: "forced-write-failure"
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArchiveCaptureError);
    expect(failure).toMatchObject({
      diagnostic: { stage: "write_payloads", code: "ENOSPC", cleanup: "completed" }
    });
    expect(JSON.stringify(failure)).not.toContain(forbidden);
    expect(String(failure)).not.toContain("authentication-data-sentinel");
    expect(await readFile(unrelated, "utf8")).toBe("preserve");
    expect(await findStagingDirectories(archiveRoot)).toEqual([]);
    await expect(stat(path.join(archiveRoot, "manifests", "captures.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a finalized immutable archive when the append-only manifest update fails", async () => {
    const fileSystem: ArchiveFileSystem = {
      ...realFileSystem,
      appendFile: async () => {
        throw Object.assign(new Error("private manifest failure detail"), { code: "ENOSPC" });
      }
    };

    const failure = await archiveCapture(realisticCaptureBundle(), {
      fileSystem,
      stagingId: "manifest-failure"
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      diagnostic: { stage: "update_manifest", code: "ENOSPC", cleanup: "not_needed" }
    });
    const captureRoots = await findDirectoriesNamed(archiveRoot, /^20260723T183000Z_/);
    expect(captureRoots).toHaveLength(1);
    expect(await relativeFiles(captureRoots[0]!)).toContain("normalized/conversation.json");
    expect(await findStagingDirectories(archiveRoot)).toEqual([]);
  });
});

async function relativeFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await relativeFiles(root, candidate));
    else output.push(path.relative(root, candidate).split(path.sep).join("/"));
  }
  return output.sort();
}

async function findStagingDirectories(root: string): Promise<string[]> {
  return findDirectoriesNamed(root, /^\.staging-/);
}

async function findDirectoriesNamed(root: string, pattern: RegExp): Promise<string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (pattern.test(entry.name)) output.push(candidate);
      else await visit(candidate);
    }
  }
  await visit(root);
  return output;
}
