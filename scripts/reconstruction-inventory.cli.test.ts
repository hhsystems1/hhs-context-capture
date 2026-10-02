/**
 * Receipt-loading contract for the reconstruction inventory CLI.
 *
 * Every case here fails (or reports) before any database handle is opened, so
 * the argv/receipt boundary is proven without Postgres. The CLI is spawned with
 * no MEMORY_* connection variables on purpose: if a case ever reached the read
 * model it would surface as the connection-variable error, not a pass.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import {
  UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  UNDERSTANDING_INPUT_SCHEMA,
  UNDERSTANDING_OUTPUT_SCHEMA,
  type DiscoveryEvidence,
  type DiscoveryExchange,
  type DiscoveryOutput
} from "../apps/memory-ingest/src/understanding-discovery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "scripts", "reconstruction-inventory.ts");
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const NO_DATABASE_ENV = "MEMORY_REPORT_DATABASE_URL is required";

/** Runs the CLI and returns its exit state plus streams; never throws on failure. */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [TSX, CLI, ...args], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Writes a validator-passing exchange/output pair covering `sourceIds`. */
function writePair(directory: string, name: string, exchangeId: string, sourceIds: string[]): { exchange: string; output: string } {
  const evidence = sourceIds.map((sourceId): DiscoveryEvidence => {
    const text = `Bounded CLI fixture evidence for ${sourceId}.`;
    const hash = sha256(text);
    return {
      evidence_ref: `${sourceId}-evidence`, source_conversation_id: sourceId, conversation_id: `${sourceId}-conversation`,
      source_family: "native_export", source_version_id: `${sourceId}-version`, capture_version_id: null,
      message_id: `${sourceId}-message`, source_message_id: `${sourceId}-source-message`, message_sequence: 0,
      role: "assistant", active_path: true, content_block_id: `${sourceId}-block`, block_kind: "text",
      representation_kind: "canonical_text", text, representation_sha256: hash,
      source_record_id: `${sourceId}-record`, immutable_evidence_locator: "fixture://message", source_record_sha256: hash,
      source_version_locator: "fixture://conversation", source_container_sha256: "a".repeat(64), capture_locator: null,
      capture_manifest_sha256: null, resolution_id: `${sourceId}-resolution`, resolution_expected_sha256: hash,
      resolution_observed_sha256: hash, resolution_exact: true, source_observed_at: "2026-01-01T00:00:00.000Z"
    };
  });
  const exchange: DiscoveryExchange = {
    schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
    exchange_id: exchangeId, evidence_sha256: sha256(evidence), created_at: "2026-01-01T00:00:00.000Z",
    selection: sourceIds.map((sourceId, index) => ({ source_conversation_id: sourceId, conversation_id: `${sourceId}-conversation`,
      title: `Fixture ${index + 1}`, source_family: "native_export", observed_at: "2026-01-01T00:00:00.000Z", message_count: 1,
      content_characters: evidence[index]!.text.length, source_version_id: `${sourceId}-version`, content_sha256: "b".repeat(64),
      immutable_source_locator: "fixture://conversation", source_container_sha256: "a".repeat(64),
      capture_version_id: null, capture_manifest_sha256: null, capture_locator: null })), evidence,
    model_instructions: { output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
      link_kinds_are_free_text: true, evidence_refs_are_authoritative: true, evidence_excerpts_are_optional: true,
      user_authority_requires_user_evidence: true, database_ids_or_hashes_required: false, model_metadata_required: false }
  };
  const output: DiscoveryOutput = {
    schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: exchangeId,
    observations: sourceIds.map((sourceId, index) => ({ observation_ref: `o${index + 1}`, source_conversation_id: sourceId,
      observation_kind: "free kind", statement: `The assistant offers a provisional finding for ${sourceId}.`, payload: {},
      attribution: { subject: "assistant" as const, claim_type: "finding" }, confidence: 0.8,
      evidence: [{ evidence_ref: `${sourceId}-evidence` }] })), links: []
  };
  const exchangePath = path.join(directory, `${name}-input.json`);
  const outputPath = path.join(directory, `${name}-output.json`);
  writeFileSync(exchangePath, JSON.stringify(exchange), "utf8");
  writeFileSync(outputPath, JSON.stringify(output), "utf8");
  return { exchange: exchangePath, output: outputPath };
}

