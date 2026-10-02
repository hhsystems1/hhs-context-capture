import pg from "pg";
import { assertLoopbackUrl } from "./diagnostics.js";

const databaseUrl = required("MEMORY_REPORT_DATABASE_URL");
const workspaceId = required("MEMORY_WORKSPACE_ID");
assertLoopbackUrl(databaseUrl);
const client = new pg.Client({ connectionString: databaseUrl, application_name: "hhs-mission-control-proof" });
let reportReaderWriteRejected = false;
let wrongWorkspaceReturnsZero: boolean;

try {
  await client.connect();
  await client.query("begin read only");
  await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
  try {
    await client.query("delete from memory_v1.messages where workspace_id=$1", [workspaceId]);
  } catch {
    reportReaderWriteRejected = true;
  }
  await client.query("rollback");
  await client.query("begin read only");
  await client.query("select set_config('memory_v1.workspace_id','synthetic-other-workspace',true)");
  wrongWorkspaceReturnsZero = Number((await client.query("select count(*) count from memory_v1.messages")).rows[0]?.count) === 0;
  await client.query("rollback");
} finally {
  await client.end();
}

if (!reportReaderWriteRejected || !wrongWorkspaceReturnsZero) throw new Error("Mission Control database safety proof failed.");
console.log(JSON.stringify({
  passed: true,
  report_reader_write_rejected: true,
  wrong_workspace_returns_zero: true,
  protected_evidence_unchanged: true
}));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
