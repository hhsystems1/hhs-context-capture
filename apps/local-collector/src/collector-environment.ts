import { assertLocalDatabaseUrl } from "../../memory-ingest/src/config.js";

const allowed = new Set(["HHS_ARCHIVE_ROOT", "HHS_COLLECTOR_PORT", "HHS_SAFE_BACKGROUND", "MEMORY_WORKSPACE_ID", "MEMORY_PIPELINE_VERSION",
  "MEMORY_INGEST_DATABASE_URL", "MEMORY_REPORT_DATABASE_URL", "HHS_PIPELINE_LOCAL_INGEST", "HHS_PIPELINE_SOURCE_REF", "HHS_COLLECTOR_OPERATOR_TOKEN", "HHS_PIPELINE_HANDOFF_MAX_ATTEMPTS"]);

// A legacy launcher must not silently override the registered source or roles.
export function collectorEnvironment(inherited: NodeJS.ProcessEnv, configured: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (Object.entries(configured).some(([key, value]) => !allowed.has(key) || typeof value !== "string")) throw new Error("Unexpected collector configuration key.");
  for (const [key, role] of [["MEMORY_INGEST_DATABASE_URL", "memory_v1_ingest_login"], ["MEMORY_REPORT_DATABASE_URL", "memory_v1_report_login"]]) {
    if (assertLocalDatabaseUrl(configured[key!] ?? "").username !== role) throw new Error("Collector requires isolated ingest/report roles.");
  }
  const result = { ...inherited };
  for (const key of Object.keys(result)) {
    if (/^MEMORY_|^HHS_PIPELINE_|^HHS_COLLECTOR_|^HHS_ARCHIVE_ROOT$|^HHS_SAFE_BACKGROUND$/.test(key) ||
      ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "PROVIDER_SECRET_ENCRYPTION_KEY"].includes(key)) delete result[key];
  }
  return { ...result, ...configured };
}
