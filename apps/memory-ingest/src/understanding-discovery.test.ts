import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import {
  UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  UNDERSTANDING_INPUT_SCHEMA,
  UNDERSTANDING_OUTPUT_SCHEMA,
  suggestDiversePilot,
  splitDiscoveryExchange,
  validateDiscoveryOutput,
  type DiscoveryEvidence,
  type DiscoveryExchange,
  type DiscoveryObservationOutput,
  type DiscoveryOutput,
  type PilotCandidate,
  type TrustedDiscoveryModel
} from "./understanding-discovery.js";

const migration = await readFile(path.resolve("supabase/migrations/20260831130000_memory_v11_understanding_observations.sql"), "utf8");

function evidence(ref: string, role: string, text: string, sequence: number): DiscoveryEvidence {
  const hash = sha256(text);
  return {
    evidence_ref: ref, source_conversation_id: "clean-uuid", conversation_id: "conversation_clean",
    source_family: "native_export", source_version_id: "source_version_clean", capture_version_id: null,
    message_id: `message_${sequence}`, source_message_id: `source-message-${sequence}`, message_sequence: sequence,
    role, active_path: true, content_block_id: `block_${sequence}`, block_kind: "text",
    representation_kind: "canonical_text", text, representation_sha256: hash,
    source_record_id: `source_record_${sequence}`, immutable_evidence_locator: `hhs-export://zip/conversations.json#/clean/${sequence}`,
    source_record_sha256: hash, source_version_locator: "hhs-export://zip/conversations.json#/clean",
    source_container_sha256: "a".repeat(64), capture_locator: null, capture_manifest_sha256: null,
    resolution_id: `resolution_${sequence}`, resolution_expected_sha256: hash,
    resolution_observed_sha256: hash, resolution_exact: true, source_observed_at: "2026-01-06T00:00:00.000Z"
  };
}

const USER = evidence("ev-user", "user", "I prefer auditability and require exact source citations.", 0);
const ASSISTANT = evidence("ev-assistant", "assistant", "A possible theme is durable provenance.", 1);
const TRUSTED_MODEL: TrustedDiscoveryModel = {
  provider: "trusted-local-runner", name: "hermes-nemotron", version: "pilot-v1",
  runner_version: "deterministic-test-runner/0.2.0"
};
const EXCHANGE: DiscoveryExchange = {
  schema_version: UNDERSTANDING_INPUT_SCHEMA, pipeline_version: UNDERSTANDING_DISCOVERY_PIPELINE_VERSION,
  exchange_id: "discovery_exchange_fixture", evidence_sha256: sha256([USER, ASSISTANT]), created_at: "2026-01-06T00:00:00.000Z",
  selection: [{
    source_conversation_id: "clean-uuid", conversation_id: "conversation_clean", title: "Fixture", source_family: "native_export",
    observed_at: "2026-01-06T00:00:00.000Z", message_count: 2, content_characters: USER.text.length + ASSISTANT.text.length,
    source_version_id: "source_version_clean", content_sha256: "b".repeat(64), immutable_source_locator: "hhs-export://zip/conversations.json#/clean",
    source_container_sha256: "a".repeat(64), capture_version_id: null, capture_manifest_sha256: null, capture_locator: null
  }],
  evidence: [USER, ASSISTANT],
  model_instructions: {
    output_schema_version: UNDERSTANDING_OUTPUT_SCHEMA, observation_kinds_are_free_text: true,
    link_kinds_are_free_text: true, evidence_refs_are_authoritative: true,
    evidence_excerpts_are_optional: true, user_authority_requires_user_evidence: true,
    database_ids_or_hashes_required: false, model_metadata_required: false
  }
};

