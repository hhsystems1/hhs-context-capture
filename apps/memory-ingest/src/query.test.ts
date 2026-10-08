import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@hhs/memory-schema";
import { createPool, type DbClient } from "./db.js";
import { immutableRow } from "./review.js";
import { APPROVED_KNOWLEDGE_QUERY_SQL, getApprovedKnowledgeFromClient, queryApprovedKnowledge } from "./query.js";

vi.mock("./db.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./db.js")>(), createPool: vi.fn()
}));

const querySource = await readFile(path.resolve("apps/memory-ingest/src/query.ts"), "utf8");

describe("approved-knowledge query", () => {
  it("is fully parameterized deterministic text search", () => {
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/plainto_tsquery\('english', \$2\)/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/ak\.workspace_id = \$1/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/limit \$3/);
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).not.toMatch(/\$\{/);
  });

  it("selects only approved knowledge and resolves exact provenance to the immutable archive", () => {
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/from memory_v1\.approved_knowledge ak/);
    for (const column of ["approved_knowledge_id", "immutable_archive_locator", "source_conversation_id", "message_id", "provenance_edge_id", "representation_sha256", "reviewer_id"]) {
      expect(APPROVED_KNOWLEDGE_QUERY_SQL).toContain(column);
    }
    expect(APPROVED_KNOWLEDGE_QUERY_SQL).toMatch(/rep->>'sha256' = pe\.representation_sha256/);
  });

  it("uses only the read-only report role", () => {
    expect(querySource).toMatch(/createPool\("reader"\)/);
    expect(querySource).not.toMatch(/createPool\("(admin|writer|reviewer)"\)/);
    expect(querySource).toMatch(/readOnlyTransaction/);
  });

  it("never mutates state", () => {
    expect(querySource).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it("queries reviewed promoted knowledge in the requested read-only workspace and returns receipt lineage", async () => {
    const workspace = "workspace_requested";
    const match = { approved_knowledge_id: "approved", knowledge_candidate_id: "candidate",
      reviewer_id: "human", review_status: "approved", text_value: "approved promoted statement",
      provenance_edge_id: null, promotion_receipt_id: "receipt",
      source_lineage: [{ source_workspace_id: "source", reconciliation_id: "reconciled" }],
      source_lineage_sha256: "a".repeat(64), promoted_value_sha256: "b".repeat(64) };
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === APPROVED_KNOWLEDGE_QUERY_SQL) expect(parameters?.[0]).toBe(workspace);
      return { rows: sql === APPROVED_KNOWLEDGE_QUERY_SQL ? [match] : [], rowCount: 1 };
    });
    const release = vi.fn();
    const end = vi.fn();
    vi.mocked(createPool).mockReturnValue({ connect: async () => ({ query, release }), end } as unknown as ReturnType<typeof createPool>);
    const result = await queryApprovedKnowledge(workspace, "  promoted statement  ", 200);
    expect(createPool).toHaveBeenCalledWith("reader");
    expect(query.mock.calls).toEqual([
      ["begin read only"], ["select set_config('memory_v1.workspace_id',$1,true)", [workspace]],
      [APPROVED_KNOWLEDGE_QUERY_SQL, [workspace, "promoted statement", 100]], ["commit"]
    ]);
    expect(result).toMatchObject({ trust_scope: "approved_knowledge_only", matches: [match] });
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    const branches = APPROVED_KNOWLEDGE_QUERY_SQL.split("union all");
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch).toContain("ak.workspace_id = $1");
      expect(branch).toContain("hre.workspace_id=ak.workspace_id");
    }
    expect(branches[1]).toContain("hre.to_status='approved'");
    expect(branches[1]).toContain("(p.workspace_id,p.promotion_receipt_id,p.pipeline_version)=(k.workspace_id,k.promotion_receipt_id,k.pipeline_version)");
  });

  it("loads approved promotion detail with its immutable receipt and without fabricating local evidence", async () => {
    const workspace = "destination";
    const value = { statement: "reviewed statement" };
    const lineage = [{ source_workspace_id: "source", reconciliation_id: "reconciliation", record_sha256: "a".repeat(64) }];
    const receipt = immutableRow("promotion_receipt", workspace, ["receipt"], {
      workspace_id: workspace, promotion_receipt_id: "receipt", pipeline_version: "p", kind: "claim",
      promoted_value: value, promoted_value_sha256: sha256(value), source_lineage: lineage,
      source_lineage_sha256: sha256(lineage), created_at: "2026-10-01T00:00:00.000Z"
    });
    const approved = { approved_knowledge_id: "approved", knowledge_candidate_id: "candidate", approval_event_id: "review", approved_value: value };
    const review = { human_review_event_id: "review", reviewer_id: "human", to_status: "approved" };
    const candidate = { knowledge_candidate_id: "candidate", promotion_receipt_id: "receipt", pipeline_version: "p",
      kind: "claim", proposed_value: value, proposed_value_sha256: sha256(value) };
    const query = vi.fn(async (sql: string, parameters: unknown[]) => {
      expect(parameters[0]).toBe(workspace);
      if (sql.includes("from memory_v1.promotion_receipts")) return { rows: [receipt], rowCount: 1 };
      if (sql.includes("from memory_v1.knowledge_candidates")) return { rows: [candidate], rowCount: 1 };
      if (sql.includes("from memory_v1.human_review_events")) return { rows: [review], rowCount: 1 };
      if (sql.includes("join memory_v1.candidate_evidence")) return { rows: [], rowCount: 0 };
      return { rows: [approved], rowCount: 1 };
    });
    const detail = await getApprovedKnowledgeFromClient({ query } as unknown as DbClient, workspace, "approved");
    expect(detail).toEqual({ approved_knowledge: approved, review, evidence: [], promotion_receipt: receipt });
    expect(query).toHaveBeenLastCalledWith(
      "select * from memory_v1.promotion_receipts where workspace_id=$1 and promotion_receipt_id=$2 and pipeline_version=$3",
      [workspace, "receipt", "p"]
    );
  });
});
