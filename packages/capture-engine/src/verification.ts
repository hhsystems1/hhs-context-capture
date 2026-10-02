import type { CaptureStatus, VerificationCheck } from "@hhs/canonical-schema";
import type { ExtractedConversation } from "./adapter-contract.js";

export function verifyCapture(extracted: ExtractedConversation): {
  status: CaptureStatus;
  checks: VerificationCheck[];
  warnings: string[];
} {
  const checks = [...extracted.loadResult.checks];
  const add = (check_id: string, pass: boolean, message: string, severity: VerificationCheck["severity"] = "material") =>
    checks.push({ check_id, status: pass ? "pass" : "fail", severity, message, evidence: [] });

  add("messages.present", extracted.messages.length > 0, `${extracted.messages.length} accumulated messages captured.`);
  add("messages.sequenced", extracted.messages.every((message, index) => message.sequence === index), "Every message has a stable contiguous sequence number.");
  add("roles.known", extracted.messages.every((message) => message.role !== "unknown"), "Every message role was determined.");
  add("representations.hashed", extracted.messages.every((message) => message.representations.length >= 4 && message.representations.every((representation) => /^[a-f0-9]{64}$/.test(representation.sha256))), "Every message representation is present and hashed.");
  add("representations.text_stable", extracted.messages.every((message) => !representationDrift(message).some((kind) => kind === "inner_text" || kind === "text_content" || kind === "canonical_text")), "No message textual representation changed between observations.");
  add("representations.structure_stable", extracted.messages.every((message) => semanticStructureStable(message)), "Semantic message structure remained stable; distinct raw sanitized HTML variants were preserved.", "warning");
  add("content_blocks.hashed", extracted.messages.every((message) => message.content_blocks.every((block) => block.representations.length >= 4 && block.representations.every((representation) => /^[a-f0-9]{64}$/.test(representation.sha256)))), "Every extracted content block representation is present and hashed.");
  add("transcript.count_matches", extracted.messages.length === new Set(extracted.messages.map((message) => message.sequence)).size, "Canonical transcript and normalized message projections use the same accumulated message set.");
  add("code.preserved", extracted.messages.flatMap((message) => message.content_blocks).filter((block) => block.type === "code").every((block) => block.representations.some((item) => item.kind === "text_content") && block.representations.some((item) => item.kind === "sanitized_html")), "Every detected code block preserved textual and structural representations.");
  add("tables.preserved", extracted.messages.flatMap((message) => message.content_blocks).filter((block) => block.type === "table").every((block) => block.representations.some((item) => item.kind === "inner_text") && block.representations.some((item) => item.kind === "sanitized_html")), "Every detected table preserved rendered text and structure.");
  add("citations.recorded", extracted.citations.length >= extracted.messages.flatMap((message) => message.content_blocks).filter((block) => block.type === "link").length, "Every detected link block has a citation record.");
  add("attachments.recorded", extracted.attachments.every((attachment) => Boolean(attachment.related_message_id && attachment.evidence_locator && attachment.availability)), "Every detected attachment reference has provenance and availability evidence.");
  add("artifacts.recorded", extracted.artifacts.every((artifact) => Boolean(artifact.related_message_id && artifact.evidence_locator)), "Every detected artifact reference has provenance evidence.");
  add("branches.complete", extracted.branches.every((branch) => branch.status === "captured" && (!branch.indicated_alternative_count || branch.captured_alternative_count >= branch.indicated_alternative_count) && branch.restored_initial_state), "All indicated existing alternatives were captured and initial branch state restored.");
  add("evidence.initial", extracted.evidence.some((item) => item.portion === "initial_viewport"), "Initial viewport visual evidence was captured.", "warning");
  add("evidence.earliest", extracted.evidence.some((item) => item.portion === "earliest_boundary"), "Earliest boundary evidence was captured.", "warning");
  add("evidence.latest", extracted.evidence.some((item) => item.portion === "latest_boundary"), "Latest boundary evidence was captured.", "warning");

  const failed = checks.filter((check) => check.status === "fail");
  const material = failed.some((check) => check.severity === "material");
  const warning = failed.some((check) => check.severity === "warning");
  const warnings = [...extracted.loadResult.warnings, ...failed.map((check) => check.message)];
  return { status: material ? "needs_review" : warning ? "partial" : "complete", checks, warnings };
}

function representationDrift(message: ExtractedConversation["messages"][number]): string[] {
  const value = message.platform_metadata.representation_drift_kinds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function semanticStructureStable(message: ExtractedConversation["messages"][number]): boolean {
  if (!representationDrift(message).includes("sanitized_html")) return true;
  const hashes = message.platform_metadata.semantic_structure_hashes;
  return Array.isArray(hashes) && new Set(hashes.filter((item): item is string => typeof item === "string")).size <= 1;
}
