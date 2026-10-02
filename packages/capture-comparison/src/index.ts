import type { CaptureBundle } from "@hhs/canonical-schema";
import { createImmutableCaptureVersion, sha256, stableJson } from "@hhs/capture-versioning";

export const COMPARISON_RULESET_VERSION = "0.2.0";
export type ChangeClassification = "unchanged" | "appended" | "textual_edit" | "rendered_structure_changed" | "content_blocks_changed" | "attachments_changed" | "citations_changed" | "artifacts_changed" | "tool_events_changed" | "metadata_changed" | "regenerated" | "branched" | "removed_from_active_path" | "uncertain";
export type ChangeDimension = "text" | "rendered_structure" | "content_blocks" | "attachments" | "citations" | "artifacts" | "tool_events" | "metadata" | "branch";
export type MatchMethod = "platform_message_id" | "canonical_message_id" | "exact_hash_context" | "branch_parent" | "none";

export interface MessageChangeRecord {
  record_id: string;
  classification: ChangeClassification;
  prior_message_id?: string;
  current_message_id?: string;
  match_method: MatchMethod;
  confidence: "exact" | "conservative" | "uncertain";
  reason_codes: string[];
  change_dimensions: ChangeDimension[];
  prior_summary_sha256?: string;
  current_summary_sha256?: string;
}

export interface CaptureComparison {
  comparison_id: string;
  ruleset_version: typeof COMPARISON_RULESET_VERSION;
  prior_capture_id: string;
  current_capture_id: string;
  prior_manifest_sha256: string;
  current_manifest_sha256: string;
  status: "complete" | "needs_review";
  records: MessageChangeRecord[];
  change_counts: Record<ChangeClassification, number>;
  dimension_counts: Record<ChangeDimension, number>;
  warnings: string[];
  comparison_sha256: string;
}

