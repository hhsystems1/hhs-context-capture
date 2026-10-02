import { describe, expect, it } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import { validateProposals, type EvidenceBlockRow, type ExtractionInput, type ExtractionProposal } from "./extraction.js";

function block(sequence: number, role: string, text: string): EvidenceBlockRow {
  return {
    message_id: `message_m${sequence}`, source_message_id: `src-${sequence}`, sequence, role,
    content_block_id: `block_b${sequence}`, source_record_id: `source_record_s${sequence}`,
    immutable_evidence_locator: `hhs-archive://capture/test/block/${sequence}`,
    representation_sha256: sha256(text), canonical_text: text, capture_version_id: "capture_version_x"
  };
}

const EVIDENCE = new Map<number, EvidenceBlockRow[]>([
  [0, [block(0, "user", "Please always verify hashes before trusting archives. This is a standing requirement.")]],
  [1, [block(1, "assistant", "Finding: the verifier stamps a fixed message regardless of status.")]],
  [2, [block(2, "tool", "tool_call exec ls -la")]]
]);

function proposal(overrides: Partial<ExtractionProposal>): ExtractionProposal {
  return {
    proposal_id: "p1", extraction_type: "technical_finding",
    statement: "The verifier stamps a fixed message regardless of status.",
    attribution: "assistant_finding", confidence: "high",
    worth_preserving: "Explains misleading verifier output.",
    evidence: [{ sequence: 1, quote: "the verifier stamps a fixed message regardless of status" }],
    ...overrides
  };
}
function input(...proposals: ExtractionProposal[]): ExtractionInput {
  return { source_conversation_id: "src-conv", extraction_model: "test-model", extractor_version: "t1", proposals };
}

describe("validateProposals", () => {
  it("accepts a valid assistant finding with verbatim quote", () => {
    const { valid, issues } = validateProposals(input(proposal({})), EVIDENCE);
    expect(issues).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.citations[0]!.block.message_id).toBe("message_m1");
  });

  it("accepts multiple distinct candidates supported by the same evidence message", () => {
    const { valid, issues } = validateProposals(input(
      proposal({ proposal_id: "same-message-a" }),
      proposal({ proposal_id: "same-message-b", statement: "The fixed verifier message can mislead audit readers." })
    ), EVIDENCE);
    expect(issues).toEqual([]);
    expect(valid).toHaveLength(2);
    expect(valid.every((item) => item.citations[0]!.block.sequence === 1)).toBe(true);
  });

  it("rejects quotes that are not verbatim in the cited sequence", () => {
    const { valid, issues } = validateProposals(input(proposal({ evidence: [{ sequence: 1, quote: "verifier stamps a DIFFERENT message" }] })), EVIDENCE);
    expect(valid).toHaveLength(0);
    expect(issues[0]!.problem).toMatch(/quote not found verbatim/);
  });

  it("rejects citations of unknown sequences", () => {
    const { issues } = validateProposals(input(proposal({ evidence: [{ sequence: 99, quote: "x" }] })), EVIDENCE);
    expect(issues[0]!.problem).toMatch(/sequence 99 not in evidence/);
  });

  it("rejects evidence whose canonical representation does not resolve to its stored hash", () => {
    const corrupted = new Map(EVIDENCE);
    corrupted.set(1, [{ ...EVIDENCE.get(1)![0]!, representation_sha256: "0".repeat(64) }]);
    const { valid, issues } = validateProposals(input(proposal({})), corrupted);
    expect(valid).toHaveLength(0);
    expect(issues.some((issue) => issue.problem.includes("representation hash mismatch"))).toBe(true);
  });

  it("refuses to promote assistant text to Stephen authority (decision/requirement/sop need user evidence)", () => {
    for (const extraction_type of ["decision", "requirement", "sop"] as const) {
      const { valid, issues } = validateProposals(input(proposal({ extraction_type, evidence: [{ sequence: 1, quote: "the verifier stamps a fixed message" }] })), EVIDENCE);
      expect(valid).toHaveLength(0);
      expect(issues.some((i) => i.problem.includes("user-role evidence"))).toBe(true);
    }
  });

  it("refuses stephen_directive attribution without user evidence regardless of type", () => {
    const { valid, issues } = validateProposals(input(proposal({ attribution: "stephen_directive" })), EVIDENCE);
    expect(valid).toHaveLength(0);
    expect(issues.some((i) => i.problem.includes("user-role evidence"))).toBe(true);
  });

  it("accepts a requirement citing a user message", () => {
    const { valid, issues } = validateProposals(input(proposal({
      extraction_type: "requirement", attribution: "stephen_directive",
      statement: "Always verify hashes before trusting archives.",
      evidence: [{ sequence: 0, quote: "always verify hashes before trusting archives" }]
    })), EVIDENCE);
    expect(issues).toEqual([]);
    expect(valid).toHaveLength(1);
  });

  it("deduplicates repeated statements", () => {
    const { valid, issues } = validateProposals(input(
      proposal({}),
      proposal({ proposal_id: "p2", statement: "  the VERIFIER stamps a fixed   message regardless of status. " })
    ), EVIDENCE);
    expect(valid).toHaveLength(1);
    expect(issues.some((i) => i.problem.includes("duplicate statement of p1"))).toBe(true);
  });

  it("requires rationale, confidence, attribution, evidence, and known type", () => {
    const { issues } = validateProposals(input(proposal({
      proposal_id: "bad", extraction_type: "vibes" as never, statement: "", worth_preserving: "",
      confidence: "certain" as never, attribution: "me" as never, evidence: []
    })), EVIDENCE);
    const text = issues.map((i) => i.problem).join("|");
    expect(text).toMatch(/unknown extraction_type/);
    expect(text).toMatch(/empty statement/);
    expect(text).toMatch(/missing worth_preserving/);
    expect(text).toMatch(/invalid confidence/);
    expect(text).toMatch(/invalid attribution/);
    expect(text).toMatch(/no supporting evidence/);
  });

  it("rejects duplicate proposal ids", () => {
    const { issues } = validateProposals(input(proposal({}), proposal({ statement: "Different statement." })), EVIDENCE);
    expect(issues.some((i) => i.problem.includes("duplicate proposal_id"))).toBe(true);
  });
});
