import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("ChatGPT long-conversation stabilization", () => {
  it("does not rely on the old fixed 1,000-pass stopping limit", async () => {
    const sourcePath = fileURLToPath(new URL("./adapter.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");

    expect(source).not.toContain("const HARD_MAX_SCROLL_PASSES = 1_000;");
    expect(source).toContain("progressMade");
    expect(source).toContain("scrollHeightUnchanged");
  });
});