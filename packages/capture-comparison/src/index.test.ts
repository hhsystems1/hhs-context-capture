import { describe, expect, it } from "vitest";
import { compareCaptureVersions } from "./index.js";
import { baseMessages, syntheticCapture } from "../test/fixtures/synthetic-captures.js";

describe("conservative immutable capture comparison", () => {
  it("classifies messages appended after the verified active-path tail", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const current = syntheticCapture("current", [...baseMessages(),
      { id: "u2", role: "user", text: "Follow-up", sequence: 2, parent: "a1" },
      { id: "a2", role: "assistant", text: "Follow-up answer", sequence: 3, parent: "u2" }
    ]);
    const result = compareCaptureVersions(prior, current);
    expect(result.change_counts.appended).toBe(2);
    expect(result.status).toBe("complete");
  });

  it("classifies stable-identity textual edits separately", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const changed = baseMessages();
    changed[1] = { ...changed[1]!, text: "Edited answer" };
    const result = compareCaptureVersions(prior, syntheticCapture("current", changed));
    expect(result.records.find((item) => item.current_message_id === "a1")).toMatchObject({ classification: "textual_edit", change_dimensions: expect.arrayContaining(["text", "rendered_structure", "content_blocks"]), reason_codes: expect.arrayContaining(["canonical_text_changed", "content_blocks_changed"]) });
  });

  it("does not call sanitized rendered-structure drift a textual edit", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const current = syntheticCapture("current", baseMessages());
    const message = current.messages[1]!;
    message.representations = message.representations.map((representation) => representation.kind === "sanitized_html" ? { ...representation, sha256: "d".repeat(64), value: "<div>Answer</div>" } : representation);
    const result = compareCaptureVersions(prior, current);
    expect(result.records.find((item) => item.current_message_id === "a1")).toMatchObject({ classification: "rendered_structure_changed", change_dimensions: ["rendered_structure"], reason_codes: ["sanitized_html_changed"] });
    expect(result.dimension_counts.text).toBe(0);
  });

  it("classifies content-block-only changes separately", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const current = syntheticCapture("current", baseMessages());
    current.messages[1]!.content_blocks[0]!.attributes = { observed: "changed" };
    const record = compareCaptureVersions(prior, current).records.find((item) => item.current_message_id === "a1");
    expect(record).toMatchObject({ classification: "content_blocks_changed", change_dimensions: ["content_blocks"], reason_codes: ["content_blocks_changed"] });
  });

  it("classifies regenerated assistant alternatives only with parent and branch evidence", () => {
    const prior = syntheticCapture("prior", [baseMessages()[0]!, { id: "a-old", role: "assistant", text: "Old", sequence: 1, parent: "u1", branch: "branch-old" }]);
    const current = syntheticCapture("current", [baseMessages()[0]!, { id: "a-new", role: "assistant", text: "New", sequence: 1, parent: "u1", branch: "branch-new" }]);
    const result = compareCaptureVersions(prior, current);
    expect(result.records).toContainEqual(expect.objectContaining({ classification: "regenerated", prior_message_id: "a-old", current_message_id: "a-new" }));
  });

  it("classifies changed branch relationships", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const currentMessages = baseMessages();
    currentMessages[1] = { ...currentMessages[1]!, branch: "branch-1" };
    const result = compareCaptureVersions(prior, syntheticCapture("current", currentMessages, { branches: [{ branch_id: "branch-1", alternative_message_ids: ["a1"], captured_alternative_count: 1, restored_initial_state: true, navigation_log: [], status: "captured" }] }));
    expect(result.change_counts.branched).toBeGreaterThan(0);
  });

  it("classifies content absent from a new verified active path without deleting history", () => {
    const prior = syntheticCapture("prior", [...baseMessages(), { id: "u2", role: "user", text: "Later", sequence: 2, parent: "a1" }]);
    const result = compareCaptureVersions(prior, syntheticCapture("current", baseMessages()));
    expect(result.records).toContainEqual(expect.objectContaining({ classification: "removed_from_active_path", prior_message_id: "u2" }));
  });

  it("detects attachment, citation, and artifact changes on a stable message", () => {
    const prior = syntheticCapture("prior", baseMessages(), {
      attachments: [{ attachment_id: "file", related_message_id: "a1", kind: "generated_file", filename: "old.txt", availability: "referenced", evidence_locator: "fixture", platform_metadata: {} }],
      citations: [{ citation_id: "cite", related_message_id: "a1", href: "https://old.invalid" }],
      artifacts: [{ artifact_id: "artifact", related_message_id: "a1", representation_hash: "a".repeat(64) }]
    });
    const current = syntheticCapture("current", baseMessages(), {
      attachments: [{ attachment_id: "file", related_message_id: "a1", kind: "generated_file", filename: "new.txt", availability: "referenced", evidence_locator: "fixture", platform_metadata: {} }],
      citations: [{ citation_id: "cite", related_message_id: "a1", href: "https://new.invalid" }],
      artifacts: [{ artifact_id: "artifact", related_message_id: "a1", representation_hash: "b".repeat(64) }]
    });
    const record = compareCaptureVersions(prior, current).records.find((item) => item.current_message_id === "a1");
    expect(record).toMatchObject({ classification: "attachments_changed", change_dimensions: expect.arrayContaining(["attachments", "citations", "artifacts"]), reason_codes: expect.arrayContaining(["attachments_changed", "citations_changed", "artifacts_changed"]) });
    expect(compareCaptureVersions(prior, current).dimension_counts).toMatchObject({ attachments: 1, citations: 1, artifacts: 1 });
  });

  it("routes ambiguous fallback matching to needs_review", () => {
    const prior = syntheticCapture("prior", [
      { id: "old-1", platformId: null, role: "assistant", text: "Repeated", sequence: 0 },
      { id: "old-2", platformId: null, role: "assistant", text: "Repeated", sequence: 1 }
    ]);
    const current = syntheticCapture("current", [{ id: "new-1", platformId: null, role: "assistant", text: "Repeated", sequence: 0 }]);
    const result = compareCaptureVersions(prior, current);
    expect(result.status).toBe("needs_review");
    expect(result.records).toContainEqual(expect.objectContaining({ classification: "uncertain", reason_codes: ["ambiguous_fallback_candidates"] }));
    expect(result.records.filter((item) => item.prior_message_id).every((item) => item.classification === "uncertain")).toBe(true);
  });

  it("makes incomplete comparisons needs_review instead of confirming removals", () => {
    const prior = syntheticCapture("prior", baseMessages());
    const current = syntheticCapture("current", [baseMessages()[0]!], { status: "partial" });
    const result = compareCaptureVersions(prior, current);
    expect(result.status).toBe("needs_review");
    expect(result.records.find((item) => item.prior_message_id === "a1")?.classification).toBe("uncertain");
  });
});
