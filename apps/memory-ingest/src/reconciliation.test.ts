import { describe, expect, it } from "vitest";
import {
  validateReconciliationOutput,
  type ReconciliationInput,
  type ReconciliationOutput
} from "./reconciliation.js";

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
