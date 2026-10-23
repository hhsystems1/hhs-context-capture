import { describe, expect, it } from "vitest";
import {
  validateReconciliationOutput,
  statementOccursInEvidence,
  STATEMENT_EVIDENCE_OVERLAP,
  type ReconciliationInput,
  type ReconciliationOutput
} from "./reconciliation.js";

describe("statement-bearing evidence", () => {
  it("recognizes a genuine Sidekick paraphrase rather than requiring containment", () => {
    expect(statementOccursInEvidence("User requested a complete master context, profile, and business plan for the Sidekick app, describing it as 'next door mixed with yelp, read it, remember all this' and asking for every idea.",
      "Give me a complete master context, profile business plan app idea for the sidekick app down to every idea. That's been around it right the next door mixed with yelp, read it, remember all this")).toBe(true);
  });
  it("refuses unrelated content and empty statements", () => {
    expect(statementOccursInEvidence("The company decided to adopt Salesforce.", "Give me a complete master context for Sidekick.")).toBe(false);
    expect(statementOccursInEvidence("", "Give me a complete master context for Sidekick.")).toBe(false);
  });
  it("refuses overlap just below the fixed threshold", () => {
    expect(STATEMENT_EVIDENCE_OVERLAP).toBe(0.5);
    expect(statementOccursInEvidence("alpha beta gamma delta epsilon", "alpha beta zeta")).toBe(false);
  });
  it("accepts the threshold and a matching quoted span below lexical overlap", () => {
    expect(statementOccursInEvidence("alpha beta gamma delta", "alpha beta zeta")).toBe(true);
    expect(statementOccursInEvidence('Requested "alpha beta" alongside gamma delta epsilon zeta eta theta.', "alpha beta")).toBe(true);
  });
});

const INPUT: ReconciliationInput = {
  schema_version: "hhs-reconciliation-input/0.1.0",
  pipeline_version: "memory-reconciliation/0.1.0",
  source_workspace_id: "proof-workspace-5plus2-db",
  observations: [
    {
      observation_id: "observation_user_decision",
      pipeline_version: "memory-understanding-discovery/0.2.0",
      observation_kind: "decision",
      statement: "The user decided HHS Core 2 will be the business OS.",
      attribution: { subject: "user", claim_type: "decision" },
      created_at: "2026-09-01T00:00:00.000Z",
      evidence_roles: ["user"],
      evidence: [{ role: "user", relation: "quotes", statement_bearing: true }],
      record_sha256: "a".repeat(64)
    },
    {
      observation_id: "observation_old_plan",
      pipeline_version: "memory-understanding-discovery/0.2.0",
      observation_kind: "architecture",
      statement: "GoHighLevel could serve as the central CRM.",
      attribution: { subject: "assistant", claim_type: "proposal" },
      created_at: "2026-01-01T00:00:00.000Z",
      evidence_roles: ["assistant"],
      evidence: [{ role: "assistant", relation: "quotes", statement_bearing: true }],
      record_sha256: "b".repeat(64)
    }
  ]
};

function output(overrides: Partial<ReconciliationOutput> = {}): ReconciliationOutput {
  return {
    schema_version: "hhs-reconciliation-output/0.1.0",
    source_workspace_id: INPUT.source_workspace_id,
    reconciliations: [
      {
        reconciliation_ref: "r1",
        kind: "decision",
        statement: "HHS Core 2 is the current business OS.",
        authority: "user",
        temporal_status: "current",
        destination: {
          brain_type: "organization",
          target_ref: "HHS"
        },
        observations: [
          {
            observation_id: "observation_user_decision",
            relation: "supports"
          },
          {
            observation_id: "observation_old_plan",
            relation: "supersedes"
          }
        ]
      }
    ],
    ...overrides
  };
}

describe("reconciliation validation", () => {
  it("refuses company authority on assistant-only evidence at reconciliation time", () => {
    const candidate = output();
    candidate.reconciliations[0]!.authority = "company";
    candidate.reconciliations[0]!.observations = [{ observation_id: "observation_old_plan", relation: "supports" }];
    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.valid).toBeUndefined();
    expect(result.issues.some((issue) => /company authority requires user-authored evidence/.test(issue.problem))).toBe(true);
  });

  it("refuses mixed-citation forgery that the aggregate role gate accepted", () => {
    const input = structuredClone(INPUT);
    input.observations[0]!.evidence_roles = ["assistant", "user"];
    input.observations[0]!.evidence = [
      { role: "assistant", relation: "quotes", statement_bearing: true },
      { role: "user", relation: "quotes", statement_bearing: false }
    ];
    expect(validateReconciliationOutput(input, output()).valid).toBeUndefined();
  });

  it.each(["assistant", "source", "mixed", "unresolved"] as const)("preserves %s authority", (authority) => {
    const candidate = output();
    candidate.reconciliations[0]!.authority = authority;
    candidate.reconciliations[0]!.observations = [{ observation_id: "observation_old_plan", relation: "supports" }];
    expect(validateReconciliationOutput(INPUT, candidate).issues).toEqual([]);
  });
  it("accepts a current user-authority decision backed by user-authored evidence", () => {
    const result = validateReconciliationOutput(INPUT, output());
    expect(result.issues).toEqual([]);
    expect(result.valid?.reconciliations).toHaveLength(1);
  });

  it("rejects observation ids that were not present in the trusted input", () => {
    const candidate = output();
    candidate.reconciliations[0]!.observations = [
      { observation_id: "invented-observation", relation: "supports" }
    ];

    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.issues.some((issue) =>
      issue.problem.includes("unknown observation_id")
    )).toBe(true);
  });

  it("rejects user authority without user-authored evidence", () => {
    const candidate = output();
    candidate.reconciliations[0]!.observations = [
      { observation_id: "observation_old_plan", relation: "supports" }
    ];

    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.issues.some((issue) =>
      issue.problem.includes("user authority requires user-authored evidence")
    )).toBe(true);
  });

  it("rejects a destination brain outside the allowed scopes", () => {
    const candidate = output();
    candidate.reconciliations[0]!.destination = {
      brain_type: "global" as "organization",
      target_ref: "everything"
    };

    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.issues.some((issue) =>
      issue.problem.includes("invalid destination brain_type")
    )).toBe(true);
  });

  it("rejects unsupported reconciliation relations", () => {
    const candidate = output();
    candidate.reconciliations[0]!.observations = [
      {
        observation_id: "observation_user_decision",
        relation: "kind_of_related" as "supports"
      }
    ];

    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.issues.some((issue) =>
      issue.problem.includes("invalid observation relation")
    )).toBe(true);
  });

  it("does not let assistant proposals become user decisions", () => {
    const candidate = output({
      reconciliations: [
        {
          reconciliation_ref: "r1",
          kind: "decision",
          statement: "The user decided GoHighLevel will be the central CRM.",
          authority: "user",
          temporal_status: "current",
          destination: {
            brain_type: "organization",
            target_ref: "HHS"
          },
          observations: [
            {
              observation_id: "observation_old_plan",
              relation: "supports"
            }
          ]
        }
      ]
    });

    const result = validateReconciliationOutput(INPUT, candidate);
    expect(result.issues.some((issue) =>
      issue.problem.includes("user authority requires user-authored evidence")
    )).toBe(true);
  });
});