export function compareCaptureVersions(prior: CaptureBundle, current: CaptureBundle, priorManifest = "a".repeat(64), currentManifest = "b".repeat(64)): CaptureComparison {
  const priorVersion = createImmutableCaptureVersion(prior, `immutable:${prior.capture.capture_id}`, priorManifest);
  const currentVersion = createImmutableCaptureVersion(current, `immutable:${current.capture.capture_id}`, currentManifest);
  const warnings: string[] = [];
  const eligible = prior.platform.id === current.platform.id && prior.account.opaque_account_reference === current.account.opaque_account_reference && prior.conversation.conversation_id === current.conversation.conversation_id && prior.verification.status === "complete" && current.verification.status === "complete";
  if (!eligible) warnings.push("comparison_inputs_not_both_verified_complete_same_conversation");
  if ([...prior.branches, ...current.branches].some((branch) => branch.status !== "captured")) warnings.push("branch_coverage_incomplete");

  const records: MessageChangeRecord[] = [];
  const priorMessages = priorVersion.messages;
  const currentMessages = currentVersion.messages;
  const priorById = new Map(priorMessages.map((message) => [message.message_id, message]));
  const currentById = new Map(currentMessages.map((message) => [message.message_id, message]));
  const matchedPrior = new Set<string>();
  const matchedCurrent = new Set<string>();

  matchUnique(priorMessages, currentMessages, (message) => message.platform_message_id, "platform_message_id", matchedPrior, matchedCurrent, records);
  matchUnique(priorMessages.filter((message) => !matchedPrior.has(message.message_id)), currentMessages.filter((message) => !matchedCurrent.has(message.message_id)), (message) => message.message_id, "canonical_message_id", matchedPrior, matchedCurrent, records);
  matchUnique(priorMessages.filter((message) => !matchedPrior.has(message.message_id)), currentMessages.filter((message) => !matchedCurrent.has(message.message_id)), fallbackSignature, "exact_hash_context", matchedPrior, matchedCurrent, records);

  const unmatchedPrior = () => priorMessages.filter((message) => !matchedPrior.has(message.message_id));
  const unmatchedCurrent = () => currentMessages.filter((message) => !matchedCurrent.has(message.message_id));
  for (const currentMessage of unmatchedCurrent().filter((message) => message.role === "assistant" && Boolean(message.branch_id))) {
    const candidates = unmatchedPrior().filter((priorMessage) => priorMessage.role === "assistant" && priorMessage.parent_message_id === currentMessage.parent_message_id && Boolean(priorMessage.branch_id));
    if (candidates.length !== 1) continue;
    const priorMessage = candidates[0]!;
    matchedPrior.add(priorMessage.message_id);
    matchedCurrent.add(currentMessage.message_id);
    records.push(record("regenerated", priorMessage, currentMessage, "branch_parent", "conservative", ["assistant_alternative_same_parent_with_branch_evidence"], ["text", "branch"]));
  }

  const priorMaximumSequence = Math.max(-1, ...priorMessages.map((message) => message.sequence));
  const knownCurrentIds = new Set(currentMessages.map((message) => message.message_id));
  const knownPriorIds = new Set(priorMessages.map((message) => message.message_id));
  for (const currentMessage of unmatchedCurrent()) {
    const signatureCandidates = unmatchedPrior().filter((priorMessage) => fallbackSignature(priorMessage) === fallbackSignature(currentMessage));
    if (signatureCandidates.length > 1) {
      records.push(record("uncertain", undefined, currentMessage, "none", "uncertain", ["ambiguous_fallback_candidates"]));
    } else if (currentMessage.branch_id) {
      records.push(record("branched", undefined, currentMessage, "none", "conservative", ["new_message_on_captured_branch"], ["branch"]));
    } else if (eligible && currentMessage.sequence > priorMaximumSequence && (!currentMessage.parent_message_id || knownCurrentIds.has(currentMessage.parent_message_id) || knownPriorIds.has(currentMessage.parent_message_id))) {
      records.push(record("appended", undefined, currentMessage, "none", "conservative", ["new_message_after_prior_active_path_tail"]));
    } else {
      records.push(record("uncertain", undefined, currentMessage, "none", "uncertain", ["unmatched_current_message"]));
    }
    matchedCurrent.add(currentMessage.message_id);
  }

  const removalIsCertain = eligible && warnings.length === 0 && !records.some((item) => item.classification === "uncertain");
  for (const priorMessage of unmatchedPrior()) {
    records.push(record(removalIsCertain ? "removed_from_active_path" : "uncertain", priorMessage, undefined, "none", removalIsCertain ? "conservative" : "uncertain", [removalIsCertain ? "absent_from_new_verified_active_path" : "absence_not_confirmed_due_to_incomplete_evidence"]));
    matchedPrior.add(priorMessage.message_id);
  }

  const priorBranchHashes = new Set(priorVersion.branch_hashes);
  for (const [index, branchHash] of currentVersion.branch_hashes.entries()) {
    if (priorBranchHashes.has(branchHash)) continue;
    const branch = current.branches[index];
    const currentMessage = branch?.alternative_message_ids.map((id) => currentById.get(id)).find(Boolean);
    records.push(record("branched", undefined, currentMessage, "none", "conservative", ["branch_graph_changed"], ["branch"]));
  }

  const sortedRecords = records.sort((a, b) => recordSortKey(a, priorById, currentById) - recordSortKey(b, priorById, currentById) || a.record_id.localeCompare(b.record_id));
  const changeCounts = emptyCounts();
  const dimensionCounts = emptyDimensionCounts();
  for (const item of sortedRecords) changeCounts[item.classification] += 1;
  for (const item of sortedRecords) for (const dimension of item.change_dimensions) dimensionCounts[dimension] += 1;
  const needsReview = warnings.length > 0 || changeCounts.uncertain > 0;
  const comparisonId = sha256(stableJson([COMPARISON_RULESET_VERSION, prior.capture.capture_id, current.capture.capture_id, priorManifest, currentManifest])).slice(0, 32);
  const payload: Omit<CaptureComparison, "comparison_sha256"> = {
    comparison_id: comparisonId,
    ruleset_version: COMPARISON_RULESET_VERSION,
    prior_capture_id: prior.capture.capture_id,
    current_capture_id: current.capture.capture_id,
    prior_manifest_sha256: priorManifest,
    current_manifest_sha256: currentManifest,
    status: needsReview ? "needs_review" as const : "complete" as const,
    records: sortedRecords,
    change_counts: changeCounts,
    dimension_counts: dimensionCounts,
    warnings
  };
  return { ...payload, comparison_sha256: sha256(stableJson(payload)) };
}

function matchUnique(priorMessages: ReturnType<typeof versionMessages>, currentMessages: ReturnType<typeof versionMessages>, keyFor: (message: ReturnType<typeof versionMessages>[number]) => string | undefined, method: MatchMethod, matchedPrior: Set<string>, matchedCurrent: Set<string>, records: MessageChangeRecord[]): void {
  const priorGroups = groupUnique(priorMessages, keyFor);
  const currentGroups = groupUnique(currentMessages, keyFor);
  for (const [key, priorGroup] of priorGroups) {
    const currentGroup = currentGroups.get(key);
    if (priorGroup.length !== 1 || currentGroup?.length !== 1) continue;
    const priorMessage = priorGroup[0]!;
    const currentMessage = currentGroup[0]!;
    matchedPrior.add(priorMessage.message_id);
    matchedCurrent.add(currentMessage.message_id);
    records.push(classifyMatch(priorMessage, currentMessage, method));
  }
}

type VersionMessage = ReturnType<typeof createImmutableCaptureVersion>["messages"][number];
function versionMessages(): VersionMessage[] { return []; }

