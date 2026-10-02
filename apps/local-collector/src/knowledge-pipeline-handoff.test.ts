import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgePipelineHandoffOutbox, knowledgeHandoffIdempotencyKey } from "./knowledge-pipeline-handoff.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "hhs-handoff-"));
  roots.push(value);
  return value;
}

describe("verified capture knowledge pipeline handoff", () => {
  it("writes one durable handoff and replays without duplicate delivery", async () => {
    const archiveRoot = await root();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      handoff_id: "handoff-1", parent_job_id: "parent-1", ingest_job_id: "ingest-1",
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const outbox = new KnowledgePipelineHandoffOutbox({
      archiveRoot, endpoint: "http://core.test/api/v1/knowledge-pipeline/handoffs", serviceToken: "secret",
      workspaceId: "workspace-1", requestedPipeline: "memory-v1", fetchImpl,
    });
    const input = {
      captureId: "capture-1", manifestSha256: "a".repeat(64), archiveReference: path.join(archiveRoot, "captures", "capture-1"),
      verificationStatus: "complete",
    };

    const first = await outbox.enqueue(input);
    const replay = await outbox.enqueue(input);

    expect(first.idempotency_key).toBe(knowledgeHandoffIdempotencyKey({
      capture_id: "capture-1", manifest_sha256: "a".repeat(64), workspace_id: "workspace-1", requested_pipeline: "memory-v1",
    }));
    expect(replay.delivery.status).toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const files = await readdir(path.join(archiveRoot, "operations", "knowledge-pipeline-handoffs"));
    expect(files).toHaveLength(1);
  });

  it("never creates a handoff for partial verification", async () => {
    const archiveRoot = await root();
    const outbox = new KnowledgePipelineHandoffOutbox({ archiveRoot, workspaceId: "workspace-1", requestedPipeline: "memory-v1" });
    await expect(outbox.enqueue({
      captureId: "capture-2", manifestSha256: "b".repeat(64), archiveReference: path.join(archiveRoot, "capture-2"),
      verificationStatus: "partial",
    })).rejects.toThrow("Only complete verified captures");
    await expect(readdir(path.join(archiveRoot, "operations", "knowledge-pipeline-handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an undelivered record when HHS Core is unavailable", async () => {
    const archiveRoot = await root();
    const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
    const outbox = new KnowledgePipelineHandoffOutbox({
      archiveRoot, endpoint: "http://core.test/api/v1/knowledge-pipeline/handoffs", serviceToken: "secret",
      workspaceId: "workspace-1", requestedPipeline: "memory-v1", fetchImpl,
    });
    const record = await outbox.enqueue({
      captureId: "capture-3", manifestSha256: "c".repeat(64), archiveReference: path.join(archiveRoot, "capture-3"),
      verificationStatus: "complete",
    });
    expect(record.delivery.status).toBe("retrying");
    const [file] = await readdir(path.join(archiveRoot, "operations", "knowledge-pipeline-handoffs"));
    const saved = JSON.parse(await readFile(path.join(archiveRoot, "operations", "knowledge-pipeline-handoffs", file!), "utf8"));
    expect(saved.delivery.last_error).toBe("connection refused");
  });
});
