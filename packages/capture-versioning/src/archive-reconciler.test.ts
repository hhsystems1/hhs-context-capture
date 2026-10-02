import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticCapture, baseMessages } from "../../capture-comparison/test/fixtures/synthetic-captures.js";
import { scanCaptureArchiveReadOnly } from "./archive-reconciler.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("read-only capture archive reconciliation scan", () => {
  it("discovers only hash-verified captures for the expected opaque account", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-reconcile-")); roots.push(root);
    await fixtureArchive(path.join(root, "valid"), syntheticCapture("capture-valid", baseMessages()));
    const wrong = syntheticCapture("capture-wrong", baseMessages()); wrong.account.opaque_account_reference = "different-account";
    await fixtureArchive(path.join(root, "wrong"), wrong);
    const result = await scanCaptureArchiveReadOnly(root, { platform_id: "synthetic-ai", opaque_account_reference: "opaque-account-fixture" });
    expect(result.candidates.map((item) => item.version.capture_id)).toEqual(["capture-valid"]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ reason: "platform_or_opaque_account_mismatch" }));
  });

  it("routes archive hash failures to warnings without modifying files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hhs-reconcile-")); roots.push(root);
    const archive = path.join(root, "corrupt");
    await fixtureArchive(archive, syntheticCapture("capture-corrupt", baseMessages()));
    await writeFile(path.join(archive, "capture-manifest.json"), "tampered");
    const result = await scanCaptureArchiveReadOnly(root, { platform_id: "synthetic-ai", opaque_account_reference: "opaque-account-fixture" });
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]?.reason).toContain("archive_hash_failure");
  });
});

async function fixtureArchive(root: string, bundle: ReturnType<typeof syntheticCapture>): Promise<void> {
  await mkdir(path.join(root, "normalized"), { recursive: true });
  const files = {
    "capture-manifest.json": `${JSON.stringify({ capture: bundle.capture })}\n`,
    "normalized/conversation.json": `${JSON.stringify(bundle)}\n`
  };
  for (const [relative, value] of Object.entries(files)) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, value);
  }
  const hashes = Object.entries(files).map(([relative, value]) => `${createHash("sha256").update(value).digest("hex")}  ${relative}`).join("\n") + "\n";
  await writeFile(path.join(root, "hashes.sha256"), hashes);
}
