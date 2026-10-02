import { createHash, randomUUID } from "node:crypto";
import {
  mkdir, open, readFile, readdir, rename, rm, stat
} from "node:fs/promises";
import path from "node:path";

export const ARCHIVE_INSPECTOR_SCHEMA = "hhs.mission-control-archive-inspection/1.0.0";
export const ARCHIVE_INSPECTOR_ROOT = ["derived-reports", "mission-control", "archive-inspector-v1"] as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_CAPTURE_REFERENCE = /^capture-[a-f0-9]{24}$/;
const DERIVED_FILES = [
  "inspection-report.md",
  "message-index.json",
  "topic-outline.json",
  "uncertain-regions.json"
] as const;

export type MessageRole = "user" | "assistant" | "tool" | "system_visible" | "unknown";
export type StatementKind =
  | "user_statement"
  | "assistant_suggestion"
  | "pasted_external_material"
  | "decision"
  | "correction"
  | "requirement"
  | "unresolved_question";

export interface TopicPlanStatement {
  text: string;
  kind: StatementKind;
  start_sequence: number;
  end_sequence: number;
}

export interface TopicPlanEntry {
  title: string;
  start_sequence: number;
  end_sequence: number;
  statements: TopicPlanStatement[];
}

export interface TopicPlan {
  topics: TopicPlanEntry[];
}

export interface CaptureOperationLink {
  safe_capture_reference: string;
  status: string;
  verification_status: string | null;
  archive_manifest_sha256: string;
  message_count: number | null;
  operation_ref: string;
}

interface PreservedRepresentation {
  kind: string;
  value: string;
  sha256: string;
}

interface ContentBlock {
  type: string;
  representations: PreservedRepresentation[];
}

interface CanonicalMessage {
  sequence: number;
  role: MessageRole;
  representations: PreservedRepresentation[];
  content_blocks: ContentBlock[];
  platform_metadata: Record<string, unknown>;
}

interface CaptureBundle {
  schema_version: string;
  capture: { started_at: string; completed_at: string; status: string };
  platform: { id: string };
  conversation: { title: string };
  messages: CanonicalMessage[];
  branches: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  tool_events: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  verification: {
    status: string;
    checks: Array<Record<string, unknown>>;
    warnings: string[];
  };
  platform_metadata: Record<string, unknown>;
}

export interface DerivedMessage {
  sequence: number;
  role: MessageRole;
  classification: StatementKind;
  display_text: string;
  excerpt: string;
  block_count: number;
  structured_content: Record<string, number>;
  source_hash: string;
  representation_hashes: Array<{ kind: string; sha256: string }>;
  distinct_representation_variants: number;
}

export interface ProvenanceRange {
  start_sequence: number;
  end_sequence: number;
  range_sha256: string;
  source_hashes: Array<{ sequence: number; sha256: string }>;
}

export interface DerivedTopicStatement extends TopicPlanStatement {
  provenance: ProvenanceRange;
}

export interface DerivedTopic {
  topic_id: string;
  title: string;
  start_sequence: number;
  end_sequence: number;
  provenance: ProvenanceRange;
  statements: DerivedTopicStatement[];
}

export interface InspectionSummary {
  schema_version: string;
  safe_capture_reference: string;
  title: string;
  platform: string;
  capture_started_at: string;
  capture_completed_at: string;
  source_status: string;
  verdict: "usable_with_review";
  verdict_plain_english: string;
  active_path_complete: true;
  branches_complete: false;
  message_count: number;
  role_counts: Record<MessageRole, number>;
  first_message: Pick<DerivedMessage, "sequence" | "role" | "excerpt" | "source_hash">;
  last_message: Pick<DerivedMessage, "sequence" | "role" | "excerpt" | "source_hash">;
  structured_content: Record<string, number>;
  attachments: Record<string, unknown>;
  branch_status: Record<string, unknown>;
  completeness: Record<string, unknown>;
  verification: Record<string, unknown>;
  provenance: Record<string, unknown>;
  knowledge_layers: {
    raw_evidence: string;
    derived_summary: string;
    proposed_knowledge: [];
    approved_knowledge: [];
  };
}