function observation(overrides: Partial<DiscoveryObservationOutput> = {}): DiscoveryObservationOutput {
  return {
    observation_ref: "o1", source_conversation_id: "clean-uuid",
    observation_kind: "emergent.auditability_preference", statement: "The user prefers auditability.",
    payload: { themes: ["auditability"], unresolved_questions: [] },
    attribution: { subject: "user", claim_type: "preference" }, confidence: 0.92,
    evidence: [{ evidence_ref: "ev-user" }], ...overrides
  };
}
function output(observations: DiscoveryObservationOutput[], links: DiscoveryOutput["links"] = []): DiscoveryOutput {
  return { schema_version: UNDERSTANDING_OUTPUT_SCHEMA, exchange_id: EXCHANGE.exchange_id, observations, links };
}

describe("understanding observation migration", () => {
  it("creates free-text observation and link kinds with HHS isolation and immutability conventions", () => {
    expect(migration).toMatch(/create table memory_v1\.observations/);
    expect(migration).toMatch(/create table memory_v1\.observation_links/);
    expect(migration).toMatch(/observation_kind text not null/);
    expect(migration).toMatch(/link_kind text not null/);
    const observationKindLine = migration.split("\n").find((line) => line.includes("observation_kind text"));
    const linkKindLine = migration.split("\n").find((line) => line.includes("link_kind text"));
    expect(observationKindLine).not.toMatch(/\bin\s*\(/i);
    expect(linkKindLine).not.toMatch(/\bin\s*\(/i);
    expect((migration.match(/force row level security/g) ?? [])).toHaveLength(2);
    expect((migration.match(/create trigger immutable_row_guard/g) ?? [])).toHaveLength(2);
    expect(migration).toMatch(/target_record_type in \('knowledge_candidate','source_evidence','observation'\)/);
  });
});

describe("provider-neutral discovery validation", () => {
  it("accepts arbitrary observation_kind and link_kind strings", () => {
    const second = observation({
      observation_ref: "o2", observation_kind: "novel.context.signal/from-model",
      statement: "Durable provenance is a possible theme.", attribution: { subject: "assistant", claim_type: "hypothesis" },
      evidence: [{ evidence_ref: "ev-assistant", excerpt: "possible theme is durable provenance" }]
    });
    const result = validateDiscoveryOutput(EXCHANGE, output([observation({ observation_ref: " o1 " }), second], [{
      from_observation_ref: " o1 ", to_observation_ref: "o2", link_kind: " novel.affinity/weak ",
      payload: { rationale: "shared provenance context" }, confidence: 0.7
    }]), TRUSTED_MODEL);
    expect(result.issues).toEqual([]);
    expect(result.valid?.observations.map((item) => item.observation_kind)).toEqual([
      "emergent.auditability_preference", "novel.context.signal/from-model"
    ]);
    expect(result.valid?.links[0]?.link_kind).toBe("novel.affinity/weak");
    expect(result.valid?.links[0]?.from_observation_ref).toBe("o1");
  });

  it("derives canonical evidence locally when excerpts are absent or imperfect", () => {
    const absent = validateDiscoveryOutput(EXCHANGE, output([observation()]), TRUSTED_MODEL);
    expect(absent.issues).toEqual([]);
    expect(absent.valid?.observations[0]?.citations[0]?.canonical_text).toBe(USER.text);
    expect(absent.valid?.observations[0]?.citations[0]?.canonical_text_sha256).toBe(sha256(USER.text));

    const imperfect = validateDiscoveryOutput(EXCHANGE, output([observation({
      evidence: [{ evidence_ref: "ev-user", excerpt: "I prefer auditability…" }]
    })]), TRUSTED_MODEL);
    expect(imperfect.issues).toEqual([]);
    expect(imperfect.valid?.observations[0]?.citations[0]?.excerpt).toBe("I prefer auditability…");
    expect(imperfect.valid?.observations[0]?.citations[0]?.canonical_text).toBe(USER.text);
  });

  it("rejects nonexistent evidence refs and hash-mismatched immutable evidence", () => {
    const missing = validateDiscoveryOutput(EXCHANGE, output([observation({
      evidence: [{ evidence_ref: "ev-invented" }]
    })]), TRUSTED_MODEL);
    expect(missing.issues.some((issue) => issue.problem.includes("unknown evidence_ref ev-invented"))).toBe(true);
    const corruptEvidence = [{ ...USER, resolution_observed_sha256: "0".repeat(64) }, ASSISTANT];
    const corrupt = { ...EXCHANGE, evidence: corruptEvidence, evidence_sha256: sha256(corruptEvidence) };
    const hashMismatch = validateDiscoveryOutput(corrupt, output([observation()]), TRUSTED_MODEL);
    expect(hashMismatch.issues.some((issue) => issue.problem.includes("hash resolution mismatch"))).toBe(true);
  });

  it("rejects an evidence ref from a different selected conversation", () => {
    const other = { ...ASSISTANT, evidence_ref: "ev-other", source_conversation_id: "other-uuid",
      conversation_id: "conversation_other", source_version_id: "source_version_other" };
    const expandedEvidence = [...EXCHANGE.evidence, other];
    const expanded: DiscoveryExchange = {
      ...EXCHANGE,
      selection: [...EXCHANGE.selection, { ...EXCHANGE.selection[0]!, source_conversation_id: "other-uuid",
        conversation_id: "conversation_other", title: "Other fixture", source_version_id: "source_version_other" }],
      evidence: expandedEvidence, evidence_sha256: sha256(expandedEvidence)
    };
    const result = validateDiscoveryOutput(expanded, output([observation({
      evidence: [{ evidence_ref: "ev-other" }]
    })]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem.includes("belongs to other-uuid, not observation conversation clean-uuid"))).toBe(true);
  });

  it("rejects assistant-only evidence for user-authority decisions", () => {
    const result = validateDiscoveryOutput(EXCHANGE, output([observation({
      observation_kind: "decision", statement: "The user decided that provenance must be durable.",
      attribution: { subject: "user", claim_type: "decision" },
      evidence: [{ evidence_ref: "ev-assistant" }]
    })]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem.includes("requires user-authored evidence"))).toBe(true);
  });

  it("does not let a conflicting attribution label bypass explicit user-authority language", () => {
    const result = validateDiscoveryOutput(EXCHANGE, output([observation({
      observation_kind: "miscellaneous", statement: "Stephen decided that provenance must be durable.",
      attribution: { subject: "assistant", claim_type: "summary" },
      evidence: [{ evidence_ref: "ev-assistant" }]
    })]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem.includes("requires user-authored evidence"))).toBe(true);
  });

  it("does not mistake Product Direction for a user directive", () => {
    const result = validateDiscoveryOutput(EXCHANGE, output([observation({
      observation_kind: "team_structure",
      statement: "Stephen Curry is responsible for Vision, Strategy, and Product Direction.",
      attribution: { subject: "assistant", claim_type: "team_proposal" },
      evidence: [{ evidence_ref: "ev-assistant" }]
    })]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem.includes("requires user-authored evidence"))).toBe(false);
  });

  it("rejects evidence outside the selected clean exchange", () => {
    const result = validateDiscoveryOutput(EXCHANGE, output([observation({
      source_conversation_id: "held-needs-review", attribution: { subject: "assistant", claim_type: "finding" },
      evidence: [{ evidence_ref: "held" }]
    })]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem.includes("outside this exchange"))).toBe(true);
  });

  it("uses trusted runner metadata and ignores model-supplied spoofing", () => {
    const spoofed = { ...output([observation()]), model: {
      provider: "spoofed-provider", name: "spoofed-model", runner_version: "spoofed-runner"
    } } as unknown as DiscoveryOutput;
    const result = validateDiscoveryOutput(EXCHANGE, spoofed, TRUSTED_MODEL);
    expect(result.issues).toEqual([]);
    expect(result.valid?.trusted_model).toEqual(TRUSTED_MODEL);
    expect(result.valid?.trusted_model.provider).not.toBe("spoofed-provider");
  });

  it("rejects links whose exchange-local observation aliases do not resolve", () => {
    const result = validateDiscoveryOutput(EXCHANGE, output([observation()], [{
      from_observation_ref: "missing", to_observation_ref: "o1", link_kind: "relates", payload: {}
    }]), TRUSTED_MODEL);
    expect(result.issues.some((issue) => issue.problem === "from_observation_ref 'missing' is unknown or invalid")).toBe(true);
  });
});


describe("deterministic oversized discovery splitting", () => {
  it("preserves every evidence row and keeps all blocks from one message together", () => {
    const secondUserBlock: DiscoveryEvidence = {
      ...USER,
      evidence_ref: "ev-user-second-block",
      content_block_id: "block_0_second",
      source_record_id: "source_record_0_second"
    };
    const expanded: DiscoveryExchange = {
      ...EXCHANGE,
      evidence: [USER, secondUserBlock, ASSISTANT],
      evidence_sha256: sha256([USER, secondUserBlock, ASSISTANT])
    };
    const firstMessageCharacters = [USER, secondUserBlock].reduce(
      (sum, row) => sum + JSON.stringify(row).length,
      0
    );

    const chunks = splitDiscoveryExchange(expanded, firstMessageCharacters);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.exchange.evidence.map((row) => row.evidence_ref))
      .toEqual(["ev-user", "ev-user-second-block"]);
    expect(chunks.flatMap((chunk) => chunk.exchange.evidence))
      .toEqual(expanded.evidence);
    expect(new Set(chunks.map((chunk) => chunk.exchange.exchange_id)).size)
      .toBe(chunks.length);
    expect(splitDiscoveryExchange(expanded, firstMessageCharacters))
      .toEqual(chunks);
  });

  it("produces independently valid child exchanges", () => {
    const chunks = splitDiscoveryExchange(EXCHANGE, JSON.stringify(USER).length);

    for (const chunk of chunks) {
      const row = chunk.exchange.evidence[0]!;
      const candidate: DiscoveryOutput = {
        schema_version: UNDERSTANDING_OUTPUT_SCHEMA,
        exchange_id: chunk.exchange.exchange_id,
        observations: [{
          observation_ref: "chunk-observation",
          source_conversation_id: row.source_conversation_id,
          observation_kind: "chunk_finding",
          statement: "This chunk contains one evidence-supported finding.",
          payload: {},
          attribution: {
            subject: row.role === "user" ? "user" : "assistant",
            claim_type: "finding"
          },
          confidence: 0.9,
          evidence: [{ evidence_ref: row.evidence_ref }]
        }],
        links: []
      };
      expect(validateDiscoveryOutput(chunk.exchange, candidate, TRUSTED_MODEL).issues)
        .toEqual([]);
    }
  });

  it("surfaces a single message that exceeds the target without splitting it", () => {
    const chunks = splitDiscoveryExchange(EXCHANGE, 1);

    expect(chunks.every((chunk) => chunk.exceeds_target)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.exchange.evidence)).toEqual(EXCHANGE.evidence);
  });
});

describe("pilot metadata selection", () => {
  it("round-robins across source, month, and length without reading content", () => {
    const candidates: PilotCandidate[] = [
      ["a", "native_export", "2025-01-01", 100], ["b", "native_export", "2025-02-01", 10_000],
      ["c", "browser_capture", "2026-08-01", 40_000], ["d", "native_export", "2025-01-02", 200]
    ].map(([id, family, date, chars], index) => ({ source_conversation_id: String(id), title: String(id),
      source_family: String(family), observed_at: `${String(date)}T00:00:00.000Z`, message_count: index + 1,
      content_characters: Number(chars) }));
    const selected = suggestDiversePilot(candidates, 3);
    expect(selected).toHaveLength(3);
    expect(new Set(selected.map((item) => item.source_family)).size).toBe(2);
  });
});
