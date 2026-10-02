import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArchiveInspectorRepository, generateArchiveInspection, type CaptureOperationLink, type TopicPlan
} from "./archive-inspector.js";

const temporary: string[] = [];
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Mission Control Archive Inspector V1", () => {
  it("creates a separate private report, preserves source bytes, and exposes every contiguous message", async () => {
    const fixture = await sourceFixture();
    const before = await treeHash(fixture.captureDirectory);
    const result = await generateArchiveInspection({
      archiveRoot: fixture.root,
      operation: fixture.operation,
      topicPlan: fixture.topicPlan,
      generatedAt: "2026-07-27T04:00:00.000Z"
    });
    const after = await treeHash(fixture.captureDirectory);

    expect(after).toBe(before);
    expect(result.reportDirectory).not.toContain(`${path.sep}captures${path.sep}`);
    expect(result.manifest).toMatchObject({
      verdict: "usable_with_review",
      active_path_complete: true,
      branches_complete: false,
      source_message_count: 4,
      source_sequence: { first: 0, last: 3, contiguous: true }
    });

    const repository = new ArchiveInspectorRepository(fixture.root);
    await expect(repository.list()).resolves.toHaveLength(1);
    const overview = await repository.overview(fixture.operation.safe_capture_reference);
    expect(overview.knowledge_layers.proposed_knowledge).toEqual([]);
    expect(overview.knowledge_layers.approved_knowledge).toEqual([]);
    expect(overview.topics[0]?.provenance.source_hashes).toHaveLength(4);
    expect(overview.topics[0]?.statements[0]?.provenance.source_hashes).toHaveLength(3);

    const page = await repository.messages({
      capture_ref: fixture.operation.safe_capture_reference,
      offset: 0,
      limit: 100
    });
    expect(page.messages.map((message) => message.sequence)).toEqual([0, 1, 2, 3]);
    expect(page.messages[0]?.display_text).not.toContain("C:\\Users\\private");
    expect(page.messages[0]?.display_text).toContain("[local path]");
    expect(page.messages[1]?.display_text).not.toContain("https://private.example");
    expect(page.messages[1]?.display_text).not.toContain("http://");
    expect(page.messages[1]?.display_text).not.toContain("https://");
    expect(page.messages[1]?.display_text).toContain("[private URL]");
  });

  it("supports local search, role filters, and exact ranges without serving source paths", async () => {
    const fixture = await sourceFixture();
    await generateArchiveInspection({
      archiveRoot: fixture.root,
      operation: fixture.operation,
      topicPlan: fixture.topicPlan
    });
    const repository = new ArchiveInspectorRepository(fixture.root);
    const result = await repository.messages({
      capture_ref: fixture.operation.safe_capture_reference,
      text: "proposed",
      role: "assistant",
      start_sequence: 1,
      end_sequence: 3,
      limit: 10
    });
    expect(result.total).toBe(1);
    expect(result.messages[0]?.sequence).toBe(3);
  });

  it("fails closed for traversal attempts, duplicate reports, and incomplete topic provenance", async () => {
    const fixture = await sourceFixture();
    const repository = new ArchiveInspectorRepository(fixture.root);
    await expect(repository.overview("../capture-escape")).rejects.toThrow("Invalid safe capture reference");
    await generateArchiveInspection({
      archiveRoot: fixture.root,
      operation: fixture.operation,
      topicPlan: fixture.topicPlan
    });
    await expect(generateArchiveInspection({
      archiveRoot: fixture.root,
      operation: fixture.operation,
      topicPlan: fixture.topicPlan
    })).rejects.toThrow("already exists");
    await expect(generateArchiveInspection({
      archiveRoot: fixture.root,
      operation: { ...fixture.operation, safe_capture_reference: "capture-111111111111111111111111" },
      topicPlan: {
        topics: [{
          title: "Incomplete",
          start_sequence: 0,
          end_sequence: 2,
          statements: [{ text: "Incomplete range.", kind: "user_statement", start_sequence: 0, end_sequence: 2 }]
        }]
      }
    })).rejects.toThrow("cover every active-path message");
  });
});

