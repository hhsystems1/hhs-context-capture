/**
 * Claude Code session -> HHS universal capture bundle importer.
 *
 * Usage:
 *   tsx scripts/claude-code-import.ts --source <path-to-session.jsonl> [--dry-run]
 *
 * Reads the Claude Code session file READ-ONLY, produces an immutable capture
 * bundle under HHS_ARCHIVE_ROOT/captures/claude-code/..., verifies it, and
 * appends the archive manifest line. Never modifies the source file. Refuses
 * to overwrite an existing bundle directory. Mirrors scripts/codex-import.ts.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deterministicCaptureId, redactSecrets, sha256Hex, type RedactionEvent } from "../adapters/codex/src/import-adapter.js";
import {
  CLAUDE_CODE_ADAPTER_VERSION, CLAUDE_CODE_PLATFORM_ID, claudeCodeOpaqueAccountReference,
  normalizeClaudeCodeSession, parseClaudeCodeSession
} from "../adapters/claude-code/src/import-adapter.js";

interface Check { check_id: string; status: "pass" | "fail"; severity: "material" | "warning" | "info"; message: string; evidence: string[] }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = arg("source");
if (!sourcePath) throw new Error("--source <claude code session .jsonl> is required.");
const archiveRoot = process.env.HHS_ARCHIVE_ROOT?.trim();
if (!archiveRoot) throw new Error("HHS_ARCHIVE_ROOT is required.");
const dryRun = process.argv.includes("--dry-run");

const resolvedSource = path.resolve(sourcePath);
const sourceStat = await stat(resolvedSource);
if (!sourceStat.isFile()) throw new Error("Source is not a regular file.");
const sourceBytes = await readFile(resolvedSource);
const sourceSha256 = sha256Hex(sourceBytes);
const sourceFileName = path.basename(resolvedSource);

const parsed = parseClaudeCodeSession(sourceBytes.toString("utf8"));
const normalization = normalizeClaudeCodeSession(parsed, sourceFileName);
const captureId = deterministicCaptureId(sourceSha256);
const account = claudeCodeOpaqueAccountReference(os.userInfo().username);
const startedAt = parsed.firstTimestamp;
const completedAt = parsed.lastTimestamp;
const importedAt = new Date().toISOString();

// Conversation identity: stable per Claude Code session so a re-import of a
// grown session file creates a NEW capture version of the SAME conversation.
const conversationId = `claudecode-${parsed.sessionId}`;

const stamp = importedAt.replace(/[-:]/g, "").replace(/\..*$/, "") + "Z";
const bundleDirName = `${stamp}_${captureId.slice(0, 12)}`;
const bundlePath = path.join(archiveRoot, "captures", "claude-code", account, `session-${parsed.sessionId}`, bundleDirName);

// ---------- projections ----------
const redactedTitle = redactSecrets(normalization.title, -1, [] as RedactionEvent[]);
const messages = normalization.messages;

const canonical = {
  schema_version: "0.1.0",
  capture: { capture_id: captureId, started_at: startedAt, completed_at: completedAt, source_url: `file://${resolvedSource}`, adapter_version: CLAUDE_CODE_ADAPTER_VERSION, status: "complete" },
  platform: { id: CLAUDE_CODE_PLATFORM_ID, observed_host: os.hostname() },
  account: { opaque_account_reference: account },
  conversation: {
    conversation_id: conversationId,
    platform_conversation_id: parsed.sessionId,
    title: redactedTitle,
    source_url: `file://${resolvedSource}`,
    platform_metadata: {
      claude_code_session_id: parsed.sessionId, claude_code_version: parsed.claudeCodeVersion,
      model: parsed.model, workspace: parsed.workspace, git_branch: parsed.gitBranch
    }
  },
  messages,
  branches: [],
  attachments: [],
  citations: [],
  artifacts: [],
  tool_events: messages.filter((m) => m.role === "tool").map((m) => ({
    message_id: m.message_id, tool_event: m.platform_metadata.tool_event, tool_name: m.platform_metadata.tool_name ?? null,
    tool_use_id: m.platform_metadata.tool_use_id ?? null, source_line: m.platform_metadata.source_line
  })),
  evidence: [],
  platform_metadata: { source_file: sourceFileName, source_sha256: sourceSha256, total_source_records: parsed.totalRecords, record_type_counts: parsed.recordTypeCounts }
};

const activeBranchText = messages.map((m) => `[${m.role}] ${m.representations[0]!.value}`).join("\n\n----\n\n");

// ---------- verification (computed, not asserted) ----------
const checks: Check[] = [];
const check = (id: string, ok: boolean, message: string, evidence: string[] = []): void => {
  checks.push({ check_id: id, status: ok ? "pass" : "fail", severity: "material", message, evidence });
};

check("source.file_hash", sha256Hex(await readFile(resolvedSource)) === sourceSha256,
  `Source file sha256 recomputed and stable: ${sourceSha256}`, [`file://${resolvedSource}`]);
check("source.records_parsed", parsed.totalRecords === sourceBytes.toString("utf8").split("\n").filter((l) => l.trim()).length,
  `All ${parsed.totalRecords} source records parsed as JSON.`);
{
  // Per-record accounting: every source record either promoted >=1 message,
  // or appears in the exclusion list (a record can contribute to both only
  // when it holds a mix of promotable and unpromotable blocks).
  const promotedLines = new Set(messages.map((m) => Number(m.platform_metadata.source_line)));
  const excludedLines = new Set(normalization.excluded.map((entry) => entry.line));
  const unaccounted = parsed.records.filter((record) => !promotedLines.has(record.line) && !excludedLines.has(record.line));
  check("records.accounting", unaccounted.length === 0,
    `${promotedLines.size} records promoted, ${excludedLines.size} records with exclusions, ${unaccounted.length} unaccounted of ${parsed.totalRecords}.`,
    unaccounted.map((record) => `raw/source/${sourceFileName}#L${record.line}`));
}
check("messages.sequence_contiguous", messages.every((m, i) => m.sequence === i),
  "Message sequence contiguous from zero.");
check("messages.source_order_stable", messages.every((m, i) => {
  if (i === 0) return true;
  const prev = messages[i - 1]!;
  const prevKey = [Number(prev.platform_metadata.source_line), Number(prev.platform_metadata.source_block_index)] as const;
  const currKey = [Number(m.platform_metadata.source_line), Number(m.platform_metadata.source_block_index)] as const;
  return currKey[0] > prevKey[0] || (currKey[0] === prevKey[0] && currKey[1] > prevKey[1]);
}), "Promoted messages preserve strict source line/block order.");
check("messages.provenance_locators", messages.every((m) => {
  const line = Number(m.platform_metadata.source_line);
  return Number.isInteger(line) && line >= 0 && line < parsed.totalRecords && m.evidence_locators[0] === `raw/source/${sourceFileName}#L${line}`;
}), "Every promoted message carries a line-level locator into the raw source copy.");
check("messages.no_private_reasoning", messages.every((m) => m.platform_metadata.record_type !== "assistant" || m.content_blocks.every((b) => b.type !== "thinking")) &&
  normalization.excluded.some((entry) => entry.reason === "private_reasoning") === parsed.records.some((record) => {
    const message = (record.record.message ?? {}) as Record<string, unknown>;
    return record.type === "assistant" && Array.isArray(message.content) && (message.content as Array<Record<string, unknown>>).some((b) => b.type === "thinking");
  }), "Thinking blocks are never promoted; every observed thinking block is in the exclusion list.");
check("representations.hashes", messages.every((m) =>
  m.representations.every((r) => sha256Hex(r.value) === r.sha256) &&
  m.content_blocks.every((b) => b.representations.every((r) => sha256Hex(r.value) === r.sha256))),
  "Every representation sha256 matches its value.");
{
  const residual: number[] = [];
  for (const m of messages) {
    const value = m.representations[0]!.value;
    const sink: RedactionEvent[] = [];
    const rescanned = redactSecrets(value, Number(m.platform_metadata.source_line), sink);
    if (rescanned !== value && !value.includes("[REDACTED:")) residual.push(Number(m.platform_metadata.source_line));
  }
  check("redaction.no_promotable_secrets", residual.length === 0,
    `Promoted text re-scanned for secret patterns; import-time redaction events: ${normalization.redactions.length}; residual live matches: ${residual.length}.`,
    residual.map((line) => `raw/source/${sourceFileName}#L${line}`));
}

const verificationStatus = checks.every((c) => c.status === "pass") ? "complete" : "needs_review";

const normalized = {
  schema_version: "0.1.0",
  capture: { ...canonical.capture, status: verificationStatus },
  platform: canonical.platform,
  account: canonical.account,
  conversation: canonical.conversation,
  messages,
  verification: { ruleset_version: `claude-code-import/${CLAUDE_CODE_ADAPTER_VERSION}`, status: verificationStatus, checks, warnings: [] }
};
canonical.capture.status = verificationStatus;

const manifest = {
  schema_version: "0.1.0",
  capture: { ...canonical.capture, imported_at: importedAt },
  platform: canonical.platform,
  account: canonical.account,
  conversation: {
    conversation_id: conversationId, platform_conversation_id: parsed.sessionId,
    title: redactedTitle, source_url: canonical.conversation.source_url, platform_metadata: canonical.conversation.platform_metadata
  },
  source: {
    kind: "claude_code_session_jsonl", original_path: resolvedSource, file_name: sourceFileName,
    sha256: sourceSha256, size_bytes: sourceBytes.length, record_count: parsed.totalRecords,
    mtime: sourceStat.mtime.toISOString()
  }
};

const importObservations = {
  imported_at: importedAt,
  adapter_version: CLAUDE_CODE_ADAPTER_VERSION,
  source: manifest.source,
  session: {
    session_id: parsed.sessionId, claude_code_version: parsed.claudeCodeVersion, model: parsed.model,
    workspace: parsed.workspace, git_branch: parsed.gitBranch,
    first_record_timestamp: parsed.firstTimestamp, last_record_timestamp: parsed.lastTimestamp
  },
  record_type_counts: parsed.recordTypeCounts,
  promoted_message_count: messages.length,
  promoted_role_counts: messages.reduce<Record<string, number>>((acc, m) => { acc[m.role] = (acc[m.role] ?? 0) + 1; return acc; }, {}),
  excluded_records: normalization.excluded,
  redaction_events: normalization.redactions
};

const report = {
  status: verificationStatus,
  capture_verification: normalized.verification,
  archive_checks: { required_files: ["capture-manifest.json", "raw/source/" + sourceFileName, "raw/import-observations.json", "normalized/conversation.json", "canonical/conversation.json", "canonical/active-branch.txt", "verification/report.json", "hashes.sha256"] }
};

if (dryRun) {
  console.log(JSON.stringify({ dry_run: true, capture_id: captureId, bundle_path: bundlePath, status: verificationStatus, checks, import_observations: importObservations }, null, 2));
  process.exit(verificationStatus === "complete" ? 0 : 1);
}

// ---------- write bundle (refuse overwrite) ----------
let exists = false;
try { await stat(bundlePath); exists = true; } catch { /* expected */ }
if (exists) throw new Error(`Bundle path already exists (immutability): ${bundlePath}`);

