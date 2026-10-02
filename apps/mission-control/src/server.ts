import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDiagnostics } from "./diagnostics.js";
import { SnapshotFeed } from "./realtime.js";
import { MissionControlStore, type ApprovedKnowledgeInput, type SearchInput } from "./store.js";
import { ArchiveInspectorRepository, type MessageQuery } from "./archive-inspector.js";

const HOST = "127.0.0.1";
const PORT = boundedPort(process.env.HHS_MISSION_CONTROL_PORT, 43118);
const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const PUBLIC = path.join(ROOT, "apps", "mission-control", "public");
const workspaceId = required("MEMORY_WORKSPACE_ID");
const databaseUrl = required("MEMORY_REPORT_DATABASE_URL");
const archiveRoot = required("HHS_ARCHIVE_ROOT");
const store = new MissionControlStore(workspaceId, databaseUrl);
const inspections = new ArchiveInspectorRepository(archiveRoot);
const clients = new Set<ServerResponse>();
let refreshing: Promise<Record<string, unknown>> | undefined;
const feed = new SnapshotFeed();

const server = createServer(async (request, response) => {
  try {
    secureHeaders(response);
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "ready", mode: "read_only", host: "loopback" });
    }
    if (request.method === "GET" && request.url === "/api/snapshot") {
      return json(response, 200, await snapshot());
    }
    if (request.method === "POST" && request.url === "/api/search") {
      const input = JSON.parse(await readBody(request, 8_192)) as SearchInput;
      validateSearch(input);
      return json(response, 200, { results: await store.search(input), mode: "read_only" });
    }
    if (request.method === "POST" && request.url === "/api/approved-knowledge") {
      const input = JSON.parse(await readBody(request, 8_192)) as ApprovedKnowledgeInput;
      if (input.text !== undefined && typeof input.text !== "string") throw new Error("Invalid search text.");
      return json(response, 200, await store.approvedKnowledge(input));
    }
    if (request.method === "POST" && request.url === "/api/archive-inspector") {
      const input = JSON.parse(await readBody(request, 2_048)) as { capture_ref?: string };
      if (!input.capture_ref) throw new Error("A safe capture reference is required.");
      const [operation, overview] = await Promise.all([
        store.captureOperationBySafeReference(input.capture_ref),
        inspections.overview(input.capture_ref)
      ]);
      if (operation.archive_manifest_sha256 !== overview.provenance.source_manifest_sha256) {
        throw new Error("Operation and derived inspection provenance disagree.");
      }
      return json(response, 200, { inspection: overview, mode: "read_only" });
    }
    if (request.method === "POST" && request.url === "/api/archive-inspector/messages") {
      const input = JSON.parse(await readBody(request, 4_096)) as MessageQuery;
      await store.captureOperationBySafeReference(input.capture_ref);
      return json(response, 200, { ...(await inspections.messages(input)), mode: "read_only" });
    }
    if (request.method === "GET" && request.url === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive"
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
      return file(response, "index.html", "text/html; charset=utf-8");
    }
    if (request.method === "GET" && request.url === "/app.js") {
      return file(response, "app.js", "text/javascript; charset=utf-8");
    }
    if (request.method === "GET" && request.url === "/styles.css") {
      return file(response, "styles.css", "text/css; charset=utf-8");
    }
    return json(response, 404, { error: "Not found" });
  } catch {
    return json(response, 503, { error: "Mission Control could not complete the read-only request." });
  }
});

const timer = setInterval(() => void publishChanges(), 5_000);
timer.unref();

server.listen(PORT, HOST, () => {
  if (process.env.HHS_SAFE_BACKGROUND !== "1") console.log(`HHS Mission Control listening on http://${HOST}:${PORT}`);
});

async function snapshot(): Promise<Record<string, unknown>> {
  refreshing ??= Promise.all([store.snapshot(), collectDiagnostics(ROOT), inspections.list()])
    .then(([data, system, archiveInspections]) => ({
      ...data, system, archive_inspections: archiveInspections, registry: registry()
    }))
    .finally(() => { refreshing = undefined; });
  return refreshing;
}

async function publishChanges(): Promise<void> {
  if (!clients.size) return;
  try {
    const data = await snapshot();
    const event = feed.next(data);
    if (!event) return;
    for (const client of clients) client.write(event);
  } catch {
    const event = `event: degraded\ndata: {"state":"degraded"}\n\n`;
    for (const client of clients) client.write(event);
  }
}

function registry(): Array<Record<string, string>> {
  return [
    ["ChatGPT", "connected", "capture source"],
    ["Gemini", "planned", "future adapter"],
    ["Claude", "planned", "future adapter"],
    ["Perplexity", "planned", "future adapter"],
    ["GitHub", "disconnected", "external connection disabled"],
    ["Drive", "disconnected", "external connection disabled"],
    ["Email", "planned", "future source"],
    ["Phone media", "planned", "future source"],
    ["CRM", "planned", "future destination"],
    ["Hermes", "disconnected", "orchestration not launched"],
    ["Codex", "ready", "build and repair"],
    ["Obsidian", "planned", "approved projection later"],
    ["Google Docs", "disconnected", "external connection disabled"]
  ].map(([name, state, role]) => ({ name: name!, state: state!, role: role! }));
}

async function file(response: ServerResponse, name: string, contentType: string): Promise<void> {
  const bytes = await readFile(path.join(PUBLIC, name));
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(bytes);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("Request body too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateSearch(input: SearchInput): void {
  if (input.text !== undefined && typeof input.text !== "string") throw new Error("Invalid search text.");
  if (input.record_type && !new Set(["message", "block"]).has(input.record_type)) throw new Error("Invalid record type.");
  if (input.role && !new Set(["user", "assistant", "tool", "system_visible", "unknown"]).has(input.role)) throw new Error("Invalid role.");
  if (input.verification_status && !new Set(["complete", "partial", "failed", "needs_review"]).has(input.verification_status)) throw new Error("Invalid verification state.");
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function boundedPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Mission Control port is invalid.");
  return port;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function shutdown(): Promise<void> {
  clearInterval(timer);
  for (const client of clients) client.end();
  server.close();
  await store.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
