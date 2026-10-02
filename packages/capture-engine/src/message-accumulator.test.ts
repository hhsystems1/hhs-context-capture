import { describe, expect, it } from "vitest";
import { MessageAccumulator, type MessageObservation } from "./message-accumulator.js";

const observation = (key: string, text: string): MessageObservation => ({
  observation_key: key,
  message_id: key,
  role: key.startsWith("u") ? "user" : "assistant",
  representations: [{ kind: "inner_text", value: text, sha256: "a".repeat(64), extraction_method: "fixture", evidence_locator: key }],
  content_blocks: [],
  evidence_locators: [key],
  observed_at: new Date().toISOString(),
  platform_metadata: {},
});

describe("MessageAccumulator", () => {
  it("retains virtualized messages across overlapping scroll windows", () => {
    const accumulator = new MessageAccumulator();
    accumulator.observe([observation("u1", "one"), observation("a1", "two")]);
    accumulator.observe([observation("a1", "two"), observation("u2", "three")]);
    expect(accumulator.finalize().messages.map((message) => message.message_id)).toEqual(["u1", "a1", "u2"]);
  });

  it("retains representation variants and compacts repeated observation times", () => {
    const accumulator = new MessageAccumulator();
    const first = observation("a1", "two");
    const second = observation("a1", "two");
    second.observed_at = new Date(Date.now() + 1_000).toISOString();
    second.representations[0] = { ...second.representations[0]!, value: "two changed", sha256: "b".repeat(64) };
    accumulator.observe([first]);
    accumulator.observe([second]);
    const result = accumulator.finalize();
    expect(result.messages[0]?.representations).toHaveLength(2);
    expect(result.messages[0]?.observed_at).toHaveLength(2);
    expect(result.messages[0]?.platform_metadata.observation_count).toBe(2);
    expect(result.warnings[0]).toContain("inner_text");
  });
});
