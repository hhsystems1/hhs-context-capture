/**
 * Codex CLI session ImportAdapter.
 *
 * Parses a Codex rollout JSONL session file (observed format: one JSON record
 * per line, each `{ timestamp, ordinal, type, payload }`) into the existing
 * HHS universal capture bundle shape consumed by memory-ingest.
 *
 * Read-only with respect to the source file: this module never writes.
 *
 * Record types observed (codex-tui 0.147.0):
 *   session_meta                     -> session identity / metadata
 *   turn_context, world_state        -> environment metadata (not messages)
 *   event_msg (task_started, task_complete, token_count,
 *              item_completed, thread_settings_applied) -> telemetry
 *   response_item / message          -> roles: developer | user | assistant
 *   response_item / reasoning        -> encrypted_content (opaque ciphertext)
 *   response_item / custom_tool_call -> tool invocation (name + input)
 *   response_item / custom_tool_call_output -> tool output
 *
 * Promotion policy (conservative):
 *   - user + assistant messages     -> promoted (roles user/assistant)
 *   - injected user-role scaffolding (<environment_context>,
 *     <user_instructions>, <skills_instructions>) -> system_visible
 *   - developer messages            -> NOT promoted (scaffolding; preserved in raw)
 *   - encrypted reasoning           -> NOT promoted (ciphertext; preserved in raw)
 *   - custom_tool_call / _output    -> promoted as role "tool"
 *   - telemetry / meta records      -> NOT promoted (preserved in raw)
 *
 * All promoted text passes through conservative secret redaction. The raw
 * source file is preserved verbatim in the bundle; redaction applies only to
 * normalized/canonical projections that can be promoted into knowledge.
 */
import { createHash } from "node:crypto";

export const CODEX_ADAPTER_VERSION = "0.1.0";
export const CODEX_PLATFORM_ID = "codex";

export interface CodexRecord {
  line: number; // 0-based line index in the source JSONL (provenance)
  ordinal: number;
  timestamp: string;
  type: string;
  payloadType: string | null;
  payload: Record<string, unknown>;
}

export interface RedactionEvent { line: number; pattern: string; count: number }

export interface CodexParseResult {
  sessionId: string;
  sessionTimestamp: string;
  originator: string;
  cliVersion: string;
  model: string | null;
  workspace: string | null;
  firstTimestamp: string;
  lastTimestamp: string;
  totalRecords: number;
  recordTypeCounts: Record<string, number>;
  records: CodexRecord[];
}

export interface AdapterRepresentation { kind: "canonical_text"; value: string; sha256: string; extraction_method: string; evidence_locator: string }
export interface AdapterBlock { block_id: string; type: string; sequence: number; representations: AdapterRepresentation[]; attributes: Record<string, unknown>; platform_metadata: Record<string, unknown> }
export interface AdapterMessage {
  message_id: string;
  platform_message_id?: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system_visible";
  representations: AdapterRepresentation[];
  content_blocks: AdapterBlock[];
  evidence_locators: string[];
  observed_at: string[];
  platform_metadata: Record<string, unknown>;
}

export interface CodexNormalization {
  messages: AdapterMessage[];
  excluded: Array<{ line: number; ordinal: number; reason: string; type: string; payloadType: string | null }>;
  redactions: RedactionEvent[];
  title: string;
}

/** Conservative secret patterns. Matches are replaced, never promoted. */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "openai_key", regex: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "github_token", regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "slack_token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "private_key_block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "db_url_with_password", regex: /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'@/]+:[^\s"'@/]+@[^\s"']+/g },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
  { name: "env_secret_assignment", regex: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{8,}["']?/g }
];

export function redactSecrets(value: string, line: number, sink: RedactionEvent[]): string {
  let output = value;
  for (const { name, regex } of SECRET_PATTERNS) {
    let count = 0;
    output = output.replace(regex, (match, group1?: string) => {
      count += 1;
      // Preserve variable name for env assignments so the record stays legible.
      if (name === "env_secret_assignment" && typeof group1 === "string") return `${group1}=[REDACTED:${name}]`;
      return `[REDACTED:${name}]`;
    });
    if (count > 0) sink.push({ line, pattern: name, count });
  }
  return output;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseCodexSession(jsonlText: string): CodexParseResult {
  const lines = jsonlText.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Codex session file is empty.");
  const records: CodexRecord[] = [];
  const recordTypeCounts: Record<string, number> = {};
  lines.forEach((line, index) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; }
    catch (error) { throw new Error(`Codex session line ${index} is not valid JSON: ${String(error)}`, { cause: error }); }
    const type = String(parsed.type ?? "unknown");
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const payloadType = typeof payload.type === "string" ? payload.type : null;
    const key = payloadType ? `${type}/${payloadType}` : type;
    recordTypeCounts[key] = (recordTypeCounts[key] ?? 0) + 1;
    records.push({
      line: index,
      ordinal: Number(parsed.ordinal ?? index),
      timestamp: String(parsed.timestamp ?? ""),
      type,
      payloadType,
      payload
    });
  });

  const meta = records.find((record) => record.type === "session_meta");
  if (!meta) throw new Error("Codex session has no session_meta record.");
  const metaPayload = meta.payload;
  const sessionId = String(metaPayload.session_id ?? metaPayload.id ?? "");
  if (!sessionId) throw new Error("Codex session_meta has no session id.");

  const world = records.find((record) => record.type === "world_state");
  const worldState = (world?.payload?.state ?? {}) as Record<string, unknown>;
  const collaboration = (worldState.collaboration_mode ?? {}) as Record<string, unknown>;

  return {
    sessionId,
    sessionTimestamp: String(metaPayload.timestamp ?? meta.timestamp),
    originator: String(metaPayload.originator ?? "codex"),
    cliVersion: String(metaPayload.cli_version ?? "unknown"),
    model: typeof collaboration.model === "string" ? collaboration.model : null,
    workspace: typeof metaPayload.cwd === "string" ? metaPayload.cwd : null,
    firstTimestamp: records[0]!.timestamp,
    lastTimestamp: records.at(-1)!.timestamp,
    totalRecords: records.length,
    recordTypeCounts,
    records
  };
}

const SCAFFOLDING_PREFIXES = ["<environment_context>", "<user_instructions>", "<skills_instructions>", "<multi_agent_mode>"];

function contentText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : ""))
    .join("\n");
}