export interface DerivedReportManifest {
  schema_version: string;
  generated_at: string;
  safe_capture_reference: string;
  verdict: "usable_with_review";
  active_path_complete: true;
  branches_complete: false;
  source_manifest_sha256: string;
  source_hash_index_sha256: string;
  source_message_count: number;
  source_sequence: { first: number; last: number; contiguous: boolean };
  operation_ref: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface GenerateInspectionInput {
  archiveRoot: string;
  operation: CaptureOperationLink;
  topicPlan: TopicPlan;
  generatedAt?: string;
}

export interface InspectionOverview {
  safe_capture_reference: string;
  title: string;
  capture_completed_at: string;
  source_status: string;
  verdict: "usable_with_review";
  verdict_plain_english: string;
  active_path_complete: true;
  branches_complete: false;
  message_count: number;
  role_counts: Record<MessageRole, number>;
  first_message: InspectionSummary["first_message"];
  last_message: InspectionSummary["last_message"];
  structured_content: Record<string, number>;
  attachments: Record<string, unknown>;
  branch_status: Record<string, unknown>;
  completeness: Record<string, unknown>;
  verification: Record<string, unknown>;
  provenance: Record<string, unknown>;
  topics: DerivedTopic[];
  uncertain_regions: Array<Record<string, unknown>>;
  knowledge_layers: InspectionSummary["knowledge_layers"];
}

export interface MessageQuery {
  capture_ref: string;
  text?: string;
  role?: MessageRole;
  start_sequence?: number;
  end_sequence?: number;
  offset?: number;
  limit?: number;
}

export class ArchiveInspectorRepository {
  readonly archiveRoot: string;
  readonly derivedRoot: string;

  constructor(archiveRoot: string) {
    this.archiveRoot = path.resolve(archiveRoot);
    this.derivedRoot = containedPath(this.archiveRoot, ...ARCHIVE_INSPECTOR_ROOT);
  }

