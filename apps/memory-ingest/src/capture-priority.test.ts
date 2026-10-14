import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { registerCapturePriority } from "./capture-priority.js";
import type { DiscoveryExchange } from "./understanding-discovery.js";

describe("new-capture scheduling", () => {
  it("preserves old business priorities, appends one verified source and replays unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "capture-priority-"));
    try {
      const file = path.join(root, "priority.json");
      const old = { source_conversation_id: "old", unprocessed_queue_rank: 7, custom: "keep" };
      await writeFile(file, JSON.stringify({ workspace_id: "scope", conversations: [old] }));
      const exchange = { selection: [{ source_conversation_id: "new", source_version_id: "version", title: "Recent", source_family: "browser_capture", content_characters: 600 }] } as DiscoveryExchange;
      await registerCapturePriority(file, "scope", exchange);
      const first = await readFile(file, "utf8");
      expect(JSON.parse(first).conversations).toEqual([old, expect.objectContaining({ source_conversation_id: "new", unprocessed_queue_rank: 8, estimated_input_tokens: 200 })]);
      await registerCapturePriority(file, "scope", exchange);
      expect(await readFile(file, "utf8")).toBe(first);
      await expect(registerCapturePriority(file, "other-scope", exchange)).rejects.toThrow("workspace mismatch");
      expect(await readFile(file, "utf8")).toBe(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