function outputText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : ""))
    .join("");
}

export function normalizeCodexSession(parsed: CodexParseResult, sourceFileName: string): CodexNormalization {
  const messages: AdapterMessage[] = [];
  const excluded: CodexNormalization["excluded"] = [];
  const redactions: RedactionEvent[] = [];
  let title = `Codex session ${parsed.sessionId}`;

  const push = (
    record: CodexRecord,
    role: AdapterMessage["role"],
    text: string,
    blockType: string,
    platformMessageId: string | undefined,
    platformMetadata: Record<string, unknown>
  ): void => {
    const sequence = messages.length;
    const redacted = redactSecrets(text, record.line, redactions);
    const locator = `raw/source/${sourceFileName}#L${record.line}`;
    const representation: AdapterRepresentation = {
      kind: "canonical_text",
      value: redacted,
      sha256: sha256Hex(redacted),
      extraction_method: `codex-jsonl-import/${CODEX_ADAPTER_VERSION}`,
      evidence_locator: locator
    };
    const message: AdapterMessage = {
      message_id: `codex-${parsed.sessionId}-r${record.ordinal}`,
      sequence,
      role,
      representations: [representation],
      content_blocks: [{
        block_id: `codex-${parsed.sessionId}-r${record.ordinal}-b0`,
        type: blockType,
        sequence: 0,
        representations: [representation],
        attributes: {},
        platform_metadata: {}
      }],
      evidence_locators: [locator],
      observed_at: [record.timestamp],
      platform_metadata: {
        source_line: record.line,
        source_ordinal: record.ordinal,
        record_type: record.type,
        payload_type: record.payloadType,
        ...platformMetadata
      }
    };
    if (platformMessageId) message.platform_message_id = platformMessageId;
    messages.push(message);
  };

  for (const record of parsed.records) {
    if (record.type === "response_item" && record.payloadType === "message") {
      const role = String(record.payload.role ?? "");
      const text = contentText(record.payload);
      const payloadId = typeof record.payload.id === "string" ? record.payload.id : undefined;
      if (role === "developer") {
        excluded.push({ line: record.line, ordinal: record.ordinal, reason: "developer_scaffolding", type: record.type, payloadType: record.payloadType });
        continue;
      }
      if (role === "user" && SCAFFOLDING_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix))) {
        push(record, "system_visible", text, "text", payloadId, { injected_scaffolding: true });
        continue;
      }
      if (role === "user") {
        if (title.startsWith("Codex session ")) {
          const firstLine = text.trim().split("\n")[0] ?? "";
          if (firstLine) title = `Codex: ${firstLine.slice(0, 120)}`;
        }
        push(record, "user", text, "text", payloadId, {});
        continue;
      }
      if (role === "assistant") {
        push(record, "assistant", text, "text", payloadId, {});
        continue;
      }
      excluded.push({ line: record.line, ordinal: record.ordinal, reason: `unrecognized_message_role:${role}`, type: record.type, payloadType: record.payloadType });
      continue;
    }
    if (record.type === "response_item" && record.payloadType === "custom_tool_call") {
      const name = String(record.payload.name ?? "tool");
      const input = typeof record.payload.input === "string" ? record.payload.input : JSON.stringify(record.payload.input ?? null);
      const payloadId = typeof record.payload.id === "string" ? record.payload.id : undefined;
      push(record, "tool", `tool_call ${name}\n${input}`, "code", payloadId, {
        tool_event: "call", tool_name: name, call_id: record.payload.call_id ?? null
      });
      continue;
    }
    if (record.type === "response_item" && record.payloadType === "custom_tool_call_output") {
      const payloadId = typeof record.payload.id === "string" ? record.payload.id : undefined;
      push(record, "tool", outputText(record.payload), "text", payloadId, {
        tool_event: "output", call_id: record.payload.call_id ?? null
      });
      continue;
    }
    if (record.type === "response_item" && record.payloadType === "reasoning") {
      excluded.push({ line: record.line, ordinal: record.ordinal, reason: "encrypted_reasoning_ciphertext", type: record.type, payloadType: record.payloadType });
      continue;
    }
    excluded.push({ line: record.line, ordinal: record.ordinal, reason: "non_message_record", type: record.type, payloadType: record.payloadType });
  }

  return { messages, excluded, redactions, title };
}

/** Deterministic capture id derived from the exact source bytes (uuid-shaped). */
export function deterministicCaptureId(sourceSha256: string): string {
  const hex = sourceSha256.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function opaqueAccountReference(originator: string, username: string): string {
  return `account-codex-${sha256Hex(`${originator}|${username}`).slice(0, 16)}`;
}
