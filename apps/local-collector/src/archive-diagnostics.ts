import type { SafeDiagnosticMetadata } from "@hhs/capture-operations";
import { ArchiveCaptureError } from "@hhs/storage";

export function archiveFailureMetadata(error: unknown, archiveStarted = true): SafeDiagnosticMetadata {
  if (!archiveStarted) return { stage: "archive_failed_before_archive_started" };
  if (!(error instanceof ArchiveCaptureError)) return {};
  return {
    stage: `archive_failed_${error.diagnostic.stage}_${error.diagnostic.code}_cleanup_${error.diagnostic.cleanup}`
  };
}
