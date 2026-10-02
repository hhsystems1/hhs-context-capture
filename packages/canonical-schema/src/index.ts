export const SCHEMA_VERSION = "0.1.0";

export type PlatformId = "chatgpt" | "gemini" | "claude" | "manus" | "perplexity" | "notebooklm" | (string & {});
export type CaptureStatus = "complete" | "partial" | "failed" | "needs_review";
export type MessageRole = "user" | "assistant" | "tool" | "system_visible" | "unknown";
export type RepresentationKind = "inner_text" | "text_content" | "sanitized_html" | "canonical_text";

export interface PreservedRepresentation {
  kind: RepresentationKind;
  value: string;
  sha256: string;
  extraction_method: string;
  evidence_locator: string;
}

export interface ContentBlock {
  block_id: string;
  type: "text" | "heading" | "paragraph" | "list" | "blockquote" | "code" | "table" | "link" | "image_reference" | "file_reference" | "artifact_reference" | "math" | "unknown";
  sequence: number;
  representations: PreservedRepresentation[];
  attributes: Record<string, unknown>;
  platform_metadata: Record<string, unknown>;
}

export interface CanonicalMessage {
  message_id: string;
  platform_message_id?: string;
  sequence: number;
  role: MessageRole;
  parent_message_id?: string;
  branch_id?: string;
  representations: PreservedRepresentation[];
  content_blocks: ContentBlock[];
  evidence_locators: string[];
  observed_at: string[];
  platform_metadata: Record<string, unknown>;
}

export interface BranchRecord {
  branch_id: string;
  parent_message_id?: string;
  alternative_message_ids: string[];
  indicated_alternative_count?: number;
  captured_alternative_count: number;
  initially_active_index?: number;
  restored_initial_state: boolean;
  navigation_log: Array<{ at: string; action: string; result: string }>;
  status: "captured" | "partial" | "indicated_not_traversed";
}

export interface AttachmentReference {
  attachment_id: string;
  related_message_id: string;
  kind: "uploaded_file" | "generated_file" | "uploaded_image" | "generated_image" | "unknown";
  filename?: string;
  media_type?: string;
  source_reference?: string;
  availability: "referenced" | "accessible" | "downloaded" | "expired" | "blocked";
  evidence_locator: string;
  platform_metadata: Record<string, unknown>;
}

export interface EvidenceRecord {
  evidence_id: string;
  kind: "sanitized_dom" | "screenshot" | "observation_log";
  portion: "initial_viewport" | "earliest_boundary" | "latest_boundary" | "warning" | "branch" | "artifact" | "truncation" | "uncertainty";
  captured_at: string;
  media_type: string;
  sha256: string;
  inline_data: string;
  metadata: Record<string, unknown>;
}

export interface VerificationCheck {
  check_id: string;
  status: "pass" | "fail" | "warning" | "not_observed";
  severity: "info" | "warning" | "material";
  message: string;
  evidence: string[];
}

export interface CaptureBundle {
  schema_version: string;
  capture: {
    capture_id: string;
    started_at: string;
    completed_at: string;
    source_url: string;
    adapter_version: string;
    status: CaptureStatus;
  };
  platform: { id: PlatformId; observed_host: string };
  account: { opaque_account_reference: string };
  conversation: {
    conversation_id: string;
    platform_conversation_id?: string;
    title: string;
    source_url: string;
    platform_metadata: Record<string, unknown>;
  };
  messages: CanonicalMessage[];
  branches: BranchRecord[];
  attachments: AttachmentReference[];
  citations: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  tool_events: Array<Record<string, unknown>>;
  evidence: EvidenceRecord[];
  verification: {
    ruleset_version: string;
    status: CaptureStatus;
    checks: VerificationCheck[];
    warnings: string[];
  };
  platform_metadata: Record<string, unknown>;
}

