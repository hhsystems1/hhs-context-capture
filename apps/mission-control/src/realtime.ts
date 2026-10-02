import { createHash } from "node:crypto";

export class SnapshotFeed {
  private lastFingerprint = "";

  next(snapshot: Record<string, unknown>): string | null {
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (fingerprint === this.lastFingerprint) return null;
    this.lastFingerprint = fingerprint;
    return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }
}
