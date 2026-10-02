import { createHash, randomUUID } from "node:crypto";
import type { CaptureBundle, PreservedRepresentation } from "@hhs/canonical-schema";
import { archiveCapture } from "@hhs/storage";

const exactText = "Synthetic archive boundary smoke test. This is not a captured conversation.";
const representation = (kind: PreservedRepresentation["kind"], value: string): PreservedRepresentation => ({
  kind,
  value,
  sha256: createHash("sha256").update(value).digest("hex"),
  extraction_method: "synthetic-smoke-test",
  evidence_locator: "synthetic:message:1",
});
const started = new Date().toISOString();
const bundle: CaptureBundle = {
  schema_version: "0.1.0",
  capture: { capture_id: `smoke-${randomUUID()}`, started_at: started, completed_at: new Date().toISOString(), source_url: "synthetic://archive-smoke-test", adapter_version: "synthetic-0.1.0", status: "needs_review" },
  platform: { id: "synthetic", observed_host: "local-test" },
  account: { opaque_account_reference: "system-smoke-tests" },
  conversation: { conversation_id: "archive-boundary-smoke-test", title: "SYNTHETIC — archive boundary smoke test", source_url: "synthetic://archive-smoke-test", platform_metadata: { synthetic: true } },
  messages: [{ message_id: "synthetic-message-1", sequence: 0, role: "system_visible", representations: [representation("inner_text", exactText), representation("text_content", exactText), representation("sanitized_html", `<p>${exactText}</p>`), representation("canonical_text", exactText)], content_blocks: [], evidence_locators: ["synthetic:message:1"], observed_at: [started], platform_metadata: { synthetic: true } }],
  branches: [], attachments: [], citations: [], artifacts: [], tool_events: [], evidence: [],
  verification: { ruleset_version: "0.1.0", status: "needs_review", checks: [{ check_id: "synthetic.only", status: "warning", severity: "material", message: "Synthetic storage test; not a real conversation acceptance capture.", evidence: [] }], warnings: ["Synthetic storage test only."] },
  platform_metadata: { synthetic: true },
};

const result = await archiveCapture(bundle);
console.log(JSON.stringify({ ...result, captureId: bundle.capture.capture_id, status: bundle.capture.status }, null, 2));

