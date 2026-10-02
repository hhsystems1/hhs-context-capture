import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";

const DOCKER_SOCKET = process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
const MAX_CREATE_BODY = 8 * 1024 * 1024;

export interface DockerProxyHandle {
  url: string;
  close(): Promise<void>;
}

export function forceLoopbackPortBindings(body: unknown): unknown {
  if (!body || typeof body !== "object") throw new Error("Docker create request must be an object.");
  const request = body as { HostConfig?: { PortBindings?: Record<string, Array<Record<string, unknown>> | null> } };
  const bindings = request.HostConfig?.PortBindings;
  if (!bindings) return body;
  for (const rows of Object.values(bindings)) {
    for (const row of rows ?? []) row.HostIp = "127.0.0.1";
  }
  return body;
}

export async function startDockerLoopbackProxy(): Promise<DockerProxyHandle> {
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  if (process.platform !== "win32" && !isWsl) {
    throw new Error("The Docker loopback proxy requires Windows or WSL.");
  }
  const server = http.createServer((request, response) => void proxyRequest(request, response));
  server.on("upgrade", proxyUpgrade);
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Docker loopback proxy did not receive a TCP port.");
  }
  return {
    url: `tcp://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    })
  };
}

async function proxyRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const createRequest = request.method === "POST" && /\/containers\/create(?:\?|$)/.test(request.url ?? "");
    if (!createRequest) return pipeRequest(request, response);
    const body = await readBody(request);
    const rewritten = Buffer.from(JSON.stringify(forceLoopbackPortBindings(JSON.parse(body.toString("utf8")))), "utf8");
    const headers = { ...request.headers, "content-length": String(rewritten.length) };
    delete headers["transfer-encoding"];
    const upstream = http.request({
      socketPath: DOCKER_SOCKET,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => safeProxyError(response));
    upstream.end(rewritten);
  } catch {
    safeProxyError(response);
  }
}

function pipeRequest(request: IncomingMessage, response: ServerResponse): void {
  const upstream = http.request({
    socketPath: DOCKER_SOCKET,
    method: request.method,
    path: request.url,
    headers: request.headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => safeProxyError(response));
  request.pipe(upstream);
}

function proxyUpgrade(request: IncomingMessage, client: net.Socket, head: Buffer): void {
  const upstream = net.createConnection(DOCKER_SOCKET);
  upstream.once("error", () => client.destroy());
  client.once("error", () => upstream.destroy());
  upstream.once("connect", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CREATE_BODY) throw new Error("Docker create request exceeded the safe limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function safeProxyError(response: ServerResponse): void {
  if (response.headersSent) return void response.destroy();
  response.writeHead(502, { "content-type": "application/json" }).end('{"message":"Local Docker security proxy failed."}');
}
