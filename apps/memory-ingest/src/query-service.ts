import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { assertLocalDatabaseUrl } from "./config.js";
import { getApprovedKnowledge, queryApprovedKnowledge, type ApprovedKnowledgeDetail, type ApprovedKnowledgeMatch } from "./query.js";
import { ComparisonPayloadError, compareDiscoveredConversations, parseComparisonPayload, type ComparisonRequest } from "./discovery-comparison.js";
import type { KnownConversationRecord } from "@hhs/capture-planning";

// Local read-only Memory Query Service.
// Loopback-only. Holds exactly one database credential: the report-reader role.
// Startup refuses to run if any write-capable memory_v1 credential is present
// in the process environment, so admin/ingest/reviewer secrets can never be
// exposed through this process even by misconfiguration.

export const LOOPBACK_HOST = "127.0.0.1";
export const FORBIDDEN_ENV_VARS = ["MEMORY_DATABASE_URL", "MEMORY_INGEST_DATABASE_URL", "MEMORY_REVIEW_DATABASE_URL"] as const;

export interface QueryServiceClient { name: string; tokenSha256: string }

export interface QueryServiceConfig {
  workspaceId: string;
  port: number;
  clients: QueryServiceClient[];
}

export interface QueryServiceDeps {
  query(workspaceId: string, question: string, limit: number): Promise<{ question: string; mode: string; trust_scope: string; matches: ApprovedKnowledgeMatch[] }>;
  getKnowledge(workspaceId: string, approvedKnowledgeId: string): Promise<ApprovedKnowledgeDetail>;
  /**
   * Optional read-only discovery comparison. When absent the route reports that the capability is
   * not configured, so an older host cannot silently answer comparison requests.
   */
  compareDiscovery?(request: ComparisonRequest): Promise<KnownConversationRecord[]>;
}

export function assertServiceEnvironment(env: Record<string, string | undefined>): void {
  const present = FORBIDDEN_ENV_VARS.filter((name) => env[name]?.trim());
  if (present.length) throw new Error(`Refusing to start: write-capable credentials must not be loaded into the query service: ${present.join(", ")}`);
  const reportUrl = env.MEMORY_REPORT_DATABASE_URL?.trim();
  if (!reportUrl) throw new Error("MEMORY_REPORT_DATABASE_URL is required.");
  assertLocalDatabaseUrl(reportUrl);
  const reportUser = new URL(reportUrl).username;
  if (reportUser !== "memory_v1_report_login") throw new Error(`Query service requires the report-reader login, received '${reportUser}'.`);
}

export function loadServiceConfig(env: Record<string, string | undefined>): QueryServiceConfig {
  assertServiceEnvironment(env);
  const workspaceId = env.MEMORY_WORKSPACE_ID?.trim();
  if (!workspaceId) throw new Error("MEMORY_WORKSPACE_ID is required.");
  const port = Number(env.MEMORY_QUERY_SERVICE_PORT || 54431);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MEMORY_QUERY_SERVICE_PORT must be an unprivileged TCP port.");
  return { workspaceId, port, clients: parseClientTokens(env.MEMORY_QUERY_SERVICE_TOKENS ?? "") };
}

export function parseClientTokens(raw: string): QueryServiceClient[] {
  const clients = raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(":");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const token = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!/^[a-z0-9_-]{2,32}$/.test(name)) throw new Error("Client token entries must be <name>:<token> with a short lowercase name.");
    if (token.length < 32) throw new Error(`Client token for '${name}' must be at least 32 characters.`);
    return { name, tokenSha256: sha256Hex(token) };
  });
  if (!clients.length) throw new Error("MEMORY_QUERY_SERVICE_TOKENS must define at least one client token.");
  if (new Set(clients.map((client) => client.name)).size !== clients.length) throw new Error("Client names must be unique.");
  return clients;
}

export function authenticate(clients: QueryServiceClient[], authorization: string | undefined): QueryServiceClient | null {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  const presented = sha256Hex(authorization.slice(7).trim());
  for (const client of clients) {
    if (timingSafeEqual(Buffer.from(client.tokenSha256, "hex"), Buffer.from(presented, "hex"))) return client;
  }
  return null;
}

export function createQueryService(config: QueryServiceConfig, deps: QueryServiceDeps): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const remote = request.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return json(response, 403, { error: "loopback_only" });
      if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ready", service: "memory-query-service", trust_scope: "approved_knowledge_only", database_role: "memory_v1_report_login" });

      const client = authenticate(config.clients, request.headers.authorization);
      if (!client) return json(response, 401, { error: "invalid_or_missing_token" });

      if (request.method === "POST" && request.url === "/memory/query") {
        const body = await readBody(request);
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question) return json(response, 400, { error: "question_required" });
        const limit = Number.isInteger(body.limit) ? Number(body.limit) : 20;
        const result = await deps.query(config.workspaceId, question, limit);
        audit(client.name, "POST /memory/query", { question_length: question.length, matches: result.matches.length });
        return json(response, 200, { client: client.name, ...result });
      }

      if (request.method === "POST" && request.url === "/discovery/compare") {
        if (!deps.compareDiscovery) return json(response, 501, { error: "discovery_comparison_not_configured" });
        let payload;
        try {
          payload = parseComparisonPayload(await readBody(request));
        } catch (error) {
          if (error instanceof ComparisonPayloadError) return json(response, 400, { error: "invalid_payload", detail: error.message });
          throw error;
        }
        const known = await deps.compareDiscovery({ workspaceId: config.workspaceId, ...payload });
        audit(client.name, "POST /discovery/compare", {
          source_kind: payload.sourceKind,
          requested: payload.items.length,
          matched: known.length
        });
        return json(response, 200, {
          client: client.name,
          trust_scope: "source_records_read_only",
          source_kind: payload.sourceKind,
          requested: payload.items.length,
          known
        });
      }

      const knowledgeMatch = /^\/memory\/knowledge\/([A-Za-z0-9_-]+)$/.exec(request.url ?? "");
      if (request.method === "GET" && knowledgeMatch?.[1]) {
        try {
          const detail = await deps.getKnowledge(config.workspaceId, knowledgeMatch[1]);
          audit(client.name, "GET /memory/knowledge", { approved_knowledge_id: knowledgeMatch[1] });
          return json(response, 200, { client: client.name, trust_scope: "approved_knowledge_only", ...detail });
        } catch (error) {
          if (/not found/i.test(String(error))) return json(response, 404, { error: "approved_knowledge_not_found" });
          throw error;
        }
      }

      return json(response, 404, { error: "unknown_route" });
    } catch (error) {
      console.error("memory-query-service error:", error);
      return json(response, 500, { error: "internal_error" });
    }
  });
}

export async function startFromEnvironment(): Promise<http.Server> {
  const config = loadServiceConfig(process.env);
  const server = createQueryService(config, {
    query: (workspace, question, limit) => queryApprovedKnowledge(workspace, question, limit),
    getKnowledge: getApprovedKnowledge,
    compareDiscovery: (comparison) => compareDiscoveredConversations(comparison)
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, LOOPBACK_HOST, resolve);
  });
  console.log(JSON.stringify({ status: "listening", host: LOOPBACK_HOST, port: config.port, clients: config.clients.map((client) => client.name), database_role: "memory_v1_report_login" }));
  return server;
}

function audit(client: string, operation: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), client, operation, ...detail }));
}

function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body, null, 2), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  response.end(bytes);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startFromEnvironment();
