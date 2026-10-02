import path from "node:path";

export interface MemoryConfig {
  archiveRoot: string;
  approvedCapturePath: string;
  approvedCaptureId: string;
  workspaceId: string;
  pipelineVersion: string;
  proofRoot: string;
  adminDatabaseUrl: string;
  writerDatabaseUrl: string;
  readerDatabaseUrl: string;
  reviewDatabaseUrl: string;
}

export function loadMemoryConfig(): MemoryConfig {
  const config: MemoryConfig = {
    archiveRoot: required("HHS_ARCHIVE_ROOT"),
    approvedCapturePath: required("MEMORY_APPROVED_CAPTURE_PATH"),
    approvedCaptureId: required("MEMORY_APPROVED_CAPTURE_ID"),
    workspaceId: required("MEMORY_WORKSPACE_ID"),
    pipelineVersion: required("MEMORY_PIPELINE_VERSION"),
    proofRoot: required("MEMORY_PROOF_ROOT"),
    adminDatabaseUrl: required("MEMORY_DATABASE_URL"),
    writerDatabaseUrl: required("MEMORY_INGEST_DATABASE_URL"),
    readerDatabaseUrl: required("MEMORY_REPORT_DATABASE_URL"),
    reviewDatabaseUrl: required("MEMORY_REVIEW_DATABASE_URL")
  };
  for (const value of [config.adminDatabaseUrl, config.writerDatabaseUrl, config.readerDatabaseUrl, config.reviewDatabaseUrl]) assertLocalDatabaseUrl(value);
  const root = path.resolve(config.archiveRoot);
  const capture = path.resolve(config.approvedCapturePath);
  const relative = path.relative(root, capture);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Approved capture path must be contained by HHS_ARCHIVE_ROOT.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(config.pipelineVersion)) throw new Error("MEMORY_PIPELINE_VERSION is invalid.");
  return config;
}

export function assertLocalDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) throw new Error("Hosted database connections are prohibited for Memory Vertical Slice V1.1.");
  return url;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
