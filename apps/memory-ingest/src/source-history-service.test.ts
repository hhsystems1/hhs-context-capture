import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { createQueryService, parseClientTokens, parseSourceCollections, type QueryServiceDeps } from "./query-service.js";
import { SourceHistoryNotFound } from "./source-history.js";
const token = "a".repeat(48);
const source = { sourceRef: "stephen-history", workspaceId: "proof-workspace-synthetic", label: "Historical source" };
async function request(url: string, options: { client?: string; origin?: string; method?: string; fail?: string } = {}) {
  const calls: unknown[][] = [];
  const deps: QueryServiceDeps = {
    query: async () => { throw new Error("Must not use approved retrieval"); },
    getKnowledge: async () => { throw new Error("Must not use approved retrieval"); },
    sourceHistory: async (...args) => {
      calls.push(args);
      if (options.fail === "missing") throw new SourceHistoryNotFound();
      if (options.fail) throw new Error("private database path and secret");
      return { view: "conversations", conversations: [], next_cursor: null };
    }
  };
  const server = createQueryService({ workspaceId: "workspace_fixed", port: 54431,
    clients: parseClientTokens(`${options.client ?? "hhs-core"}:${token}`), sourceCollections: [source] }, deps);
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  Object.assign(req, { method: options.method ?? "GET", url, headers: { authorization: `Bearer ${token}`, ...(options.origin ? { origin: options.origin } : {}) }, socket: { remoteAddress: "127.0.0.1" } });
  const result = await new Promise<{ status: number; data: Record<string, unknown> }>(resolve => {
    let status = 0;
    server.emit("request", req, { writeHead(code: number) { status = code; }, end(value: Buffer) { resolve({ status, data: JSON.parse(value.toString()) }); } });
  });
  return { ...result, calls };
}
describe("trusted historical source routes", () => {
  it("maps an allowlisted source reference to the legacy workspace and labels unapproved data", async () => {
    const result = await request("/memory/sources/stephen-history/history?conversation=source_1&observation=observation_1");
    expect(result.status).toBe(200);
    expect(result.calls).toEqual([[source.workspaceId, { conversation: "source_1", observation: "observation_1" }]]);
    expect(result.data).toMatchObject({ source: { ref: source.sourceRef, label: source.label }, trust_scope: "unapproved_source_evidence" });
    expect(JSON.stringify(result.data)).not.toContain(source.workspaceId);
  });
  it("denies other clients, browser origins, writes, unconfigured sources and arbitrary workspace selectors", async () => {
    for (const [url, options, status] of [
      ["/memory/sources/stephen-history/history", { client: "hermes" }, 403],
      ["/memory/sources/stephen-history/history", { origin: "http://localhost:3000" }, 403],
      ["/memory/sources/stephen-history/history", { method: "POST" }, 405],
      ["/memory/sources/another/history", {}, 404],
      ["/memory/sources/stephen-history/history?workspace_id=other", {}, 400],
      ["/memory/sources/stephen-history/history?observation=observation_1", {}, 400],
      ["/memory/sources/stephen-history/history?conversation=a&conversation=b", {}, 400],
    ] as const) {
      const result = await request(url, options);
      expect(result.status).toBe(status);
      expect(result.calls).toEqual([]);
    }
  });
  it("accepts a bounded literal project focus only for the authorized source inventory", async () => {
    const result = await request("/memory/sources/stephen-history/history?focus=tech4health");
    expect(result.status).toBe(200);
    expect(result.calls).toEqual([[source.workspaceId, { focus: "tech4health" }]]);
    for (const query of ["focus=a", "focus=%25", "focus=a&focus=b", "focus=tech4health&conversation=source_1", "focus="+"a".repeat(65)]) {
      const invalid = await request("/memory/sources/stephen-history/history?"+query);
      expect(invalid.status).toBe(400); expect(invalid.calls).toEqual([]);
    }
  });
  it("redacts backend failure details and distinguishes missing records", async () => {
    expect(await request("/memory/sources/stephen-history/history", { fail: "missing" })).toMatchObject({ status: 404, data: { error: "source_record_not_found" } });
    const failed = await request("/memory/sources/stephen-history/history", { fail: "database" });
    expect(failed).toMatchObject({ status: 503, data: { error: "source_history_unavailable" } });
    expect(JSON.stringify(failed.data)).not.toContain("secret");
  });
  it("requires explicit unique collection configuration with bounded identifiers", () => {
    expect(parseSourceCollections(undefined)).toEqual([]);
    expect(parseSourceCollections(JSON.stringify([source]))).toEqual([source]);
    for (const input of [[source, source], [{ ...source, workspaceId: "../private" }], [{ ...source, label: "" }], [{ ...source, unexpected: "value" }]]) {
      expect(() => parseSourceCollections(JSON.stringify(input))).toThrow();
    }
  });
});
