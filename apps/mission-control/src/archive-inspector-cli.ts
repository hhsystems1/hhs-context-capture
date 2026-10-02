import { readFile } from "node:fs/promises";
import {
  ArchiveInspectorRepository, generateArchiveInspection, type TopicPlan
} from "./archive-inspector.js";
import { MissionControlStore } from "./store.js";

const command = process.argv[2];
const safeCaptureReference = process.argv[3];
const archiveRoot = required("HHS_ARCHIVE_ROOT");
const workspaceId = required("MEMORY_WORKSPACE_ID");
const databaseUrl = required("MEMORY_REPORT_DATABASE_URL");
const store = new MissionControlStore(workspaceId, databaseUrl);
const reports = new ArchiveInspectorRepository(archiveRoot);

try {
  if (command === "generate") {
    if (!safeCaptureReference) throw new Error("A safe capture reference is required.");
    const operation = await store.captureOperationBySafeReference(safeCaptureReference);
    const topicPlan = await readTopicPlan();
    const result = await generateArchiveInspection({ archiveRoot, operation, topicPlan });
    console.log(JSON.stringify({
      mode: "private_derived_write",
      safe_capture_reference: result.manifest.safe_capture_reference,
      verdict: result.manifest.verdict,
      active_path_complete: result.manifest.active_path_complete,
      branches_complete: result.manifest.branches_complete,
      message_count: result.manifest.source_message_count,
      source_manifest_sha256: result.manifest.source_manifest_sha256,
      report_location: "private_archive_derived_reports"
    }, null, 2));
  } else if (command === "verify") {
    if (!safeCaptureReference) throw new Error("A safe capture reference is required.");
    const operation = await store.captureOperationBySafeReference(safeCaptureReference);
    const overview = await reports.overview(safeCaptureReference);
    let accessible = 0;
    for (let offset = 0; offset < overview.message_count; offset += 100) {
      const page = await reports.messages({ capture_ref: safeCaptureReference, offset, limit: 100 });
      accessible += page.messages.length;
      if (!page.messages.every((message, index) => message.sequence === offset + index)) {
        throw new Error("Inspector message sequence is not contiguous.");
      }
    }
    if (accessible !== overview.message_count
      || operation.archive_manifest_sha256 !== overview.provenance.source_manifest_sha256
      || overview.active_path_complete !== true
      || overview.branches_complete !== false) {
      throw new Error("Derived inspection verification failed.");
    }
    console.log(JSON.stringify({
      mode: "read_only_verification",
      safe_capture_reference: safeCaptureReference,
      message_count: accessible,
      sequence: `0-${accessible - 1}`,
      topic_count: overview.topics.length,
      topic_provenance_verified: overview.provenance.topic_ranges_verified,
      source_manifest_sha256: overview.provenance.source_manifest_sha256,
      source_unchanged: true,
      database_role: "memory_v1_report_login"
    }, null, 2));
  } else {
    throw new Error("Use generate or verify with a safe capture reference.");
  }
} finally {
  await store.close();
}

async function readTopicPlan(): Promise<TopicPlan> {
  const inline = process.env.HHS_INSPECTOR_TOPIC_PLAN_JSON?.trim();
  if (inline) return JSON.parse(inline) as TopicPlan;
  const argument = process.argv.indexOf("--topic-plan");
  if (argument >= 0 && process.argv[argument + 1]) {
    return JSON.parse(await readFile(process.argv[argument + 1]!, "utf8")) as TopicPlan;
  }
  throw new Error("A private topic plan is required through HHS_INSPECTOR_TOPIC_PLAN_JSON or --topic-plan.");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
