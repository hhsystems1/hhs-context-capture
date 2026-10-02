/**
 * Claude Code session ImportAdapter.
 *
 * Parses a Claude Code project session JSONL file (observed format,
 * Claude Code 2.1.x: one JSON record per line) into the existing HHS
 * universal capture bundle shape consumed by memory-ingest.
 *
 * Read-only with respect to the source file: this module never writes.
 *
 * Record types observed:
 *   user                  -> message.content: string (real prompt) OR
 *                            block list (text | tool_result)
 *   assistant             -> message.content blocks: text | thinking | tool_use
 *   system                -> CLI-injected command echoes / events (isMeta)
 *   attachment            -> harness-injected context deltas
 *   mode, permission-mode, ai-title, last-prompt,
 *   file-history-snapshot -> UI/session state (no transcript content)
 *
 * Promotion policy (conservative, mirrors the Codex adapter):
 *   - real user text                  -> promoted (role user)
 *   - injected user-content scaffolding (<system-reminder>, <command-name>,
 *     <local-command-*>) and isMeta user records -> system_visible
 *   - assistant text                  -> promoted (role assistant)
 *   - assistant thinking              -> NOT promoted (private reasoning,
 *     plaintext here unlike Codex ciphertext; preserved in raw only)
 *   - assistant tool_use              -> promoted as role "tool" (call)
 *   - user tool_result                -> promoted as role "tool" (output);
 *     these live in user-role records but are NEVER user speech
 *   - system / attachment / UI state  -> NOT promoted (preserved in raw)
 *
 * All promoted text passes through the shared conservative secret redaction
 * from the Codex adapter (single implementation, no divergence). The raw
 * source file is preserved verbatim in the bundle; redaction applies only to
 * normalized/canonical projections that can be promoted into knowledge.
 */
import {
  redactSecrets, sha256Hex,
  type AdapterMessage, type AdapterRepresentation, type RedactionEvent
} from "../../codex/src/import-adapter.js";

export const CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";
export const CLAUDE_CODE_PLATFORM_ID = "claude-code";

export interface ClaudeCodeRecord {
  line: number; // 0-based line index in the source JSONL (provenance)
  type: string;
  uuid: string | null;
  parentUuid: string | null;
  timestamp: string | null;
  sessionId: string | null;
  isMeta: boolean;
  record: Record<string, unknown>;
}

export interface ClaudeCodeParseResult {
  sessionId: string;
  claudeCodeVersion: string | null;
  model: string | null;
  workspace: string | null;
  gitBranch: string | null;
  firstTimestamp: string;
  lastTimestamp: string;
  totalRecords: number;
  recordTypeCounts: Record<string, number>;
  records: ClaudeCodeRecord[];
}

export interface ClaudeCodeNormalization {
  messages: AdapterMessage[];
  excluded: Array<{ line: number; reason: string; type: string; block_type?: string }>;
  redactions: RedactionEvent[];
  title: string;
}

const SCAFFOLDING_PREFIXES = ["<system-reminder>", "<command-name>", "<local-command-caveat>", "<local-command-stdout>", "<environment_context>", "<user_instructions>"];

export function parseClaudeCodeSession(jsonlText: string): ClaudeCodeParseResult {
  const lines = jsonlText.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Claude Code session file is empty.");
  const records: ClaudeCodeRecord[] = [];
  const recordTypeCounts: Record<string, number> = {};
  lines.forEach((line, index) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; }
    catch (error) { throw new Error(`Claude Code session line ${index} is not valid JSON: ${String(error)}`, { cause: error }); }
    const type = String(parsed.type ?? "unknown");
    recordTypeCounts[type] = (recordTypeCounts[type] ?? 0) + 1;
    records.push({
      line: index,
      type,
      uuid: typeof parsed.uuid === "string" ? parsed.uuid : null,
      parentUuid: typeof parsed.parentUuid === "string" ? parsed.parentUuid : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      isMeta: parsed.isMeta === true,
      record: parsed
    });
  });

  const sessionIds = new Set(records.map((record) => record.sessionId).filter((value): value is string => Boolean(value)));
  if (sessionIds.size === 0) throw new Error("Claude Code session has no sessionId on any record.");
  if (sessionIds.size > 1) throw new Error(`Claude Code session file contains multiple session ids: ${[...sessionIds].join(", ")}`);
  const sessionId = [...sessionIds][0]!;

  const timestamps = records.map((record) => record.timestamp).filter((value): value is string => Boolean(value)).sort();
  if (!timestamps.length) throw new Error("Claude Code session has no timestamped records.");

  const firstAssistant = records.find((record) => record.type === "assistant");
  const assistantMessage = (firstAssistant?.record.message ?? {}) as Record<string, unknown>;
  const anyTranscript = records.find((record) => record.type === "user" || record.type === "assistant");

  return {
    sessionId,
    claudeCodeVersion: typeof anyTranscript?.record.version === "string" ? String(anyTranscript.record.version) : null,
    model: typeof assistantMessage.model === "string" ? assistantMessage.model : null,
    workspace: typeof anyTranscript?.record.cwd === "string" ? String(anyTranscript.record.cwd) : null,
    gitBranch: typeof anyTranscript?.record.gitBranch === "string" ? String(anyTranscript.record.gitBranch) : null,
    firstTimestamp: timestamps[0]!,
    lastTimestamp: timestamps.at(-1)!,
    totalRecords: records.length,
    recordTypeCounts,
    records
  };
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : ""))
      .join("\n");
  }
  return "";
}