await mkdir(path.join(bundlePath, "raw", "source"), { recursive: true });
await mkdir(path.join(bundlePath, "normalized"), { recursive: true });
await mkdir(path.join(bundlePath, "canonical"), { recursive: true });
await mkdir(path.join(bundlePath, "verification"), { recursive: true });

const files: Record<string, Buffer> = {
  ["raw/source/" + sourceFileName]: sourceBytes,
  "raw/import-observations.json": Buffer.from(JSON.stringify(importObservations, null, 2)),
  "normalized/conversation.json": Buffer.from(JSON.stringify(normalized, null, 2)),
  "canonical/conversation.json": Buffer.from(JSON.stringify(canonical, null, 2)),
  "canonical/active-branch.txt": Buffer.from(activeBranchText),
  "capture-manifest.json": Buffer.from(JSON.stringify(manifest, null, 2)),
  "verification/report.json": Buffer.from(JSON.stringify(report, null, 2))
};
for (const [relative, bytes] of Object.entries(files)) await writeFile(path.join(bundlePath, relative), bytes);

// raw copy must byte-match the original source
if (sha256Hex(await readFile(path.join(bundlePath, "raw", "source", sourceFileName))) !== sourceSha256) throw new Error("Raw evidence copy hash mismatch after write.");

const hashLines = Object.entries(files).map(([relative, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${relative}`).sort((a, b) => (a.split("  ")[1]! < b.split("  ")[1]! ? -1 : 1));
await writeFile(path.join(bundlePath, "hashes.sha256"), hashLines.join("\n") + "\n");

const manifestSha = createHash("sha256").update(files["capture-manifest.json"]!).digest("hex");
await appendFile(path.join(archiveRoot, "manifests", "captures.jsonl"), JSON.stringify({ capture_id: captureId, archive_path: bundlePath, captured_at: importedAt, manifest_sha256: manifestSha, platform: CLAUDE_CODE_PLATFORM_ID }) + "\n");

console.log(JSON.stringify({
  capture_id: captureId, bundle_path: bundlePath, status: verificationStatus,
  source_sha256: sourceSha256, manifest_sha256: manifestSha,
  promoted_messages: messages.length, excluded_records: normalization.excluded.length,
  redaction_events: normalization.redactions.length,
  checks: checks.map((c) => ({ check_id: c.check_id, status: c.status }))
}, null, 2));
if (verificationStatus !== "complete") process.exit(1);
