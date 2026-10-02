import pg from "pg";
import { assertLocalDatabaseUrl } from "./config.js";

const { Pool } = pg;
export type DbClient = pg.PoolClient;

export type DatabaseRole = "admin" | "writer" | "reader" | "reviewer";

export function createPool(role: DatabaseRole = "writer"): pg.Pool {
  const variable = role === "admin" ? "MEMORY_DATABASE_URL" : role === "writer" ? "MEMORY_INGEST_DATABASE_URL" : role === "reviewer" ? "MEMORY_REVIEW_DATABASE_URL" : "MEMORY_REPORT_DATABASE_URL";
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required and must point to local Supabase PostgreSQL.`);
  assertLocalDatabaseUrl(connectionString);
  return new Pool({ connectionString, max: 4, application_name: `hhs-memory-v1.1-${role}` });
}

export async function immutableInsert(client: DbClient, table: string, idColumn: string, row: Record<string, unknown>): Promise<"inserted" | "existing"> {
  const workspace = String(row.workspace_id);
  const id = String(row[idColumn]);
  const expectedHash = String(row.record_sha256);
  const prior = await client.query(`select record_sha256 from memory_v1.${table} where workspace_id=$1 and ${idColumn}=$2`, [workspace, id]);
  if (prior.rowCount) {
    if (prior.rows[0]?.record_sha256 !== expectedHash) throw new Error(`Immutable idempotency collision in ${table} for ${id}.`);
    return "existing";
  }
  const columns = Object.keys(row);
  // node-postgres treats JavaScript arrays as PostgreSQL arrays. The M1
  // contracts store collection-valued source fields as JSONB, so serialize
  // arrays explicitly while leaving scalar and object parameters untouched.
  const values = columns.map((column) => Array.isArray(row[column]) ? JSON.stringify(row[column]) : row[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(",");
  await client.query(`insert into memory_v1.${table} (${columns.join(",")}) values (${placeholders})`, values);
  return "inserted";
}

export async function transaction<T>(pool: pg.Pool, workspaceId: string, callback: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    await client.query("set constraints all deferred");
    const value = await callback(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

export async function readOnlyTransaction<T>(pool: pg.Pool, workspaceId: string, callback: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [workspaceId]);
    const value = await callback(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
