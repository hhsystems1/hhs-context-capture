import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyProofRoot, writeProofReceipt } from "./proof-receipts.js";

describe("durable Memory V1.1 proof receipts", () => {
  it("writes unique immutable hash-verified receipt directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hhs-proof-receipts-"));
    const input = {
      proofRoot: root, proofKind: "idempotent_replay" as const, workspaceId: "workspace-test",
      ingestionRunId: "run-test", pipelineVersion: "memory-v1.1/test", captureId: "capture-test",
      archiveTreeSha256: "a".repeat(64), assertions: { passed: true }
    };
    const first = await writeProofReceipt(input);
    const second = await writeProofReceipt(input);
    expect(second.directory).not.toBe(first.directory);
    expect(await verifyProofRoot(root)).toMatchObject({ receiptDirectories: 2, verified: 2, failures: [] });
  });

  it("detects receipt mutation independently from the manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hhs-proof-receipts-"));
    const stored = await writeProofReceipt({
      proofRoot: root, proofKind: "database_immutability", workspaceId: "workspace-test",
      ingestionRunId: "run-test", pipelineVersion: "memory-v1.1/test", captureId: "capture-test",
      archiveTreeSha256: "b".repeat(64), assertions: { passed: true }
    });
    const receiptPath = path.join(stored.directory, "receipt.json");
    await writeFile(receiptPath, `${await readFile(receiptPath, "utf8")} `, "utf8");
    const verification = await verifyProofRoot(root);
    expect(verification.verified).toBe(0);
    expect(verification.failures).toHaveLength(1);
  });
});
