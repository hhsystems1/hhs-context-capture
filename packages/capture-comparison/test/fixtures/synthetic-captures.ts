import { createHash } from "node:crypto";
import type { CaptureBundle, CanonicalMessage, PreservedRepresentation } from "@hhs/canonical-schema";

export interface SyntheticMessageSpec {
  id: string;
  role: CanonicalMessage["role"];
  text: string;
  sequence: number;
  platformId?: string | null;
  parent?: string;
  branch?: string;
}

export function syntheticCapture(captureId: string, messages: SyntheticMessageSpec[], options: {
  branches?: CaptureBundle["branches"];
  attachments?: CaptureBundle["attachments"];
  citations?: CaptureBundle["citations"];
  artifacts?: CaptureBundle["artifacts"];
  status?: CaptureBundle["verification"]["status"];
} = {}): CaptureBundle {
  return {
    schema_version: "0.1.0",
    capture: { capture_id: captureId, started_at: "2026-07-18T00:00:00.000Z", completed_at: "2026-07-18T00:00:01.000Z", source_url: "https://synthetic.invalid/c/conversation-1", adapter_version: "fixture", status: options.status ?? "complete" },
    platform: { id: "synthetic-ai", observed_host: "synthetic.invalid" },
    account: { opaque_account_reference: "opaque-account-fixture" },
    conversation: { conversation_id: "conversation-1", platform_conversation_id: "conversation-1", title: "Synthetic", source_url: "https://synthetic.invalid/c/conversation-1", platform_metadata: {} },
    messages: messages.map(message),
    branches: options.branches ?? [],
    attachments: options.attachments ?? [],
    citations: options.citations ?? [],
    artifacts: options.artifacts ?? [],
    tool_events: [],
    evidence: [],
    verification: { ruleset_version: "fixture", status: options.status ?? "complete", checks: [], warnings: [] },
    platform_metadata: { fixture: true }
  };
}

export function baseMessages(): SyntheticMessageSpec[] {
  return [
    { id: "u1", platformId: "platform-u1", role: "user", text: "Question", sequence: 0 },
    { id: "a1", platformId: "platform-a1", role: "assistant", text: "Answer", sequence: 1, parent: "u1" }
  ];
}

function message(spec: SyntheticMessageSpec): CanonicalMessage {
  const representations = ["inner_text", "text_content", "sanitized_html", "canonical_text"].map((kind) => representation(kind as PreservedRepresentation["kind"], kind === "sanitized_html" ? `<p>${spec.text}</p>` : spec.text));
  return {
    message_id: spec.id,
    ...(spec.platformId === null ? {} : { platform_message_id: spec.platformId ?? `platform-${spec.id}` }),
    sequence: spec.sequence,
    role: spec.role,
    ...(spec.parent ? { parent_message_id: spec.parent } : {}),
    ...(spec.branch ? { branch_id: spec.branch } : {}),
    representations,
    content_blocks: [{ block_id: `${spec.id}:block`, type: "paragraph", sequence: 0, representations, attributes: {}, platform_metadata: {} }],
    evidence_locators: [`fixture:${spec.id}`],
    observed_at: ["2026-07-18T00:00:00.000Z"],
    platform_metadata: {}
  };
}

function representation(kind: PreservedRepresentation["kind"], value: string): PreservedRepresentation {
  return { kind, value, sha256: createHash("sha256").update(value).digest("hex"), extraction_method: "fixture", evidence_locator: "fixture" };
}