function groupUnique(messages: VersionMessage[], keyFor: (message: VersionMessage) => string | undefined): Map<string, VersionMessage[]> {
  const groups = new Map<string, VersionMessage[]>();
  for (const message of messages) {
    const key = keyFor(message);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return groups;
}

function classifyMatch(prior: VersionMessage, current: VersionMessage, method: MatchMethod): MessageChangeRecord {
  const reasons: string[] = [];
  const dimensions = new Set<ChangeDimension>();
  if (prior.role !== current.role) { reasons.push("role_changed"); dimensions.add("metadata"); }
  if (prior.sequence !== current.sequence) { reasons.push("sequence_changed"); dimensions.add("metadata"); }
  if (prior.parent_message_id !== current.parent_message_id) { reasons.push("parent_relationship_changed"); dimensions.add("branch"); }
  if (prior.branch_id !== current.branch_id) { reasons.push("branch_relationship_changed"); dimensions.add("branch"); }
  for (const kind of representationKinds(prior, current)) {
    reasons.push(`${kind}_changed`);
    dimensions.add(kind === "sanitized_html" ? "rendered_structure" : "text");
  }
  if (stableJson(prior.content_block_hashes) !== stableJson(current.content_block_hashes)) { reasons.push("content_blocks_changed"); dimensions.add("content_blocks"); }
  if (stableJson(prior.attachment_hashes) !== stableJson(current.attachment_hashes)) { reasons.push("attachments_changed"); dimensions.add("attachments"); }
  if (stableJson(prior.citation_hashes) !== stableJson(current.citation_hashes)) { reasons.push("citations_changed"); dimensions.add("citations"); }
  if (stableJson(prior.artifact_hashes) !== stableJson(current.artifact_hashes)) { reasons.push("artifacts_changed"); dimensions.add("artifacts"); }
  if (stableJson(prior.tool_event_hashes) !== stableJson(current.tool_event_hashes)) { reasons.push("tool_events_changed"); dimensions.add("tool_events"); }
  if (reasons.length === 0) return record("unchanged", prior, current, method, "exact", ["all_preserved_hashes_and_relationships_match"]);
  const orderedDimensions = [...dimensions];
  return record(primaryClassification(dimensions), prior, current, method, "exact", reasons, orderedDimensions);
}

function representationKinds(prior: VersionMessage, current: VersionMessage): string[] {
  const kinds = new Set([...Object.keys(prior.representation_hashes), ...Object.keys(current.representation_hashes)]);
  return [...kinds].sort().filter((kind) => prior.representation_hashes[kind] !== current.representation_hashes[kind]);
}

function primaryClassification(dimensions: Set<ChangeDimension>): ChangeClassification {
  if (dimensions.has("text")) return "textual_edit";
  if (dimensions.has("rendered_structure")) return "rendered_structure_changed";
  if (dimensions.has("content_blocks")) return "content_blocks_changed";
  if (dimensions.has("attachments")) return "attachments_changed";
  if (dimensions.has("citations")) return "citations_changed";
  if (dimensions.has("artifacts")) return "artifacts_changed";
  if (dimensions.has("tool_events")) return "tool_events_changed";
  if (dimensions.has("branch")) return "branched";
  return "metadata_changed";
}

function fallbackSignature(message: VersionMessage): string {
  return stableJson([message.role, message.parent_message_id ?? null, message.branch_id ?? null, message.representation_hashes, Object.values(message.content_block_hashes).sort()]);
}

function record(classification: ChangeClassification, prior: VersionMessage | undefined, current: VersionMessage | undefined, matchMethod: MatchMethod, confidence: MessageChangeRecord["confidence"], reasons: string[], dimensions: ChangeDimension[] = []): MessageChangeRecord {
  const identity = [classification, prior?.message_id ?? null, current?.message_id ?? null, reasons];
  return {
    record_id: sha256(stableJson(identity)).slice(0, 24),
    classification,
    ...(prior ? { prior_message_id: prior.message_id, prior_summary_sha256: prior.summary_sha256 } : {}),
    ...(current ? { current_message_id: current.message_id, current_summary_sha256: current.summary_sha256 } : {}),
    match_method: matchMethod,
    confidence,
    reason_codes: reasons,
    change_dimensions: dimensions
  };
}

function recordSortKey(item: MessageChangeRecord, prior: Map<string, VersionMessage>, current: Map<string, VersionMessage>): number {
  return current.get(item.current_message_id ?? "")?.sequence ?? prior.get(item.prior_message_id ?? "")?.sequence ?? Number.MAX_SAFE_INTEGER;
}

function emptyCounts(): Record<ChangeClassification, number> {
  return { unchanged: 0, appended: 0, textual_edit: 0, rendered_structure_changed: 0, content_blocks_changed: 0, attachments_changed: 0, citations_changed: 0, artifacts_changed: 0, tool_events_changed: 0, metadata_changed: 0, regenerated: 0, branched: 0, removed_from_active_path: 0, uncertain: 0 };
}

function emptyDimensionCounts(): Record<ChangeDimension, number> {
  return { text: 0, rendered_structure: 0, content_blocks: 0, attachments: 0, citations: 0, artifacts: 0, tool_events: 0, metadata: 0, branch: 0 };
}
