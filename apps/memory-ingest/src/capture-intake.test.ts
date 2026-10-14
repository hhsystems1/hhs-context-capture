import { describe, it, expect } from "vitest";
import { ensureIngestWorkspace, publishCaptureSourceVersionFromClient, buildIds } from "./ingest.js";
import { sha256 } from "@hhs/memory-schema";
import { validationSummary } from "./reconstruction-diagnostics.js";
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
});