  async list(): Promise<Array<Record<string, unknown>>> {
    let names: string[];
    try {
      names = await readdir(this.derivedRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const inspections = [];
    for (const name of names.filter((item) => SAFE_CAPTURE_REFERENCE.test(item)).sort()) {
      try {
        const verified = await this.read(name);
        inspections.push({
          safe_capture_reference: name,
          title: verified.summary.title,
          capture_completed_at: verified.summary.capture_completed_at,
          verdict: verified.manifest.verdict,
          active_path_complete: verified.manifest.active_path_complete,
          branches_complete: verified.manifest.branches_complete,
          message_count: verified.manifest.source_message_count
        });
      } catch {
        // Fail closed: corrupt or incomplete private reports are not advertised.
      }
    }
    return inspections;
  }

  async overview(safeCaptureReference: string): Promise<InspectionOverview> {
    const report = await this.read(safeCaptureReference);
    return {
      safe_capture_reference: report.summary.safe_capture_reference,
      title: report.summary.title,
      capture_completed_at: report.summary.capture_completed_at,
      source_status: report.summary.source_status,
      verdict: report.summary.verdict,
      verdict_plain_english: report.summary.verdict_plain_english,
      active_path_complete: report.summary.active_path_complete,
      branches_complete: report.summary.branches_complete,
      message_count: report.summary.message_count,
      role_counts: report.summary.role_counts,
      first_message: report.summary.first_message,
      last_message: report.summary.last_message,
      structured_content: report.summary.structured_content,
      attachments: report.summary.attachments,
      branch_status: report.summary.branch_status,
      completeness: report.summary.completeness,
      verification: report.summary.verification,
      provenance: report.summary.provenance,
      topics: report.topics,
      uncertain_regions: report.uncertain,
      knowledge_layers: report.summary.knowledge_layers
    };
  }

  async messages(query: MessageQuery): Promise<{
    capture_ref: string;
    total: number;
    offset: number;
    limit: number;
    messages: DerivedMessage[];
  }> {
    validateMessageQuery(query);
    const report = await this.read(query.capture_ref);
    const text = query.text?.trim().toLocaleLowerCase().slice(0, 200) ?? "";
    const first = query.start_sequence ?? 0;
    const last = query.end_sequence ?? Number.MAX_SAFE_INTEGER;
    const filtered = report.messages.filter((message) =>
      (!query.role || message.role === query.role)
      && message.sequence >= first
      && message.sequence <= last
      && (!text || message.display_text.toLocaleLowerCase().includes(text))
    );
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return {
      capture_ref: query.capture_ref,
      total: filtered.length,
      offset,
      limit,
      messages: filtered.slice(offset, offset + limit).map((message) => {
        const displayText = privacyProjection(message.display_text);
        return { ...message, display_text: displayText, excerpt: excerpt(displayText) };
      })
    };
  }

  private async read(safeCaptureReference: string): Promise<{
    manifest: DerivedReportManifest;
    summary: InspectionSummary;
    messages: DerivedMessage[];
    topics: DerivedTopic[];
    uncertain: Array<Record<string, unknown>>;
  }> {
    assertSafeCaptureReference(safeCaptureReference);
    const root = containedPath(this.derivedRoot, safeCaptureReference);
    const hashes = await parseHashIndex(await readFile(path.join(root, "hashes.sha256"), "utf8"));
    if (hashes.size !== DERIVED_FILES.length + 1) throw new Error("Derived report hash index is incomplete.");
    for (const [relative, expected] of hashes) {
      const actual = digest(await readFile(containedPath(root, relative)));
      if (actual !== expected) throw new Error("Derived report hash verification failed.");
    }
    const manifest = JSON.parse(await readFile(path.join(root, "derived-report-manifest.json"), "utf8")) as DerivedReportManifest;
    validateDerivedManifest(manifest, safeCaptureReference, hashes);
    const summary = parseInspectionMarkdown(await readFile(path.join(root, "inspection-report.md"), "utf8"));
    const messages = JSON.parse(await readFile(path.join(root, "message-index.json"), "utf8")) as DerivedMessage[];
    const topics = JSON.parse(await readFile(path.join(root, "topic-outline.json"), "utf8")) as DerivedTopic[];
    const uncertain = JSON.parse(await readFile(path.join(root, "uncertain-regions.json"), "utf8")) as Array<Record<string, unknown>>;
    validateLoadedInspection(manifest, summary, messages, topics);
    return { manifest, summary, messages, topics, uncertain };
  }
}

export async function generateArchiveInspection(input: GenerateInspectionInput): Promise<{
  reportDirectory: string;
  manifest: DerivedReportManifest;
}> {
  validateOperation(input.operation);
  const archiveRoot = path.resolve(input.archiveRoot);
  const source = await resolveSourceArchive(archiveRoot, input.operation);
  const sourceBefore = await hashTree(source.directory);
  const bundle = JSON.parse(await readFile(path.join(source.directory, "normalized", "conversation.json"), "utf8")) as CaptureBundle;
  const verificationReport = JSON.parse(await readFile(path.join(source.directory, "verification", "report.json"), "utf8")) as {
    status: string;
    capture_verification: CaptureBundle["verification"];
  };
  validateSourceBundle(bundle, verificationReport, input.operation, source.hashes);
  validateTopicPlan(input.topicPlan, bundle.messages.length);

  const messages = deriveMessages(bundle);
  const topics = deriveTopics(input.topicPlan, messages);
  const summary = deriveSummary(bundle, messages, topics, input.operation, source);
  const uncertain = deriveUncertainRegions(bundle, messages);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const finalDirectory = containedPath(
    archiveRoot, ...ARCHIVE_INSPECTOR_ROOT, input.operation.safe_capture_reference
  );
  const parent = path.dirname(finalDirectory);
  const staging = containedPath(parent, `.staging-${input.operation.safe_capture_reference}-${randomUUID()}`);
  await mkdir(parent, { recursive: true });
  await mkdir(staging, { recursive: false });

  try {
    const payloads = new Map<string, string>([
      ["inspection-report.md", renderInspectionMarkdown(summary, topics, uncertain)],
      ["message-index.json", stableJson(messages)],
      ["topic-outline.json", stableJson(topics)],
      ["uncertain-regions.json", stableJson(uncertain)]
    ]);
    const fileRecords = [];
    for (const [relative, value] of payloads) {
      const bytes = Buffer.from(value, "utf8");
      await writeExclusive(path.join(staging, relative), bytes);
      fileRecords.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }
    const manifest: DerivedReportManifest = {
      schema_version: ARCHIVE_INSPECTOR_SCHEMA,
      generated_at: generatedAt,
      safe_capture_reference: input.operation.safe_capture_reference,
      verdict: "usable_with_review",
      active_path_complete: true,
      branches_complete: false,
      source_manifest_sha256: input.operation.archive_manifest_sha256,
      source_hash_index_sha256: source.hashIndexSha256,
      source_message_count: messages.length,
      source_sequence: {
        first: messages[0]?.sequence ?? -1,
        last: messages.at(-1)?.sequence ?? -1,
        contiguous: messages.every((message, index) => message.sequence === index)
      },
      operation_ref: input.operation.operation_ref,
      files: fileRecords
    };
    const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
    await writeExclusive(path.join(staging, "derived-report-manifest.json"), manifestBytes);
    const hashIndex = [
      ...fileRecords,
      { path: "derived-report-manifest.json", bytes: manifestBytes.length, sha256: digest(manifestBytes) }
    ].sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.sha256}  ${file.path}`).join("\n") + "\n";
    await writeExclusive(path.join(staging, "hashes.sha256"), Buffer.from(hashIndex, "utf8"));
    await verifyStaging(staging);
    try {
      await stat(finalDirectory);
      throw new Error("A derived inspection already exists for this safe capture reference.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, finalDirectory);
    const sourceAfter = await hashTree(source.directory);
    if (sourceBefore !== sourceAfter) throw new Error("Immutable source archive changed during derived report generation.");
    return { reportDirectory: finalDirectory, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function deriveMessages(bundle: CaptureBundle): DerivedMessage[] {
  const attachmentMessages = new Set(bundle.attachments
    .map((attachment) => String(attachment.related_message_id ?? ""))
    .filter(Boolean));
  return bundle.messages.map((message) => {
    const canonical = message.representations.find((item) => item.kind === "canonical_text");
    if (!canonical || !SHA256.test(canonical.sha256) || digest(Buffer.from(canonical.value, "utf8")) !== canonical.sha256) {
      throw new Error("Canonical message representation hash is invalid.");
    }
    const displayText = privacyProjection(canonical.value);
    const structured = countBy(message.content_blocks.map((block) => block.type));
    return {
      sequence: message.sequence,
      role: message.role,
      classification: classifyMessage(message, canonical.value, attachmentMessages),
      display_text: displayText,
      excerpt: excerpt(displayText),
      block_count: message.content_blocks.length,
      structured_content: structured,
      source_hash: canonical.sha256,
      representation_hashes: message.representations.map((item) => ({ kind: item.kind, sha256: item.sha256 })),
      distinct_representation_variants: new Set(message.representations.map((item) => item.sha256)).size
    };
  });
}

function deriveTopics(plan: TopicPlan, messages: DerivedMessage[]): DerivedTopic[] {
  return plan.topics.map((topic, index) => ({
    topic_id: `topic-${String(index + 1).padStart(2, "0")}`,
    title: cleanDerivedText(topic.title, 120),
    start_sequence: topic.start_sequence,
    end_sequence: topic.end_sequence,
    provenance: provenance(messages, topic.start_sequence, topic.end_sequence),
    statements: topic.statements.map((statement) => ({
      ...statement,
      text: cleanDerivedText(statement.text, 500),
      provenance: provenance(messages, statement.start_sequence, statement.end_sequence)
    }))
  }));
}

function deriveSummary(
  bundle: CaptureBundle,
  messages: DerivedMessage[],
  topics: DerivedTopic[],
  operation: CaptureOperationLink,
  source: Awaited<ReturnType<typeof resolveSourceArchive>>
): InspectionSummary {
  const roleCounts = countRoles(messages);
  const blocks = bundle.messages.flatMap((message) => message.content_blocks);
  const blockCounts = countBy(blocks.map((block) => block.type));
  const attachmentKinds = countBy(bundle.attachments.map((attachment) => String(attachment.kind ?? "unknown")));
  const availability = countBy(bundle.attachments.map((attachment) => String(attachment.availability ?? "unknown")));
  const branch = bundle.branches[0] ?? {};
  const checks = Object.fromEntries(bundle.verification.checks.map((check) => [
    String(check.check_id), {
      status: check.status,
      severity: check.severity,
      message: cleanDerivedText(String(check.message ?? ""), 500)
    }
  ]));
  const metrics = bundle.platform_metadata;
  return {
    schema_version: ARCHIVE_INSPECTOR_SCHEMA,
    safe_capture_reference: operation.safe_capture_reference,
    title: cleanDerivedText(bundle.conversation.title, 200),
    platform: bundle.platform.id,
    capture_started_at: bundle.capture.started_at,
    capture_completed_at: bundle.capture.completed_at,
    source_status: bundle.capture.status,
    verdict: "usable_with_review",
    verdict_plain_english: "Usable with review: the accessible active path is complete, but indicated alternative branches were not fully captured.",
    active_path_complete: true,
    branches_complete: false,
    message_count: messages.length,
    role_counts: roleCounts,
    first_message: pickBoundary(messages[0]!),
    last_message: pickBoundary(messages.at(-1)!),
    structured_content: {
      ...blockCounts,
      content_blocks: blocks.length,
      citations: bundle.citations.length,
      attachments: bundle.attachments.length,
      artifacts: bundle.artifacts.length,
      tool_events: bundle.tool_events.length
    },
    attachments: {
      kinds: attachmentKinds,
      availability,
      image_reference_blocks: blockCounts.image_reference ?? 0,
      note: "References are shown without filenames, URLs, local paths, or account identifiers."
    },
    branch_status: {
      status: branch.status ?? "not_observed",
      indicated_alternative_count: Number(branch.indicated_alternative_count ?? 0),
      captured_alternative_count: Number(branch.captured_alternative_count ?? 0),
      initially_active_index: Number(branch.initially_active_index ?? 0),
      restored_initial_state: Boolean(branch.restored_initial_state)
    },
    completeness: {
      earliest_boundary: checks["boundary.earliest"] ?? null,
      latest_boundary: checks["boundary.latest"] ?? null,
      scroll_stabilized: checks["scroll.stabilized"] ?? null,
      count_stabilized: checks["count.stabilized"] ?? null,
      truncation: checks["content.not_truncated"] ?? null,
      initial_message_count: Number(metrics.initial_message_count ?? 0),
      accumulated_message_count: Number(metrics.accumulated_message_count ?? messages.length),
      upward_scroll_passes: Array.isArray(metrics.upward_scroll_metrics) ? metrics.upward_scroll_metrics.length : 0,
      downward_scroll_passes: Array.isArray(metrics.downward_scroll_metrics) ? metrics.downward_scroll_metrics.length : 0,
      collapsed_messages_expanded: Number(metrics.collapsed_messages_expanded ?? 0)
    },
    verification: {
      status: bundle.verification.status,
      pass_count: bundle.verification.checks.filter((check) => check.status === "pass").length,
      fail_count: bundle.verification.checks.filter((check) => check.status === "fail").length,
      warning_count: bundle.verification.warnings.length,
      checks,
      warnings: bundle.verification.warnings.map((warning) => cleanDerivedText(warning, 500))
    },
    provenance: {
      source_manifest_sha256: operation.archive_manifest_sha256,
      source_hash_index_sha256: source.hashIndexSha256,
      operation_ref: operation.operation_ref,
      message_source_hashes_verified: true,
      topic_ranges_verified: topics.every((topic) => topic.provenance.source_hashes.length === topic.end_sequence - topic.start_sequence + 1),
      absolute_paths_exposed: false
    },
    knowledge_layers: {
      raw_evidence: "Immutable source archive; Mission Control shows only a privacy-sanitized, hash-linked projection.",
      derived_summary: "Local inspection artifacts with exact message-range and source-hash provenance.",
      proposed_knowledge: [],
      approved_knowledge: []
    }
  };
}

function deriveUncertainRegions(bundle: CaptureBundle, messages: DerivedMessage[]): Array<Record<string, unknown>> {
  const unstable = bundle.messages.filter((message) => {
    const byKind = new Map<string, Set<string>>();
    for (const representation of message.representations) {
      const hashes = byKind.get(representation.kind) ?? new Set<string>();
      hashes.add(representation.sha256);
      byKind.set(representation.kind, hashes);
    }
    return [...byKind.values()].some((hashes) => hashes.size > 1);
  });
  const uploaded = new Set(bundle.attachments.map((item) => String(item.related_message_id ?? "")));
  const pastedSequences = bundle.messages
    .filter((message) => uploaded.has(String((message as unknown as { message_id?: string }).message_id ?? ""))
      || message.representations.some((item) => /pasted (?:text|markdown)|\b(?:document|file)\b/i.test(item.value.slice(0, 120))))
    .map((message) => message.sequence);
  return [
    {
      region_id: "branches-incomplete",
      severity: "material",
      kind: "branch_completeness",
      description: "An existing alternative was indicated but not traversed. No claim is made about hidden or unavailable branches.",
      provenance: bundle.branches.map((branch) => ({
        status: branch.status,
        indicated_alternative_count: branch.indicated_alternative_count,
        captured_alternative_count: branch.captured_alternative_count
      }))
    },
    {
      region_id: "representation-variants",
      severity: "review",
      kind: "representation_stability",
      description: "Distinct sanitized-HTML variants were retained while canonical text and semantic structure remained stable.",
      message_count: unstable.length,
      sequences: unstable.map((message) => message.sequence),
      source_hashes: unstable.map((message) => ({
        sequence: message.sequence,
        sha256: messages[message.sequence]?.source_hash
      }))
    },
    {
      region_id: "attachment-availability",
      severity: "review",
      kind: "attachment_availability",
      description: "Attachment and image references do not prove that the underlying binary remains downloadable.",
      attachment_count: bundle.attachments.length,
      availability: countBy(bundle.attachments.map((item) => String(item.availability ?? "unknown")))
    },
    {
      region_id: "pasted-material",
      severity: "review",
      kind: "authorship",
      description: "User-role messages can contain pasted external or assistant-produced material; role alone is not proof of authorship or approval.",
      sequences: pastedSequences,
      source_hashes: pastedSequences.map((sequence) => ({ sequence, sha256: messages[sequence]?.source_hash }))
    },
    {
      region_id: "rendered-source-only",
      severity: "limitation",
      kind: "source_format",
      description: "Original source Markdown and inaccessible platform data were not available; preservation covers accessible rendered content."
    }
  ];
}

function renderInspectionMarkdown(
  summary: InspectionSummary,
  topics: DerivedTopic[],
  uncertain: Array<Record<string, unknown>>
): string {
  const lines = [
    "# Mission Control Archive Inspection",
    "",
    `- Safe capture reference: \`${summary.safe_capture_reference}\``,
    `- Title: ${summary.title}`,
    `- Capture completed: ${summary.capture_completed_at}`,
    `- Source status: \`${summary.source_status}\``,
    `- Verdict: \`${summary.verdict}\``,
    `- Active path complete: \`${summary.active_path_complete}\``,
    `- Branches complete: \`${summary.branches_complete}\``,
    `- Messages: ${summary.message_count}`,
    "",
    "## Plain-English verdict",
    "",
    summary.verdict_plain_english,
    "",
    "## Evidence layers",
    "",
    `- Raw Evidence: ${summary.knowledge_layers.raw_evidence}`,
    `- Derived Summary: ${summary.knowledge_layers.derived_summary}`,
    "- Proposed Knowledge: none",
    "- Approved Knowledge: none",
    "",
    "## Boundary messages",
    "",
    `- First: sequence ${summary.first_message.sequence}, ${summary.first_message.role}, \`${summary.first_message.source_hash}\` — ${summary.first_message.excerpt}`,
    `- Last: sequence ${summary.last_message.sequence}, ${summary.last_message.role}, \`${summary.last_message.source_hash}\` — ${summary.last_message.excerpt}`,
    "",
    "## Topic outline",
    ""
  ];
  for (const topic of topics) {
    lines.push(
      `### ${topic.title}`,
      "",
      `Messages ${topic.start_sequence}–${topic.end_sequence}; range SHA-256 \`${topic.provenance.range_sha256}\`.`,
      ""
    );
    for (const statement of topic.statements) {
      lines.push(
        `- **${statement.kind.replaceAll("_", " ")}:** ${statement.text} `
        + `(messages ${statement.start_sequence}–${statement.end_sequence}; \`${statement.provenance.range_sha256}\`)`
      );
    }
    lines.push("");
  }
  lines.push("## Uncertain regions", "");
  for (const region of uncertain) lines.push(`- **${String(region.kind).replaceAll("_", " ")}:** ${region.description}`);
  lines.push("", "## Provenance", "", `Source manifest SHA-256: \`${summary.provenance.source_manifest_sha256}\``, "");
  return appendSummaryPayload(lines.join("\n"), summary);
}

function parseInspectionMarkdown(markdown: string): InspectionSummary {
  const marker = "<!-- hhs-inspection-summary:";
  const start = markdown.lastIndexOf(marker);
  if (start < 0) throw new Error("Inspection report summary payload is missing.");
  const end = markdown.indexOf(" -->", start);
  if (end < 0) throw new Error("Inspection report summary payload is malformed.");
  const encoded = markdown.slice(start + marker.length, end).trim();
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as InspectionSummary;
}

function appendSummaryPayload(markdown: string, summary: InspectionSummary): string {
  const encoded = Buffer.from(JSON.stringify(summary), "utf8").toString("base64url");
  return `${markdown}\n<!-- hhs-inspection-summary: ${encoded} -->\n`;
}

async function resolveSourceArchive(
  archiveRoot: string,
  operation: CaptureOperationLink
): Promise<{ directory: string; hashes: Map<string, string>; hashIndexSha256: string }> {
  const ledgerPath = containedPath(archiveRoot, "manifests", "captures.jsonl");
  const records = (await readFile(ledgerPath, "utf8")).trim().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.manifest_sha256 === operation.archive_manifest_sha256);
  if (records.length !== 1) throw new Error("The operation manifest hash must resolve to exactly one finalized capture.");
  const directory = path.resolve(String(records[0]!.archive_path));
  const capturesRoot = containedPath(archiveRoot, "captures");
  if (!isWithin(capturesRoot, directory)) throw new Error("Resolved source archive is outside the immutable captures boundary.");
  const hashIndexBytes = await readFile(path.join(directory, "hashes.sha256"));
  const hashes = await parseHashIndex(hashIndexBytes.toString("utf8"));
  for (const [relative, expected] of hashes) {
    const actual = digest(await readFile(containedPath(directory, ...relative.split("/"))));
    if (actual !== expected) throw new Error("Immutable source archive hash verification failed.");
  }
  if (hashes.get("capture-manifest.json") !== operation.archive_manifest_sha256) {
    throw new Error("Operation and source manifest identities disagree.");
  }
  return { directory, hashes, hashIndexSha256: digest(hashIndexBytes) };
}

function validateSourceBundle(
  bundle: CaptureBundle,
  report: { status: string; capture_verification: CaptureBundle["verification"] },
  operation: CaptureOperationLink,
  hashes: Map<string, string>
): void {
  if (bundle.messages.length !== operation.message_count) throw new Error("Operation and source message counts disagree.");
  if (bundle.capture.status !== "needs_review" || report.status !== "needs_review") throw new Error("Source capture is not in the approved review state.");
  if (JSON.stringify(report.capture_verification) !== JSON.stringify(bundle.verification)) throw new Error("Source verification projections disagree.");
  if (!hashes.has("normalized/conversation.json") || !hashes.has("verification/report.json")) throw new Error("Required immutable source files are missing.");
  if (!bundle.messages.every((message, index) => message.sequence === index)) throw new Error("Source messages are not contiguous.");
}

function validateTopicPlan(plan: TopicPlan, messageCount: number): void {
  if (!Array.isArray(plan.topics) || plan.topics.length === 0) throw new Error("A topic plan is required.");
  const covered = new Set<number>();
  for (const topic of plan.topics) {
    assertRange(topic.start_sequence, topic.end_sequence, messageCount);
    if (!topic.title.trim() || !Array.isArray(topic.statements) || topic.statements.length === 0) throw new Error("Every topic requires a title and statements.");
    for (let sequence = topic.start_sequence; sequence <= topic.end_sequence; sequence++) covered.add(sequence);
    for (const statement of topic.statements) {
      assertRange(statement.start_sequence, statement.end_sequence, messageCount);
      if (statement.start_sequence < topic.start_sequence || statement.end_sequence > topic.end_sequence) throw new Error("Statement provenance must remain inside its topic.");
      if (!statement.text.trim()) throw new Error("Derived statements cannot be empty.");
    }
  }
  if (covered.size !== messageCount) throw new Error("Topic ranges must cover every active-path message.");
}

function validateLoadedInspection(
  manifest: DerivedReportManifest,
  summary: InspectionSummary,
  messages: DerivedMessage[],
  topics: DerivedTopic[]
): void {
  if (summary.schema_version !== ARCHIVE_INSPECTOR_SCHEMA || summary.safe_capture_reference !== manifest.safe_capture_reference) {
    throw new Error("Derived inspection identity mismatch.");
  }
  if (messages.length !== manifest.source_message_count || !messages.every((message, index) => message.sequence === index)) {
    throw new Error("Derived message index is incomplete or noncontiguous.");
  }
  const covered = new Set(topics.flatMap((topic) =>
    Array.from({ length: topic.end_sequence - topic.start_sequence + 1 }, (_, offset) => topic.start_sequence + offset)
  ));
  if (covered.size !== messages.length) throw new Error("Topic provenance does not cover the complete active path.");
  for (const topic of topics) {
    const expected = provenance(messages, topic.start_sequence, topic.end_sequence);
    if (expected.range_sha256 !== topic.provenance.range_sha256) throw new Error("Topic provenance hash mismatch.");
    for (const statement of topic.statements) {
      const statementExpected = provenance(messages, statement.start_sequence, statement.end_sequence);
      if (statementExpected.range_sha256 !== statement.provenance.range_sha256) throw new Error("Statement provenance hash mismatch.");
    }
  }
}

function validateDerivedManifest(
  manifest: DerivedReportManifest,
  safeCaptureReference: string,
  hashes: Map<string, string>
): void {
  if (manifest.schema_version !== ARCHIVE_INSPECTOR_SCHEMA
    || manifest.safe_capture_reference !== safeCaptureReference
    || manifest.verdict !== "usable_with_review"
    || manifest.active_path_complete !== true
    || manifest.branches_complete !== false
    || !SHA256.test(manifest.source_manifest_sha256)
    || !SHA256.test(manifest.source_hash_index_sha256)) {
    throw new Error("Derived report manifest is invalid.");
  }
  for (const file of manifest.files) {
    if (hashes.get(file.path) !== file.sha256) throw new Error("Derived report manifest file hash mismatch.");
  }
}

function validateOperation(operation: CaptureOperationLink): void {
  assertSafeCaptureReference(operation.safe_capture_reference);
  if (operation.status !== "needs_review" || operation.verification_status !== "needs_review") throw new Error("Operation is not approved for usable-with-review inspection.");
  if (!SHA256.test(operation.archive_manifest_sha256)) throw new Error("Operation archive manifest hash is invalid.");
  if (!Number.isSafeInteger(operation.message_count) || Number(operation.message_count) < 1) throw new Error("Operation message count is invalid.");
}

function validateMessageQuery(query: MessageQuery): void {
  assertSafeCaptureReference(query.capture_ref);
  if (query.text !== undefined && typeof query.text !== "string") throw new Error("Invalid transcript search.");
  if (query.role && !new Set<MessageRole>(["user", "assistant", "tool", "system_visible", "unknown"]).has(query.role)) throw new Error("Invalid transcript role.");
  for (const value of [query.start_sequence, query.end_sequence, query.offset]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid transcript range.");
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new Error("Invalid transcript page size.");
  if (query.start_sequence !== undefined && query.end_sequence !== undefined && query.start_sequence > query.end_sequence) throw new Error("Invalid transcript range.");
}

function provenance(messages: DerivedMessage[], start: number, end: number): ProvenanceRange {
  const selected = messages.slice(start, end + 1);
  const sourceHashes = selected.map((message) => ({ sequence: message.sequence, sha256: message.source_hash }));
  return {
    start_sequence: start,
    end_sequence: end,
    range_sha256: digest(Buffer.from(sourceHashes.map((item) => `${item.sequence}:${item.sha256}`).join("\n"), "utf8")),
    source_hashes: sourceHashes
  };
}

function privacyProjection(value: string): string {
  return value
    .replace(/\b(?:https?|file|postgres(?:ql)?):\/\/[^\s<>"']*/gi, "[private URL]")
    .replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n\s]*/g, "[local path]")
    .replace(/\\\\[A-Za-z0-9.$_-]+\\[^\s<>"']+/g, "[local path]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[private email]")
    .replace(/\b(?:sk|pk|api|token|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[credential]")
    .replace(/((?:pairing|access|api)\s+(?:code|key|token)\s*[:=]?\s*)[A-Za-z0-9_-]{6,}/gi, "$1[credential]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[sensitive token]");
}

function classifyMessage(
  message: CanonicalMessage,
  text: string,
  attachmentMessages: Set<string>
): StatementKind {
  const messageId = String((message as unknown as { message_id?: string }).message_id ?? "");
  if (attachmentMessages.has(messageId) || /pasted (?:text|markdown)|\b(?:document|file)\s*$/i.test(text.trim().slice(0, 160))) {
    return "pasted_external_material";
  }
  if (message.role === "assistant") return "assistant_suggestion";
  if (message.role !== "user") return "user_statement";
  if (/\b(?:approved|agreed|yes for sure|for sure|that is the plan)\b/i.test(text)) return "decision";
  if (/\b(?:must|do not|don't|never|i want|i don't want|needs? to|have to)\b/i.test(text)) return "requirement";
  if (/^\s*(?:no\b|that's not|that is not|why are we|what are we even|i'm not saying)/i.test(text)) return "correction";
  if (/[?]|\b(?:what|how|why|where|when|should|could|can we|is there)\b/i.test(text)) return "unresolved_question";
  return "user_statement";
}

function cleanDerivedText(value: string, limit: number): string {
  return replaceControlCharacters(privacyProjection(value)).replace(/\s+/g, " ").trim().slice(0, limit);
}

function replaceControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function excerpt(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= 220 ? clean : `${clean.slice(0, 217)}…`;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function countRoles(messages: DerivedMessage[]): Record<MessageRole, number> {
  const roles: Record<MessageRole, number> = { user: 0, assistant: 0, tool: 0, system_visible: 0, unknown: 0 };
  for (const message of messages) roles[message.role] += 1;
  return roles;
}

function pickBoundary(message: DerivedMessage): InspectionSummary["first_message"] {
  return {
    sequence: message.sequence,
    role: message.role,
    excerpt: message.excerpt,
    source_hash: message.source_hash
  };
}

function assertRange(start: number, end: number, messageCount: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= messageCount) {
    throw new Error("Topic plan contains an invalid message range.");
  }
}

function assertSafeCaptureReference(value: string): void {
  if (!SAFE_CAPTURE_REFERENCE.test(value)) throw new Error("Invalid safe capture reference.");
}

async function verifyStaging(directory: string): Promise<void> {
  const hashes = await parseHashIndex(await readFile(path.join(directory, "hashes.sha256"), "utf8"));
  for (const [relative, expected] of hashes) {
    if (digest(await readFile(path.join(directory, relative))) !== expected) throw new Error("Derived report staging verification failed.");
  }
}

async function parseHashIndex(value: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const line of value.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9._/-]+)$/.exec(line);
    if (!match?.[1] || !match[2] || result.has(match[2])) throw new Error("Malformed SHA-256 index.");
    result.set(match[2], match[1]);
  }
  return result;
}

async function hashTree(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  files.sort();
  const rows = [];
  for (const relative of files) rows.push(`${relative}:${digest(await readFile(path.join(root, ...relative.split("/"))))}`);
  return digest(Buffer.from(rows.join("\n"), "utf8"));
}

async function writeExclusive(destination: string, value: Buffer): Promise<void> {
  const handle = await open(destination, "wx");
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containedPath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  if (!isWithin(root, resolved)) throw new Error("Private report path escaped its approved boundary.");
  return resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
