import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const requiredNames = ["MEMORY_DATABASE_URL","HHS_ARCHIVE_ROOT","MEMORY_APPROVED_CAPTURE_ID","MEMORY_APPROVED_CAPTURE_PATH","MEMORY_WORKSPACE_ID","MEMORY_PIPELINE_VERSION","MEMORY_PROOF_ROOT"] as const;
const values = Object.fromEntries(requiredNames.map((name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for local provisioning.`);
  return [name, value];
})) as Record<(typeof requiredNames)[number], string>;
const adminUrl = assertLocal(values.MEMORY_DATABASE_URL);
const writerPassword = randomBytes(32).toString("base64url");
const readerPassword = randomBytes(32).toString("base64url");
const reviewerPassword = randomBytes(32).toString("base64url");
const pool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
try {
  await pool.query(`alter role memory_v1_ingest_login password '${sqlLiteral(writerPassword)}'`);
  await pool.query(`alter role memory_v1_report_login password '${sqlLiteral(readerPassword)}'`);
  await pool.query(`alter role memory_v1_review_login password '${sqlLiteral(reviewerPassword)}'`);
} finally { await pool.end(); }

const writerUrl = new URL(adminUrl); writerUrl.username = "memory_v1_ingest_login"; writerUrl.password = writerPassword;
const readerUrl = new URL(adminUrl); readerUrl.username = "memory_v1_report_login"; readerUrl.password = readerPassword;
const reviewerUrl = new URL(adminUrl); reviewerUrl.username = "memory_v1_review_login"; reviewerUrl.password = reviewerPassword;
const configPath = path.resolve(".env.memory-v1.local");
const temporary = `${configPath}.tmp`;
const lines = [
  "# Private local Memory V1.1 configuration. Never commit this file.",
  entry("MEMORY_DATABASE_URL", adminUrl.toString()),
  entry("MEMORY_INGEST_DATABASE_URL", writerUrl.toString()),
  entry("MEMORY_REPORT_DATABASE_URL", readerUrl.toString()),
  entry("MEMORY_REVIEW_DATABASE_URL", reviewerUrl.toString()),
  ...requiredNames.filter((name) => name !== "MEMORY_DATABASE_URL").map((name) => entry(name, values[name])),
  ""
];
await writeFile(temporary, lines.join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, configPath);
console.log(JSON.stringify({ status: "provisioned", config_file: path.basename(configPath), writer_role: "memory_v1_ingest_login", reader_role: "memory_v1_report_login", reviewer_role: "memory_v1_review_login" }));

function entry(name: string, value: string): string { return `${name}=${JSON.stringify(value)}`; }
function sqlLiteral(value: string): string { return value.replaceAll("'", "''"); }
function assertLocal(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1","localhost","::1"]).has(url.hostname)) throw new Error("Only local PostgreSQL can be provisioned.");
  return url;
}
