import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface Representation { kind: string; value: string; sha256: string; evidence_locator: string }
export interface ContentBlock { block_id: string; type: string; sequence: number; representations: Representation[] }
export interface CapturedMessage {
  message_id: string; platform_message_id?: string; role: string; sequence: number; parent_message_id?: string;
  representations: Representation[]; content_blocks: ContentBlock[];
}
export interface NormalizedCapture {
  capture: { capture_id: string; started_at: string; completed_at: string; adapter_version: string; status: string };
  platform: { id: string };
  account: { opaque_account_reference: string };
  conversation: { conversation_id: string; title: string };
  messages: CapturedMessage[];
  verification: { ruleset_version: string; status: string; checks: Array<Record<string, unknown>>; warnings?: string[] };
}
export interface VerifiedArchive {
  capturePath: string; normalized: NormalizedCapture; manifest: Record<string, any>; verificationReport: Record<string, any>;
  manifestSha256: string; archiveHashes: Map<string, string>;
}

export interface ApprovedArchiveLocation { archiveRoot: string; capturePath: string; captureId: string }

export async function loadApprovedArchive(location: ApprovedArchiveLocation): Promise<VerifiedArchive> {
  const { archiveRoot, captureId } = location;
  const root = path.resolve(archiveRoot);
  const capturePath = path.resolve(location.capturePath);
  const relative = path.relative(root, capturePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Approved capture path escapes archive root.");

  const [manifestBytes, normalizedBytes, verificationBytes, hashText] = await Promise.all([
    readFile(path.join(capturePath, "capture-manifest.json")),
    readFile(path.join(capturePath, "normalized", "conversation.json")),
    readFile(path.join(capturePath, "verification", "report.json")),
    readFile(path.join(capturePath, "hashes.sha256"), "utf8")
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, any>;
  const normalized = JSON.parse(normalizedBytes.toString("utf8")) as NormalizedCapture;
  const verificationReport = JSON.parse(verificationBytes.toString("utf8")) as Record<string, any>;
  if (manifest.capture?.capture_id !== captureId || normalized.capture.capture_id !== captureId) throw new Error("Capture identity is not the locally approved acceptance capture.");
  if (manifest.capture?.status !== "complete" || normalized.capture.status !== "complete" || verificationReport.capture_verification?.status !== "complete") throw new Error("Approved capture is not verified complete.");

  const archiveHashes = parseHashFile(hashText);
  const files = await listFiles(capturePath);
  const payloadFiles = files.filter((file) => path.basename(file) !== "hashes.sha256");
  if (payloadFiles.length !== archiveHashes.size) throw new Error("Archive hash listing does not cover every payload file.");
  for (const file of payloadFiles) {
    const relativeFile = path.relative(capturePath, file).split(path.sep).join("/");
    const expected = archiveHashes.get(relativeFile);
    const observed = digest(await readFile(file));
    if (!expected || expected !== observed) throw new Error(`Archive payload hash mismatch: ${relativeFile}`);
  }
  verifyRepresentations(normalized);
  assertContiguous(normalized.messages.map((message) => message.sequence));
  return { capturePath, normalized, manifest, verificationReport, manifestSha256: digest(manifestBytes), archiveHashes };
}

function parseHashFile(value: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of value.trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Malformed hashes.sha256 entry.");
    entries.set(match[2], match[1]);
  }
  return entries;
}

function verifyRepresentations(capture: NormalizedCapture): void {
  for (const message of capture.messages) {
    for (const representation of message.representations) verifyRepresentation(representation, `message ${message.sequence}`);
    for (const block of message.content_blocks) for (const representation of block.representations) verifyRepresentation(representation, `message ${message.sequence} block ${block.sequence}`);
  }
}

function verifyRepresentation(representation: Representation, label: string): void {
  if (digest(Buffer.from(representation.value, "utf8")) !== representation.sha256) throw new Error(`Representation hash mismatch in ${label}.`);
}

function assertContiguous(sequences: number[]): void {
  const sorted = [...sequences].sort((a, b) => a - b);
  if (sorted.some((sequence, index) => sequence !== index)) throw new Error("Message sequence is not contiguous from zero.");
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(full)); else if (entry.isFile()) output.push(full);
  }
  return output;
}

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