function sources(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

describe("reconstruction inventory CLI receipt loading", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hhs-receipt-cli-"));
  const five = writePair(directory, "pilot", "exchange-pilot-five", sources("pilot", 5));
  const ten = writePair(directory, "batch-001", "exchange-batch-001-ten", sources("batch", 10));

  it("loads a five-conversation receipt with membership taken from the exchange", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db", "--receipt-exchange", five.exchange, "--receipt-output", five.output]);
    expect(result.stderr).toContain("RECONSTRUCTION_RECEIPT_LOADED=exchange-pilot-five conversations=5");
    expect(result.stderr).toContain(NO_DATABASE_ENV);
  });

  it("loads a ten-conversation receipt, so five is no longer required", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db", "--receipt-exchange", ten.exchange, "--receipt-output", ten.output]);
    expect(result.stderr).toContain("RECONSTRUCTION_RECEIPT_LOADED=exchange-batch-001-ten conversations=10");
    expect(result.stderr).not.toMatch(/exactly 5 conversations/);
    expect(result.stderr).toContain(NO_DATABASE_ENV);
  });

  it("pairs repeatable receipt flags positionally", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db",
      "--receipt-exchange", five.exchange, "--receipt-output", five.output,
      "--receipt-exchange", ten.exchange, "--receipt-output", ten.output]);
    const loaded = result.stderr.split("\n").filter((line) => line.startsWith("RECONSTRUCTION_RECEIPT_LOADED="));
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toContain("exchange-pilot-five conversations=5");
    expect(loaded[1]).toContain("exchange-batch-001-ten conversations=10");
  });

  it("still accepts the original pilot flag spellings", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db", "--pilot-exchange", ten.exchange, "--pilot-output", ten.output]);
    expect(result.stderr).toContain("RECONSTRUCTION_RECEIPT_LOADED=exchange-batch-001-ten conversations=10");
  });

  it("reports when no receipts are supplied rather than assuming one", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db"]);
    expect(result.stderr).toContain("RECONSTRUCTION_RECEIPTS_LOADED=0");
    expect(result.stderr).not.toContain("RECONSTRUCTION_RECEIPT_LOADED=");
  });

  it("refuses an unpaired receipt flag", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db", "--receipt-exchange", five.exchange]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/observed 1 exchange\(s\) and 0 output\(s\)/);
    expect(result.stderr).not.toContain(NO_DATABASE_ENV);
  });

  it("refuses an artifact pair the trusted validator rejects, naming the files", () => {
    const mismatched = path.join(directory, "mismatched-output.json");
    writeFileSync(mismatched, JSON.stringify({ ...JSON.parse(readFileSync(five.output, "utf8")), exchange_id: "invented" }), "utf8");
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db", "--receipt-exchange", five.exchange, "--receipt-output", mismatched]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Discovery receipt rejected");
    expect(result.stderr).toContain(mismatched);
    expect(result.stderr).toMatch(/receipt is invalid/);
    expect(result.stderr).not.toContain(NO_DATABASE_ENV);
  });

  it("refuses the same exchange supplied twice instead of double counting it", () => {
    const result = runCli(["report", "--workspace", "proof-workspace-5plus2-db",
      "--receipt-exchange", ten.exchange, "--receipt-output", ten.output,
      "--receipt-exchange", ten.exchange, "--receipt-output", ten.output]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Exchange exchange-batch-001-ten was supplied twice");
    expect(result.stderr).not.toContain(NO_DATABASE_ENV);
  });

  it("still requires an explicit workspace and a known command", () => {
    expect(runCli(["report"]).stderr).toMatch(/--workspace is required/);
    expect(runCli(["reconcile", "--workspace", "proof-workspace-5plus2-db"]).stderr).toMatch(/Usage: reconstruction-inventory\.ts <json\|report>/);
  });
});
