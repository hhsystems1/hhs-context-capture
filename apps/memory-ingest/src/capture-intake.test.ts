import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ensureIngestWorkspace, publishCaptureSourceVersionFromClient, buildIds } from "./ingest.js";
import { sha256 } from "@hhs/memory-schema";
import { quarantineDetails, validationSummary } from "./reconstruction-diagnostics.js";
import type { DbClient } from "./db.js";
import type { VerifiedArchive } from "./archive.js";

describe("capture intake trust", () => {
  it("uses an existing active scope without replacing its provisioning definition", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rowCount: 1, rows: [{ status: "active" }] }; } } as unknown as DbClient;
    await ensureIngestWorkspace(client, "existing");
    expect(calls).toHaveLength(1);
    await expect(ensureIngestWorkspace({ query: async () => ({ rowCount: 1, rows: [{ status: "suspended" }] }) } as unknown as DbClient, "existing")).rejects.toThrow("not active");
  });
  it("publishes source-version identity over preserved capture rows and rejects changed evidence on replay", async () => {
    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    const archive = { manifestSha256: "a".repeat(64), normalized: { platform: { id: "chatgpt" }, account: { opaque_account_reference: "synthetic-account" },
      capture: { capture_id: "capture", completed_at: "2026-10-13T00:00:00Z", status: "complete" },
      conversation: { conversation_id: "conversation", title: "Recent" },
      messages: [{ message_id: "source-message", role: "user", sequence: 0, representations: [{ kind: "canonical_text", value: "Recent idea", sha256: sha256("Recent idea") }], content_blocks: [] }], verification: { status: "complete" } } } as unknown as VerifiedArchive;
    const options = { workspaceId: "scope", pipelineVersion: "memory-v1.1", archiveRoot: "/archive", capturePath: "/archive/capture", captureId: "capture" };
    const client = { query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith("insert")) { const columns = sql.match(/\(([^)]+)\)/)![1]!.split(","); inserts.push({ table: sql.split(" ")[2]!, row: Object.fromEntries(columns.map((name, index) => [name, values[index]])) }); }
      return { rowCount: 0, rows: [] };
    } } as unknown as DbClient;
    const id = await publishCaptureSourceVersionFromClient(client, archive, options);
    const version = inserts.find(row => row.table === "memory_v1.source_versions")!.row;
    expect(version).toMatchObject({ source_version_id: id, source_family: "browser_capture", content_sha256: archive.manifestSha256, capture_version_id: buildIds("scope", options.pipelineVersion, archive).capture });
    const replay = { query: async () => ({ rowCount: 1, rows: [{ content_sha256: "b".repeat(64), capture_version_id: version.capture_version_id, source_family: "browser_capture" }] }) } as unknown as DbClient;
    await expect(publishCaptureSourceVersionFromClient(replay, archive, options)).rejects.toThrow("identity collision");
  });
  it("exports useful validation categories without model references or private content", () => {
    const diagnostic = validationSummary([{ problem: "unknown evidence_ref PRIVATE_REFERENCE" }]);
    expect(diagnostic.code).toBe("unknown_evidence_reference");
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_REFERENCE");
    expect(diagnostic.issue_count).toBe(1);
  });
  it.each([
    ["model_output_truncated", "output limit"], ["malformed_model_json", "malformed JSON"],
    ["request_timeout", "timed out"], ["source_deadline", "deadline"]
  ])("reports %s separately without exposing provider output", (failure_code, text) => {
    const [diagnostic] = quarantineDetails("/not-read", "scope", [{source_conversation_id:"source",
      title:"Historical source",failure_code,reason:"PRIVATE provider content"}]);
    expect(diagnostic?.code).toBe(failure_code);expect(diagnostic?.summary).toContain(text);
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  });
  it("resolves only same-operation/workspace/source preserved failure diagnostics", () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"hhs-failure-diag-"));
    try {
      const operation="operation_"+"a".repeat(32),dir=path.join(root,".runtime/reconstruction/oversized-runs/priority-0001-source");
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,"failure-"+operation+".json"),JSON.stringify({workspace:"scope",operation_id:operation,source_conversation_id:"source",failure_code:"model_output_truncated"}));
      const row={source_conversation_id:"source",title:"Source",reason:"Error: node exited with status 1"};
      expect(quarantineDetails(root,"scope",[row],operation)[0]?.code).toBe("model_output_truncated");
      expect(quarantineDetails(root,"other",[row],operation)[0]?.code).toBe("reconstruction_failed");
      expect(quarantineDetails(root,"scope",[row],"operation_"+"b".repeat(32))[0]?.code).toBe("reconstruction_failed");
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("does not present an old standard validation diagnosis as a current linker/runtime failure", () => {
    const [diagnostic] = quarantineDetails('/not-read-for-runtime-failure', 'scope', [{
      source_conversation_id: 'source', title: 'Preserved source', reason: 'Error: node exited with status 1'
    }]);
    expect(diagnostic).toMatchObject({ code: 'reconstruction_failed', issue_count: 0 });
    expect(diagnostic?.summary).not.toContain('citation');
  });
});
