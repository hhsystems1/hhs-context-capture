import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Writes the ignored, service-only configuration for the Memory Query Service.
// The file receives exactly one database credential: the report-reader URL,
// copied from the operator's main private configuration. Admin, ingest, and
// reviewer URLs are intentionally never written here; the service refuses to
// start if they appear in its environment.

const mainConfig = await readFile(path.resolve(".env.memory-v1.local"), "utf8");
const reportUrl = readEntry(mainConfig, "MEMORY_REPORT_DATABASE_URL");
const workspaceId = readEntry(mainConfig, "MEMORY_WORKSPACE_ID");
assertLocal(reportUrl);
if (new URL(reportUrl).username !== "memory_v1_report_login") throw new Error("Report URL must use the report-reader login.");

const clients = ["hermes", "claude", "codex", "sidekick"];
const tokens = clients.map((name) => `${name}:${randomBytes(32).toString("base64url")}`).join(",");
const configPath = path.resolve(".env.memory-query-service.local");
const temporary = `${configPath}.tmp`;
const lines = [
  "# Private local Memory Query Service configuration. Never commit this file.",
  "# Contains ONLY the read-only report credential and per-agent bearer tokens.",
  entry("MEMORY_REPORT_DATABASE_URL", reportUrl),
  entry("MEMORY_WORKSPACE_ID", workspaceId),
  entry("MEMORY_QUERY_SERVICE_PORT", "54431"),
  entry("MEMORY_QUERY_SERVICE_TOKENS", tokens),
  ""
];
await writeFile(temporary, lines.join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, configPath);
console.log(JSON.stringify({ status: "provisioned", config_file: path.basename(configPath), database_role: "memory_v1_report_login", clients }));

function entry(name: string, value: string): string { return `${name}=${JSON.stringify(value)}`; }
function readEntry(content: string, name: string): string {
  const match = new RegExp(`^${name}="?([^"\n]+)"?$`, "m").exec(content);
  if (!match?.[1]) throw new Error(`${name} not found in .env.memory-v1.local; run memory:provision first.`);
  return match[1];
}
function assertLocal(value: string): void {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) throw new Error("Only loopback PostgreSQL URLs are permitted.");
}
