import { describe, expect, it } from "vitest";
import { deterministicMessageRanges } from "./chunking.js";
import type { CapturedMessage } from "./archive.js";

function messages(count: number): CapturedMessage[] {
  return Array.from({ length: count }, (_, sequence) => ({ message_id: `message-${sequence}`, role: sequence % 2 ? "assistant" : "user", sequence, representations: [{ kind: "canonical_text", value: `value-${sequence}`, sha256: String(sequence).padStart(64, "0"), evidence_locator: `fixture:${sequence}` }], content_blocks: [] }));
}

describe("deterministic message-range chunking", () => {
  it("creates stable contiguous five-message ranges", () => {
    const first = deterministicMessageRanges(messages(12));
    const replay = deterministicMessageRanges(messages(12));
    expect(first.map(({ start, end }) => [start, end])).toEqual([[0,4],[5,9],[10,11]]);
    expect(first.map((range) => range.sha256)).toEqual(replay.map((range) => range.sha256));
  });
});