async function sourceFixture(): Promise<{
  root: string;
  captureDirectory: string;
  operation: CaptureOperationLink;
  topicPlan: TopicPlan;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hhs-archive-inspector-"));
  temporary.push(root);
  const captureDirectory = path.join(root, "captures", "chatgpt", "account-safe", "conversation-safe", "capture-safe");
  await mkdir(path.join(captureDirectory, "normalized"), { recursive: true });
  await mkdir(path.join(captureDirectory, "verification"), { recursive: true });
  await mkdir(path.join(root, "manifests"), { recursive: true });

  const messages = [
    message(0, "user", "Inspect C:\\Users\\private\\secret.txt and keep it private."),
    message(1, "assistant", "I suggest reviewing https://private.example/path first; never display bare http:// or https:// either."),
    message(2, "user", "Approved for a local read-only report."),
    message(3, "assistant", "The review should remain proposed, not approved.")
  ];
  const verification = {
    status: "needs_review",
    checks: [
      { check_id: "boundary.earliest", status: "pass", severity: "material", message: "Earliest boundary reached.", evidence: [] },
      { check_id: "boundary.latest", status: "pass", severity: "material", message: "Latest boundary reached.", evidence: [] },
      { check_id: "scroll.stabilized", status: "pass", severity: "material", message: "Scroll stabilized.", evidence: [] },
      { check_id: "count.stabilized", status: "pass", severity: "material", message: "Count stabilized.", evidence: [] },
      { check_id: "content.not_truncated", status: "pass", severity: "material", message: "No truncation.", evidence: [] },
      { check_id: "branches.complete", status: "fail", severity: "material", message: "Branch incomplete.", evidence: [] }
    ],
    warnings: ["Branch incomplete."]
  };
  const bundle = {
    schema_version: "0.1.0",
    capture: {
      started_at: "2026-07-27T03:00:00.000Z",
      completed_at: "2026-07-27T03:01:00.000Z",
      status: "needs_review"
    },
    platform: { id: "chatgpt" },
    conversation: { title: "Synthetic private inspection" },
    messages,
    branches: [{
      status: "indicated_not_traversed",
      indicated_alternative_count: 2,
      captured_alternative_count: 0,
      initially_active_index: 2,
      restored_initial_state: true
    }],
    attachments: [],
    citations: [],
    artifacts: [],
    tool_events: [],
    evidence: [],
    verification,
    platform_metadata: {
      initial_message_count: 2,
      accumulated_message_count: 4,
      upward_scroll_metrics: [{ pass: 1 }],
      downward_scroll_metrics: [{ pass: 1 }],
      collapsed_messages_expanded: 0
    }
  };
  const normalized = stable(bundle);
  const report = stable({ status: "needs_review", capture_verification: verification });
  const manifest = stable({ schema_version: "0.1.0", capture: bundle.capture, platform: bundle.platform, conversation: bundle.conversation });
  const payloads = new Map([
    ["normalized/conversation.json", normalized],
    ["verification/report.json", report],
    ["capture-manifest.json", manifest]
  ]);
  const hashes = [];
  for (const [relative, value] of payloads) {
    await writeFile(path.join(captureDirectory, ...relative.split("/")), value, { flag: "wx" });
    hashes.push(`${digest(value)}  ${relative}`);
  }
  await writeFile(path.join(captureDirectory, "hashes.sha256"), `${hashes.sort().join("\n")}\n`, { flag: "wx" });
  await writeFile(path.join(root, "manifests", "captures.jsonl"), `${JSON.stringify({
    capture_id: "synthetic-capture",
    archive_path: captureDirectory,
    captured_at: bundle.capture.completed_at,
    manifest_sha256: digest(manifest)
  })}\n`, { flag: "wx" });

  return {
    root,
    captureDirectory,
    operation: {
      safe_capture_reference: "capture-000000000000000000000000",
      status: "needs_review",
      verification_status: "needs_review",
      archive_manifest_sha256: digest(manifest),
      message_count: 4,
      operation_ref: "operation-synthetic"
    },
    topicPlan: {
      topics: [{
        title: "Synthetic review",
        start_sequence: 0,
        end_sequence: 3,
        statements: [
          { text: "The user requires a private inspection.", kind: "requirement", start_sequence: 0, end_sequence: 2 },
          { text: "The assistant suggests keeping results proposed.", kind: "assistant_suggestion", start_sequence: 1, end_sequence: 3 }
        ]
      }]
    }
  };
}

function message(sequence: number, role: "user" | "assistant", value: string): Record<string, unknown> {
  const representation = (kind: string) => ({ kind, value, sha256: digest(value) });
  return {
    message_id: `message-${sequence}`,
    sequence,
    role,
    representations: ["inner_text", "text_content", "sanitized_html", "canonical_text"].map(representation),
    content_blocks: [{
      type: "paragraph",
      representations: ["inner_text", "text_content", "sanitized_html", "canonical_text"].map(representation)
    }],
    platform_metadata: {}
  };
}

async function treeHash(root: string): Promise<string> {
  const hashes = await readFile(path.join(root, "hashes.sha256"));
  return digest(hashes);
}
