/**
 * Ingest ONE verified Codex capture bundle through the existing
 * source-neutral memory-ingest path (memory_v1 unchanged).
 *
 * Usage:
 *   tsx --env-file=.env.memory-v1.local scripts/codex-ingest.ts \
 *     --capture-path <bundle dir> --capture-id <capture uuid>
 */
import path from "node:path";
import { ingestApprovedCapture } from "../apps/memory-ingest/src/ingest.js";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const result = await ingestApprovedCapture({
  archiveRoot: env("HHS_ARCHIVE_ROOT"),
  capturePath: path.resolve(arg("capture-path")),
  captureId: arg("capture-id"),
  workspaceId: env("MEMORY_WORKSPACE_ID"),
  pipelineVersion: env("MEMORY_PIPELINE_VERSION")
});
console.log(JSON.stringify(result, null, 2));
