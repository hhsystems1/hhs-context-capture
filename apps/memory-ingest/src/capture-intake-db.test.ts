import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type pg from "pg";
import { sha256 } from "@hhs/memory-schema";
import { createPool } from "./db.js";
import { ingestApprovedCapture } from "./ingest.js";
import { prepareDiscoveryExchangeFromClient } from "./understanding-discovery.js";

describe.skipIf(process.env.RUN_CAPTURE_INTAKE_DB_PROOF !== "1")("capture intake database proof (always rolled back)", () => {
  it("ingests verified evidence, publishes discovery input, replays without duplicates and leaves no rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hhs-capture-intake-db-"));
    const workspace = `intake-proof-${randomUUID()}`;
    const pool = createPool("writer");
    const client = await pool.connect();
    let depth = 0;
    const wrapped = { query: async (sql: string, params?: unknown[]) => {
      if (/^begin/.test(sql)) return client.query(`savepoint intake_${++depth}`);
      if (sql === "commit") return client.query(`release savepoint intake_${depth--}`);
      if (sql === "rollback") { const name = `intake_${depth--}`; await client.query(`rollback to savepoint ${name}`); return client.query(`release savepoint ${name}`); }
      return client.query(sql, params);
    }, release() {} };
    const scopedPool = { connect: async () => wrapped } as unknown as pg.Pool;
    const capture = randomUUID();
    const text = "Synthetic proof: preserve an idea and its original author.";
    const representation = { kind: "canonical_text", value: text, sha256: sha256(text), evidence_locator: `hhs-archive://capture/${capture}/message/0` };
    const normalized = { platform: { id: "chatgpt" }, account: { opaque_account_reference: "synthetic-account" },
      capture: { capture_id: capture, started_at: "2026-10-13T00:00:00Z", completed_at: "2026-10-13T00:00:01Z", adapter_version: "synthetic-proof", status: "complete" },
      conversation: { conversation_id: randomUUID(), title: "Synthetic intake proof" },
      messages: [{ message_id: randomUUID(), role: "user", sequence: 0, representations: [representation], content_blocks: [{ block_id: "block-0", type: "paragraph", sequence: 0, representations: [representation] }] }],
      verification: { ruleset_version: "synthetic-proof", status: "complete", checks: [] } };
    try {
      await mkdir(path.join(root, "normalized")); await mkdir(path.join(root, "verification"));
      const files = { "capture-manifest.json": { capture: normalized.capture }, "normalized/conversation.json": normalized, "verification/report.json": { capture_verification: { status: "complete" } } };
      const hashes: string[] = [];
      for (const [name, payload] of Object.entries(files)) { const body = JSON.stringify(payload); await writeFile(path.join(root, name), body); hashes.push(`${sha256(body)}  ${name}`); }
      await writeFile(path.join(root, "hashes.sha256"), hashes.join("\n") + "\n");
      await client.query("begin");
      const options = { archiveRoot: root, capturePath: root, captureId: capture, workspaceId: workspace, pipelineVersion: "intake-proof/0.1.0", pool: scopedPool };
      const first = await ingestApprovedCapture(options);
      expect(first.replay).toBe(false);
      const exchange = await prepareDiscoveryExchangeFromClient(client, workspace, [normalized.conversation.conversation_id]);
      expect(exchange.selection).toHaveLength(1); expect(exchange.evidence[0]!.role).toBe("user"); expect(exchange.evidence[0]!.text).toBe(text);
      expect((await ingestApprovedCapture(options)).replay).toBe(true);
      expect((await client.query("select count(*)::int n from memory_v1.source_versions where workspace_id=$1", [workspace])).rows[0].n).toBe(1);
    } finally {
      await client.query("rollback");
      await client.query("select set_config('memory_v1.workspace_id',$1,false)", [workspace]);
      expect((await client.query("select count(*)::int n from memory_v1.workspaces where workspace_id=$1", [workspace])).rows[0].n).toBe(0);
      client.release(); await pool.end(); await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
