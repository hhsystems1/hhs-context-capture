import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

describe("capture bundle JSON Schema", () => {
  it("accepts a minimal exact-rendered capture and rejects an invalid representation hash", async () => {
    const schemaPath = fileURLToPath(new URL("../schemas/capture-bundle.schema.json", import.meta.url));
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const validate = new Ajv2020Module.default({ strict: true }).compile(schema);
    const bundle = fixture();
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    bundle.messages[0].representations[0].sha256 = "not-a-hash";
    expect(validate(bundle)).toBe(false);
  });
});

function fixture(): any {
  const representation = (kind: string) => ({ kind, value: "Exact text", sha256: "a".repeat(64), extraction_method: "fixture", evidence_locator: "fixture:message:1" });
  return {
    schema_version: "0.1.0",
    capture: { capture_id: "capture-1", started_at: "2026-07-16T00:00:00Z", completed_at: "2026-07-16T00:00:01Z", source_url: "https://chatgpt.com/c/test", adapter_version: "0.1.0", status: "complete" },
    platform: { id: "chatgpt", observed_host: "chatgpt.com" },
    account: { opaque_account_reference: "account-test" },
    conversation: { conversation_id: "test", title: "Test", source_url: "https://chatgpt.com/c/test", platform_metadata: {} },
    messages: [{ message_id: "m1", sequence: 0, role: "user", representations: ["inner_text", "text_content", "sanitized_html", "canonical_text"].map(representation), content_blocks: [], evidence_locators: ["fixture:message:1"], observed_at: ["2026-07-16T00:00:00Z"], platform_metadata: {} }],
    branches: [], attachments: [], citations: [], artifacts: [], tool_events: [], evidence: [],
    verification: { ruleset_version: "0.1.0", status: "complete", checks: [], warnings: [] },
    platform_metadata: {}
  };
}
