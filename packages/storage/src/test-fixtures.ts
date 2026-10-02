import { createHash } from "node:crypto";
import { SCHEMA_VERSION, type CanonicalMessage, type CaptureBundle, type PreservedRepresentation } from "@hhs/canonical-schema";

const observedAt = "2026-07-23T18:30:00.000Z";
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function representation(kind: PreservedRepresentation["kind"], value: string, locator: string): PreservedRepresentation {
  return { kind, value, sha256: digest(value), extraction_method: "chatgpt-rendered-dom-v1", evidence_locator: locator };
}

function message(sequence: number, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  const messageId = `message-${String(sequence).padStart(4, "0")}`;
  const locator = `dom:article[data-message-id="${messageId}"]`;
  return {
    message_id: messageId,
    platform_message_id: `platform-${messageId}`,
    sequence,
    role,
    ...(sequence > 0 ? { parent_message_id: `message-${String(sequence - 1).padStart(4, "0")}` } : {}),
    representations: [
      representation("inner_text", text, locator),
      representation("text_content", text, locator),
      representation("sanitized_html", `<p>${text}</p>`, locator),
      representation("canonical_text", text, locator)
    ],
    content_blocks: [{
      block_id: `${messageId}-block-0`,
      type: "paragraph",
      sequence: 0,
      representations: [representation("canonical_text", text, locator)],
      attributes: {},
      platform_metadata: { rendered: true }
    }],
    evidence_locators: [locator],
    observed_at: [observedAt],
    platform_metadata: { rendered_position: sequence }
  };
}

export function realisticCaptureBundle(options: { captureId?: string; messageCount?: number; wordsPerMessage?: number } = {}): CaptureBundle {
  const messageCount = options.messageCount ?? 8;
  const wordsPerMessage = options.wordsPerMessage ?? 24;
  const messages = Array.from({ length: messageCount }, (_, sequence) => {
    const role = sequence % 2 === 0 ? "user" : "assistant";
    const body = Array.from({ length: wordsPerMessage }, (_unused, word) => `${role}-${sequence}-word-${word}`).join(" ");
    return message(sequence, role, `${role === "user" ? "Request" : "Response"} ${sequence}: ${body}`);
  });
  const screenshotBytes = Buffer.from("synthetic-png-fixture-without-private-content", "utf8");
  const sanitizedDom = "<main><article data-message-id=\"message-0000\">Sanitized fixture boundary</article></main>";
  return {
    schema_version: SCHEMA_VERSION,
    capture: {
      capture_id: options.captureId ?? "capture-behavior-00000001",
      started_at: "2026-07-23T18:30:00.000Z",
      completed_at: "2026-07-23T18:31:00.000Z",
      source_url: "https://chatgpt.com/c/fixture-conversation",
      adapter_version: "chatgpt-0.1.0",
      status: "complete"
    },
    platform: { id: "chatgpt", observed_host: "chatgpt.com" },
    account: { opaque_account_reference: "account-opaque-behavior-fixture" },
    conversation: {
      conversation_id: "fixture-conversation-0001",
      platform_conversation_id: "fixture-conversation-0001",
      title: "Realistic archive behavior fixture",
      source_url: "https://chatgpt.com/c/fixture-conversation",
      platform_metadata: { project_context: false }
    },
    messages,
    branches: [{
      branch_id: "branch-main",
      alternative_message_ids: [],
      captured_alternative_count: 0,
      restored_initial_state: true,
      navigation_log: [],
      status: "captured"
    }],
    attachments: [],
    citations: [{ message_id: "message-0001", href: "https://example.invalid/reference", label: "Fixture citation" }],
    artifacts: [],
    tool_events: [{ event_id: "tool-event-1", type: "render_observed", observed_at: observedAt }],
    evidence: [
      {
        evidence_id: "evidence-sanitized-dom-0001",
        kind: "sanitized_dom",
        portion: "earliest_boundary",
        captured_at: observedAt,
        media_type: "text/html",
        sha256: digest(sanitizedDom),
        inline_data: sanitizedDom,
        metadata: { sanitization: "fixture" }
      },
      {
        evidence_id: "evidence-screenshot-0001",
        kind: "screenshot",
        portion: "latest_boundary",
        captured_at: observedAt,
        media_type: "image/png",
        sha256: digest(screenshotBytes),
        inline_data: `data:image/png;base64,${screenshotBytes.toString("base64")}`,
        metadata: { viewport_width: 1440, viewport_height: 900 }
      }
    ],
    verification: {
      ruleset_version: "0.1.0",
      status: "complete",
      checks: [{
        check_id: "fixture.boundaries",
        status: "pass",
        severity: "info",
        message: "Both rendered conversation boundaries were observed.",
        evidence: ["evidence-sanitized-dom-0001", "evidence-screenshot-0001"]
      }],
      warnings: []
    },
    platform_metadata: {
      earliest_boundary_observed: true,
      latest_boundary_observed: true,
      scroll_passes: 12,
      extraction_observation: "synthetic test fixture"
    }
  };
}

export function realisticLargeCaptureBundle(): CaptureBundle {
  return realisticCaptureBundle({ captureId: "capture-large-behavior-0001", messageCount: 420, wordsPerMessage: 180 });
}
