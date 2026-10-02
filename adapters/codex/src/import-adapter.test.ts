import { describe, expect, it } from "vitest";
import {
  deterministicCaptureId, normalizeCodexSession, parseCodexSession, redactSecrets, sha256Hex,
  type RedactionEvent
} from "./import-adapter.js";

function line(record: Record<string, unknown>): string { return JSON.stringify(record); }

const FIXTURE = [
  line({ timestamp: "2026-08-09T00:00:00.000Z", ordinal: 0, type: "session_meta", payload: { session_id: "0000-test-session", timestamp: "2026-08-09T00:00:00.000Z", cwd: "/tmp/project", originator: "codex-tui", cli_version: "0.147.0" } }),
  line({ timestamp: "2026-08-09T00:00:01.000Z", ordinal: 1, type: "world_state", payload: { full: true, state: { collaboration_mode: { mode: "default", model: "gpt-5-test" } } } }),
  line({ timestamp: "2026-08-09T00:00:02.000Z", ordinal: 2, type: "response_item", payload: { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>internal</skills_instructions>" }] } }),
  line({ timestamp: "2026-08-09T00:00:03.000Z", ordinal: 3, type: "response_item", payload: { type: "message", id: "msg_env", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" }] } }),
  line({ timestamp: "2026-08-09T00:00:04.000Z", ordinal: 4, type: "response_item", payload: { type: "message", id: "msg_user", role: "user", content: [{ type: "input_text", text: "Please audit the repo" }] } }),
  line({ timestamp: "2026-08-09T00:00:05.000Z", ordinal: 5, type: "response_item", payload: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAAcipher" } }),
  line({ timestamp: "2026-08-09T00:00:06.000Z", ordinal: 6, type: "response_item", payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_1", name: "exec", input: "export API_TOKEN=supersecretvalue123 && run" } }),
  line({ timestamp: "2026-08-09T00:00:07.000Z", ordinal: 7, type: "response_item", payload: { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1", output: [{ type: "input_text", text: "connection postgres://user:hunter2pass@127.0.0.1:5432/db ok" }] } }),
  line({ timestamp: "2026-08-09T00:00:08.000Z", ordinal: 8, type: "response_item", payload: { type: "message", id: "msg_asst", role: "assistant", content: [{ type: "output_text", text: "Audit complete." }] } }),
  line({ timestamp: "2026-08-09T00:00:09.000Z", ordinal: 9, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Audit complete." } })
].join("\n") + "\n";

describe("parseCodexSession", () => {
  it("parses records and session metadata", () => {
    const parsed = parseCodexSession(FIXTURE);
    expect(parsed.sessionId).toBe("0000-test-session");
    expect(parsed.totalRecords).toBe(10);
    expect(parsed.model).toBe("gpt-5-test");
    expect(parsed.workspace).toBe("/tmp/project");
    expect(parsed.recordTypeCounts["response_item/message"]).toBe(4);
  });
  it("rejects files without session_meta", () => {
    expect(() => parseCodexSession(line({ type: "event_msg", payload: {} }))).toThrow(/session_meta/);
  });
});

describe("normalizeCodexSession", () => {
  const parsed = parseCodexSession(FIXTURE);
  const normalization = normalizeCodexSession(parsed, "fixture.jsonl");

  it("promotes user, assistant, tool and scaffolding-as-system_visible; excludes developer/reasoning/telemetry", () => {
    const roles = normalization.messages.map((m) => m.role);
    expect(roles).toEqual(["system_visible", "user", "tool", "tool", "assistant"]);
    const reasons = normalization.excluded.map((e) => e.reason);
    expect(reasons).toContain("developer_scaffolding");
    expect(reasons).toContain("encrypted_reasoning_ciphertext");
    expect(normalization.messages.length + normalization.excluded.length).toBe(parsed.totalRecords);
  });

  it("assigns contiguous sequences and line-level provenance", () => {
    normalization.messages.forEach((m, i) => {
      expect(m.sequence).toBe(i);
      expect(m.evidence_locators[0]).toMatch(/^raw\/source\/fixture\.jsonl#L\d+$/);
      expect(Number(m.platform_metadata.source_line)).toBeGreaterThanOrEqual(0);
    });
    const lines = normalization.messages.map((m) => Number(m.platform_metadata.source_line));
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it("redacts secrets in promoted text while recording events", () => {
    const toolCall = normalization.messages[2]!;
    expect(toolCall.representations[0]!.value).toContain("API_TOKEN=[REDACTED:env_secret_assignment]");
    expect(toolCall.representations[0]!.value).not.toContain("supersecretvalue123");
    const toolOutput = normalization.messages[3]!;
    expect(toolOutput.representations[0]!.value).toContain("[REDACTED:db_url_with_password]");
    expect(toolOutput.representations[0]!.value).not.toContain("hunter2pass");
    expect(normalization.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("hashes every representation over the redacted value", () => {
    for (const m of normalization.messages) {
      expect(m.representations[0]!.sha256).toBe(sha256Hex(m.representations[0]!.value));
    }
  });

  it("derives the title from the first real user message", () => {
    expect(normalization.title).toBe("Codex: Please audit the repo");
  });
});

describe("redactSecrets", () => {
  it("redacts key material shapes", () => {
    const sink: RedactionEvent[] = [];
    const input = "sk-abcdefghijklmnopqrstu ghp_ABCDEFGHIJKLMNOPQRSTUV AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz012345"; // gitleaks:allow -- synthetic credential shapes for redaction test
    const output = redactSecrets(input, 0, sink);
    expect(output).not.toMatch(/sk-abcdef|ghp_|AKIA|Bearer abc/);
    expect(sink.length).toBeGreaterThanOrEqual(4);
  });
  it("leaves ordinary text untouched", () => {
    const sink: RedactionEvent[] = [];
    expect(redactSecrets("normal text with TOKEN mention but no assignment", 0, sink)).toContain("TOKEN mention");
    expect(sink).toEqual([]);
  });
});

describe("deterministicCaptureId", () => {
  it("is stable and uuid-shaped", () => {
    const id = deterministicCaptureId(sha256Hex("bytes"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deterministicCaptureId(sha256Hex("bytes"))).toBe(id);
  });
});
