import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { assertLocalDatabaseUrl } from "./config.js";
import { getApprovedKnowledge, queryApprovedKnowledge, type ApprovedKnowledgeDetail, type ApprovedKnowledgeMatch } from "./query.js";
import { ComparisonPayloadError, compareDiscoveredConversations, parseComparisonPayload, type ComparisonRequest } from "./discovery-comparison.js";
import type { KnownConversationRecord } from "@hhs/capture-planning";
import { readSourceHistory, SourceHistoryNotFound, type HistoryInput } from "./source-history.js";

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
  sourceCollections?: Array<{ sourceRef: string; workspaceId: string; label: string }>;
}

export interface QueryServiceDeps {
  query(workspaceId: string, question: string, limit: number): Promise<{ question: string; mode: string; trust_scope: string; matches: ApprovedKnowledgeMatch[] }>;
  getKnowledge(workspaceId: string, approvedKnowledgeId: string): Promise<ApprovedKnowledgeDetail>;
  /**
   * Optional read-only discovery comparison. When absent the route reports that the capability is
   * not configured, so an older host cannot silently answer comparison requests.
   */
  compareDiscovery?(request: ComparisonRequest): Promise<KnownConversationRecord[]>;
  sourceHistory?(workspaceId: string, input: HistoryInput): Promise<Record<string, unknown>>;
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
  return { workspaceId, port, clients: parseClientTokens(env.MEMORY_QUERY_SERVICE_TOKENS ?? ""),
    sourceCollections: parseSourceCollections(env.MEMORY_QUERY_SOURCE_COLLECTIONS) };
}

export function parseSourceCollections(raw: string | undefined): NonNullable<QueryServiceConfig["sourceCollections"]> {
  if (!raw?.trim()) return [];
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20) throw new Error("Invalid source collections configuration.");
  const sources = entries.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid source collection.");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some(key => !["sourceRef", "workspaceId", "label"].includes(key)) ||
      typeof row.sourceRef !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.sourceRef) ||
      typeof row.workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.workspaceId) ||
      typeof row.label !== "string" || !row.label.trim() || row.label.length > 160) throw new Error("Invalid source collection.");
    return { sourceRef: row.sourceRef, workspaceId: row.workspaceId, label: row.label };
  });
  if (new Set(sources.map(source => source.sourceRef)).size !== sources.length) throw new Error("Duplicate source reference.");
  return sources;
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

      const sourceUrl = new URL(request.url ?? "", "http://127.0.0.1");
      const historyMatch = /^\/memory\/sources\/([a-z0-9][a-z0-9_-]{0,63})\/history$/.exec(sourceUrl.pathname);
      if (historyMatch) {
        if (client.name !== "hhs-core" || request.headers.origin !== undefined) return json(response, 403, { error: "source_access_forbidden" });
        if (request.method !== "GET") return json(response, 405, { error: "read_only" });
        const source = config.sourceCollections?.find(item => item.sourceRef === historyMatch[1]);
        if (!source) return json(response, 404, { error: "source_not_configured" });
        const params = sourceUrl.searchParams;
        if (Array.from(params.keys()).some(key => !["conversation", "observation", "cursor", "focus"].includes(key)) ||
          new Set(params.keys()).size !== Array.from(params.keys()).length ||
          Array.from(params).some(([key,value]) => !(key === "focus" ? /^[a-z0-9]{3,64}$/ : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).test(value)) ||
          (params.has("observation") && !params.has("conversation")) || (params.has("focus") && params.has("conversation"))) return json(response, 400, { error: "invalid_source_request" });
        if (!deps.sourceHistory) return json(response, 501, { error: "source_history_not_configured" });
        try {
          const result = await deps.sourceHistory(source.workspaceId, Object.fromEntries(params));
          const body = { ...result, source: { ref: source.sourceRef, label: source.label }, trust_scope: "unapproved_source_evidence" };
          if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1024 * 1024) throw new Error("Source response limit exceeded.");
          return json(response, 200, body);
        } catch (error) {
          return json(response, error instanceof SourceHistoryNotFound ? 404 : 503,
            { error: error instanceof SourceHistoryNotFound ? "source_record_not_found" : "source_history_unavailable" });
        }
      }

      const scopedQueryMatch = /^\/memory\/workspaces\/(workspace_[0-9a-f]{32})\/query$/.exec(request.url ?? "");
      if (request.method === "POST" && scopedQueryMatch?.[1]) {
        if (client.name !== "hhs-core") {
          return json(response, 403, { error: "workspace_selection_forbidden" });
        }

        const workspaceId = scopedQueryMatch[1];
        const body = await readBody(request);
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question) return json(response, 400, { error: "question_required" });

        const limit = Number.isInteger(body.limit) ? Number(body.limit) : 20;
        const result = await deps.query(workspaceId, question, limit);

        audit(client.name, "POST /memory/workspaces/:workspace_id/query", {
          workspace_id: workspaceId,
          question_length: question.length,
          matches: result.matches.length
        });

        return json(response, 200, { client: client.name, workspace_id: workspaceId, ...result });
      }

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
    compareDiscovery: (comparison) => compareDiscoveredConversations(comparison),
    sourceHistory: readSourceHistory
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
