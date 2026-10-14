import http from "node:http";
import { authenticate, parseClientTokens, type QueryServiceClient } from "./query-service.js";

export interface BrainGrant { sourceRef: string; sourceWorkspaceId: string; destinationWorkspaceId: string; targetRef: string }
export interface BridgeConfig { port: number; clients: QueryServiceClient[]; grants: BrainGrant[] }
export class BridgeError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export function parseBrainGrants(raw: string): BrainGrant[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 20) throw new Error("Invalid bridge grants.");
  const grants = values.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge grant.");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join() !== ["destinationWorkspaceId", "sourceRef", "sourceWorkspaceId", "targetRef"].join() ||
      typeof row.sourceRef !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.sourceRef) ||
      typeof row.sourceWorkspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.sourceWorkspaceId) ||
      typeof row.destinationWorkspaceId !== "string" || !/^workspace_[0-9a-f]{32}$/.test(row.destinationWorkspaceId) ||
      typeof row.targetRef !== "string" || !/^[0-9a-f-]{36}$/.test(row.targetRef)) throw new Error("Invalid bridge grant.");
    return row as unknown as BrainGrant;
  });
  if (new Set(grants.map(g => `${g.sourceRef}:${g.destinationWorkspaceId}:${g.targetRef}`)).size !== grants.length) throw new Error("Duplicate bridge grants.");
  return grants;
}
export function bridgeConfig(env: Record<string, string | undefined>, prefix: string, port: number): BridgeConfig {
  const configuredPort = Number(env[`${prefix}_PORT`] ?? port);
  if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) throw new Error("Invalid bridge port.");
  const clients = parseClientTokens(env[`${prefix}_TOKENS`] ?? "");
  if (clients.length !== 1 || clients[0]!.name !== "hhs-core") throw new Error("Bridge accepts only trusted Core.");
  return { port: configuredPort, clients, grants: parseBrainGrants(env[`${prefix}_GRANTS`] ?? "[]") };
}
export function grantFor(config: BridgeConfig, value: unknown): BrainGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError(400, "invalid_request");
  const body = value as Record<string, unknown>;
  const grant = config.grants.find(g => g.sourceRef === body.sourceRef && g.destinationWorkspaceId === body.destinationWorkspaceId && g.targetRef === body.targetRef);
  if (!grant) throw new BridgeError(403, "scope_denied");
  return grant;
}
export function bridgeServer(config: BridgeConfig, dispatch: (method: string, pathname: string, body: Record<string, unknown>) => Promise<unknown>) {
  const server = http.createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(body));
    };
    try {
      if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
        request.headers.host !== `127.0.0.1:${response.socket?.localPort ?? config.port}` || request.headers.origin !== undefined) throw new BridgeError(403, "loopback_only");
      if (!authenticate(config.clients, request.headers.authorization)) throw new BridgeError(401, "authentication_required");
      if (request.headers["content-type"] !== "application/json") throw new BridgeError(400, "invalid_request");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 32768) throw new BridgeError(413, "request_too_large"); chunks.push(Buffer.from(chunk)); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BridgeError(400, "invalid_request"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError(400, "invalid_request");
      const result = await dispatch(request.method ?? "", request.url ?? "", body as Record<string, unknown>);
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new BridgeError(503, "bridge_unavailable");
      reply(200, result);
    } catch (error) { reply(error instanceof BridgeError ? error.status : 503, { error: error instanceof BridgeError ? error.code : "bridge_unavailable" }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
export function exactKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new BridgeError(400, "invalid_request");
}
export function safeRef(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
