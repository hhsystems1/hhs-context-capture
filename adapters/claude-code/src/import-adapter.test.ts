import { describe, expect, it } from "vitest";
import {
  claudeCodeOpaqueAccountReference, normalizeClaudeCodeSession, parseClaudeCodeSession
} from "./import-adapter.js";

function line(record: Record<string, unknown>): string { return JSON.stringify(record); }
const S = "1111-test-session";
const base = { sessionId: S, cwd: "/tmp/project", gitBranch: "main", version: "2.1.221", isSidechain: false, userType: "external" };

const FIXTURE = [
  line({ type: "mode", sessionId: S, mode: "normal" }),
  line({ ...base, type: "system", subtype: "local_command", isMeta: true, uuid: "u-sys", parentUuid: null, timestamp: "2026-08-10T00:00:00.000Z", content: "<command-name>/status</command-name>" }),
  line({ ...base, type: "user", uuid: "u-scaffold", parentUuid: null, timestamp: "2026-08-10T00:00:01.000Z", message: { role: "user", content: "<system-reminder>injected context</system-reminder>" } }),
  line({ ...base, type: "user", uuid: "u-real", parentUuid: "u-scaffold", timestamp: "2026-08-10T00:00:02.000Z", message: { role: "user", content: "Audit the repository please" } }),
  line({ ...base, type: "assistant", uuid: "a-think", parentUuid: "u-real", timestamp: "2026-08-10T00:00:03.000Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "thinking", thinking: "private chain of thought", signature: "sig" }] } }),
  line({ ...base, type: "assistant", uuid: "a-text", parentUuid: "a-think", timestamp: "2026-08-10T00:00:04.000Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Starting the audit now." }] } }),
  line({ ...base, type: "assistant", uuid: "a-tool", parentUuid: "a-text", timestamp: "2026-08-10T00:00:05.000Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "export API_TOKEN=supersecretvalue123 && env" } }] } }),
  line({ ...base, type: "user", uuid: "u-result", parentUuid: "a-tool", timestamp: "2026-08-10T00:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "db postgres://user:hunter2pass@127.0.0.1:5432/db ok" }] } }),
  line({ ...base, type: "attachment", uuid: "u-att", parentUuid: "u-result", timestamp: "2026-08-10T00:00:07.000Z", attachment: { type: "deferred_tools_delta", addedNames: ["X"] } }),
  line({ type: "ai-title", sessionId: S, aiTitle: "Repo audit" }),
  line({ type: "file-history-snapshot", messageId: "m1", snapshot: {}, isSnapshotUpdate: false })
].join("\n") + "\n";

describe("parseClaudeCodeSession", () => {
  const parsed = parseClaudeCodeSession(FIXTURE);
  it("parses records and session metadata", () => {
    expect(parsed.sessionId).toBe(S);
    expect(parsed.totalRecords).toBe(11);
    expect(parsed.model).toBe("claude-sonnet-5");
    expect(parsed.workspace).toBe("/tmp/project");
    expect(parsed.gitBranch).toBe("main");
    expect(parsed.claudeCodeVersion).toBe("2.1.221");
    expect(parsed.firstTimestamp).toBe("2026-08-10T00:00:00.000Z");
    expect(parsed.lastTimestamp).toBe("2026-08-10T00:00:07.000Z");
  });
  it("rejects files with no sessionId or mixed sessions", () => {
    expect(() => parseClaudeCodeSession(line({ type: "mode", mode: "normal" }))).toThrow(/sessionId/);
    expect(() => parseClaudeCodeSession([line({ type: "mode", sessionId: "a" }), line({ type: "mode", sessionId: "b" })].join("\n"))).toThrow(/multiple session ids/);
  });
});

describe("normalizeClaudeCodeSession", () => {
  const parsed = parseClaudeCodeSession(FIXTURE);
  const normalization = normalizeClaudeCodeSession(parsed, "fixture.jsonl");
  const roles = normalization.messages.map((message) => message.role);

  it("promotes user/assistant/tool and scaffolding as system_visible", () => {
    expect(roles).toEqual(["system_visible", "user", "assistant", "tool", "tool"]);
    expect(normalization.title).toBe("Claude Code: Audit the repository please");
  });
  it("never promotes thinking blocks, system events, attachments, or UI state", () => {
    const reasons = normalization.excluded.map((entry) => entry.reason);
    expect(reasons).toContain("private_reasoning");
    expect(reasons).toContain("cli_system_event");
    expect(reasons).toContain("harness_injected_attachment");
    expect(reasons.filter((reason) => reason === "session_state_record").length).toBe(3);
    expect(JSON.stringify(normalization.messages)).not.toContain("private chain of thought");
  });
  it("maps tool_result inside user records to role tool, never user speech", () => {
    const toolOutput = normalization.messages.find((message) => message.platform_metadata.tool_event === "output");
    expect(toolOutput?.role).toBe("tool");
    expect(toolOutput?.platform_metadata.tool_use_id).toBe("toolu_1");
  });
  it("redacts secrets in promoted text while recording redaction events", () => {
    const serialized = JSON.stringify(normalization.messages);
    expect(serialized).not.toContain("supersecretvalue123");
    expect(serialized).not.toContain("hunter2pass");
    expect(serialized).toContain("[REDACTED:");
    expect(normalization.redactions.length).toBeGreaterThanOrEqual(2);
  });
  it("keeps stable identity and line/block provenance on every message", () => {
    for (const message of normalization.messages) {
      expect(message.message_id).toMatch(new RegExp(`^claudecode-${S}-l\\d+-b\\d+$`));
      expect(message.evidence_locators[0]).toMatch(/^raw\/source\/fixture\.jsonl#L\d+$/);
    }
    const ordering = normalization.messages.map((message) => [Number(message.platform_metadata.source_line), Number(message.platform_metadata.source_block_index)]);
    const sorted = [...ordering].sort((a, b) => (a[0]! - b[0]!) || (a[1]! - b[1]!));
    expect(ordering).toEqual(sorted);
    expect(normalization.messages.every((message, index) => message.sequence === index)).toBe(true);
  });
  it("derives a stable opaque account reference", () => {
    expect(claudeCodeOpaqueAccountReference("steph")).toBe(claudeCodeOpaqueAccountReference("steph"));
    expect(claudeCodeOpaqueAccountReference("steph")).toMatch(/^account-claudecode-[0-9a-f]{16}$/);
  });
});