export function normalizeClaudeCodeSession(parsed: ClaudeCodeParseResult, sourceFileName: string): ClaudeCodeNormalization {
  const messages: AdapterMessage[] = [];
  const excluded: ClaudeCodeNormalization["excluded"] = [];
  const redactions: RedactionEvent[] = [];
  let title = `Claude Code session ${parsed.sessionId}`;

  const push = (
    record: ClaudeCodeRecord,
    blockIndex: number,
    role: AdapterMessage["role"],
    text: string,
    blockType: string,
    platformMetadata: Record<string, unknown>
  ): void => {
    const sequence = messages.length;
    const redacted = redactSecrets(text, record.line, redactions);
    const locator = `raw/source/${sourceFileName}#L${record.line}`;
    const representation: AdapterRepresentation = {
      kind: "canonical_text",
      value: redacted,
      sha256: sha256Hex(redacted),
      extraction_method: `claude-code-jsonl-import/${CLAUDE_CODE_ADAPTER_VERSION}`,
      evidence_locator: locator
    };
    const messageId = `claudecode-${parsed.sessionId}-l${record.line}-b${blockIndex}`;
    const message: AdapterMessage = {
      message_id: messageId,
      sequence,
      role,
      representations: [representation],
      content_blocks: [{
        block_id: `${messageId}-c0`,
        type: blockType,
        sequence: 0,
        representations: [representation],
        attributes: {},
        platform_metadata: {}
      }],
      evidence_locators: [locator],
      observed_at: [record.timestamp ?? parsed.firstTimestamp],
      platform_metadata: {
        source_line: record.line,
        source_block_index: blockIndex,
        record_type: record.type,
        record_uuid: record.uuid,
        parent_uuid: record.parentUuid,
        ...platformMetadata
      }
    };
    if (record.uuid) message.platform_message_id = blockIndex === 0 ? record.uuid : `${record.uuid}#${blockIndex}`;
    messages.push(message);
  };

  for (const record of parsed.records) {
    if (record.type === "user") {
      const message = (record.record.message ?? {}) as Record<string, unknown>;
      const content = message.content;
      if (typeof content === "string") {
        const scaffolding = record.isMeta || SCAFFOLDING_PREFIXES.some((prefix) => content.trimStart().startsWith(prefix));
        if (scaffolding) { push(record, 0, "system_visible", content, "text", { injected_scaffolding: true }); continue; }
        if (title.startsWith("Claude Code session ")) {
          const firstLine = content.trim().split("\n")[0] ?? "";
          if (firstLine) title = `Claude Code: ${firstLine.slice(0, 120)}`;
        }
        push(record, 0, "user", content, "text", {});
        continue;
      }
      if (Array.isArray(content)) {
        let promotedAny = false;
        content.forEach((rawBlock, blockIndex) => {
          const block = (rawBlock ?? {}) as Record<string, unknown>;
          const type = String(block.type ?? "unknown");
          if (type === "tool_result") {
            push(record, blockIndex, "tool", blockText(block), "text", {
              tool_event: "output", tool_use_id: block.tool_use_id ?? null, is_error: block.is_error ?? null
            });
            promotedAny = true;
            return;
          }
          if (type === "text") {
            const text = blockText(block);
            const scaffolding = record.isMeta || SCAFFOLDING_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix));
            push(record, blockIndex, scaffolding ? "system_visible" : "user", text, "text", scaffolding ? { injected_scaffolding: true } : {});
            promotedAny = true;
            return;
          }
          excluded.push({ line: record.line, reason: `unpromotable_user_block:${type}`, type: record.type, block_type: type });
        });
        if (!promotedAny) excluded.push({ line: record.line, reason: "user_record_without_promotable_blocks", type: record.type });
        continue;
      }
      excluded.push({ line: record.line, reason: "user_record_without_content", type: record.type });
      continue;
    }

    if (record.type === "assistant") {
      const message = (record.record.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      let promotedAny = false;
      content.forEach((rawBlock, blockIndex) => {
        const block = (rawBlock ?? {}) as Record<string, unknown>;
        const type = String(block.type ?? "unknown");
        if (type === "text") {
          push(record, blockIndex, "assistant", blockText(block), "text", { model: message.model ?? null });
          promotedAny = true;
          return;
        }
        if (type === "tool_use") {
          const name = String(block.name ?? "tool");
          const input = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? null);
          push(record, blockIndex, "tool", `tool_call ${name}\n${input}`, "code", {
            tool_event: "call", tool_name: name, tool_use_id: block.id ?? null, model: message.model ?? null
          });
          promotedAny = true;
          return;
        }
        if (type === "thinking") {
          excluded.push({ line: record.line, reason: "private_reasoning", type: record.type, block_type: type });
          return;
        }
        excluded.push({ line: record.line, reason: `unpromotable_assistant_block:${type}`, type: record.type, block_type: type });
      });
      if (!promotedAny && !content.length) excluded.push({ line: record.line, reason: "assistant_record_without_content", type: record.type });
      continue;
    }

    if (record.type === "system") { excluded.push({ line: record.line, reason: "cli_system_event", type: record.type }); continue; }
    if (record.type === "attachment") { excluded.push({ line: record.line, reason: "harness_injected_attachment", type: record.type }); continue; }
    excluded.push({ line: record.line, reason: "session_state_record", type: record.type });
  }

  return { messages, excluded, redactions, title };
}

export function claudeCodeOpaqueAccountReference(username: string): string {
  return `account-claudecode-${sha256Hex(`claude-code|${username}`).slice(0, 16)}`;
}
