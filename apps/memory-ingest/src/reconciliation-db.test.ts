import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedReconciliationFixture, seedLegacyReviewFixture } from "./reconciliation-proof-fixture.js";
import { readFile } from "node:fs/promises";
import { deterministicId, idempotencyKey, sha256 } from "@hhs/memory-schema";
import { createPool, immutableInsert } from "./db.js";
import { preparePromotionFromClient, promoteReconciliationFromClient, promotionImmutableInsert } from "./promotion.js";
import { resolvePromotionEvidenceFromClient, PROMOTION_EXCERPT_LIMIT } from "./promotion.js";
import { PENDING_REVIEWS_SQL } from "../../mission-control/src/store.js";
import { recordDecisionFromClient, showCandidateFromClient, listProposedCandidatesFromClient } from "./review.js";
import { APPROVED_KNOWLEDGE_QUERY_SQL, getApprovedKnowledgeFromClient } from "./query.js";
import {
  prepareReconciliationInputFromClient,
  persistValidatedReconciliation,
  validateReconciliationOutput,
  type ReconciliationOutput
} from "./reconciliation.js";

const enabled =
  process.env.HHS_RUN_RECONCILIATION_DB_PROOF === "1" &&
  Boolean(process.env.MEMORY_DATABASE_URL);

const suite = enabled ? describe : describe.skip;

const WORKSPACE = "reconciliation-layer-rollback-proof";
const pool = enabled ? createPool("admin") : undefined;
const writerPool = enabled ? createPool("writer") : undefined;
const readerPool = enabled ? createPool("reader") : undefined;
const reviewerPool = enabled ? createPool("reviewer") : undefined;
let protectedWorkspaceBefore: unknown;

async function protectedWorkspaceFingerprint() {
  const tables = ["workspaces", "source_records", "source_versions", "capture_versions", "conversations", "messages", "content_blocks",
    "observations", "observation_links", "provenance_edges", "message_range_chunks", "knowledge_candidates", "candidate_evidence", "human_review_events", "approved_knowledge", "reconciliations", "reconciliation_observations", "promotion_receipts"];
  return (await pool!.query(tables.map((table) => `select '${table}' as table_name, count(*)::int as rows,
    md5(coalesce(string_agg(to_jsonb(t)::text,'' order by t.idempotency_key),'')) as fingerprint
    from memory_v1.${table} t where t.workspace_id=$1`).join(" union all ") + " order by table_name", ["proof-workspace-5plus2-db"])).rows;
}

beforeAll(async () => {
  if (enabled) protectedWorkspaceBefore = await protectedWorkspaceFingerprint();
});

afterAll(async () => {
  try {
    if (enabled) expect(await protectedWorkspaceFingerprint()).toEqual(protectedWorkspaceBefore);
  } finally { await Promise.all([pool?.end(), writerPool?.end(), readerPool?.end(), reviewerPool?.end()]); }
});

suite("database-backed reconciliation layer", () => {
  it("completes the actual proposed counter within two seconds on real workspaces", async () => {
    const source = await readFile("apps/mission-control/src/store.ts","utf8");
    const proposed = source.match(/\(select count\(\*\) from [^\n]+\) proposed,/)![0].replace(/,$/,"");
    const client = await readerPool!.connect();
    try {
      for (const workspace of ["workspace_hhs_memory_v1","proof-workspace-5plus2-db"]) {
        await client.query("begin read only");
        await client.query("set local statement_timeout='2s'");
        await client.query("select set_config('memory_v1.workspace_id',$1,true)",[workspace]);
        const result = await client.query(`select ${proposed}`,[workspace]);
        expect(Number(result.rows[0].proposed)).toBeGreaterThan(0);
        await client.query("rollback");
      }
    } finally { try {await client.query("rollback");} finally {client.release();} }
  });
  it("promotes a real paraphrased user observation that the containment gate refused", async () => {
    // Read actual persisted rows without writing to the protected corpus.
    const real = (await pool!.query(`select o.observation_id, o.payload->>'statement' statement, rep->>'value' evidence_text, p.representation_sha256
      from memory_v1.observations o
      join memory_v1.provenance_edges p on (p.workspace_id,p.target_record_id,p.pipeline_version)=(o.workspace_id,o.observation_id,o.pipeline_version)
      join memory_v1.content_blocks b on (b.workspace_id,b.content_block_id)=(p.workspace_id,p.content_block_id)
      join memory_v1.messages m on (m.workspace_id,m.message_id)=(b.workspace_id,b.message_id)
      cross join lateral jsonb_array_elements(b.representations) rep
      where o.workspace_id=$1 and p.target_record_type='observation' and m.role='user'
        and o.payload->>'statement' ilike '%User requested a complete master context%Sidekick%'
        and rep->>'sha256'=p.representation_sha256 and rep->>'representation_kind'=p.representation_kind
      order by o.observation_id,p.provenance_edge_id limit 1`, ["proof-workspace-5plus2-db"])).rows[0];
    expect(real).toBeDefined();
    expect(sha256(real.evidence_text)).toBe(real.representation_sha256);
    expect(real.evidence_text.replace(/\s+/g," ").includes(real.statement.replace(/\s+/g," "))).toBe(false);
    const sourceClient = await readerPool!.connect();
    try {
      await sourceClient.query("begin read only");
      await sourceClient.query("select set_config('memory_v1.workspace_id',$1,true)",["proof-workspace-5plus2-db"]);
      const original = await prepareReconciliationInputFromClient(sourceClient,"proof-workspace-5plus2-db",[real.observation_id]);
      expect(original.observations[0]!.evidence.some((edge) => edge.role === "user" && edge.statement_bearing)).toBe(true);
    } finally { try {await sourceClient.query("rollback");} finally {sourceClient.release();} }
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await client.query("set constraints all deferred");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[WORKSPACE]);
      const fixture = await seedReconciliationFixture(client,WORKSPACE,real.statement,real.evidence_text);
      const input = await prepareReconciliationInputFromClient(client,WORKSPACE,[fixture.userObservationId]);
      const destination = { brain_type: "organization" as const,target_ref: "HHS" };
      const validated = validateReconciliationOutput(input,{schema_version: "hhs-reconciliation-output/0.1.0",source_workspace_id: WORKSPACE,
        reconciliations: [{reconciliation_ref: "real-paraphrase",kind: "decision",statement: real.statement,authority: "user",temporal_status: "current",destination,
          observations: [{observation_id: fixture.userObservationId,relation: "supports"}]}]});
      expect(validated.issues).toEqual([]);
      const persisted = await persistValidatedReconciliation(client,WORKSPACE,validated.valid!);
      const request = {sourceWorkspaceId: WORKSPACE,reconciliationId: persisted.reconciliation_ids["real-paraphrase"]!,destinationWorkspaceId: "promotion-real-paraphrase-rollback",destination};
      const pack = await preparePromotionFromClient(client,request);
      expect(pack.promoted_value.authority).toBe("user");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[request.destinationWorkspaceId]);
      await immutableInsert(client,"workspaces","workspace_id",immutableRow("workspace",request.destinationWorkspaceId,["fixture"],{
        workspace_id: request.destinationWorkspaceId,name: "Real paraphrase promotion rollback",isolation_key: request.destinationWorkspaceId,status: "active",created_at: "2026-10-05T00:00:00.000Z"
      }));
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[WORKSPACE]);
      const promoted = await promoteReconciliationFromClient(client,request);
      expect(promoted.replay).toBe(false);
      const receipt = (await client.query("select * from memory_v1.promotion_receipts where workspace_id=$1 and promotion_receipt_id=$2",[request.destinationWorkspaceId,promoted.promotion_receipt_id])).rows[0];
      expect(receipt.promoted_value.authority).toBe("user");
      expect((await promoteReconciliationFromClient(client,request)).replay).toBe(true);
    } finally { try {await client.query("rollback");} finally {client.release();} }
  });
  it("approves promoted knowledge through the real reviewer credential with the live guard", async () => {
    const manifest = JSON.parse(await readFile("/tmp/hhs-reconciliation-review-proof.json","utf8"));
    const client = await reviewerPool!.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[manifest.destinationWorkspaceId]);
      const privilege = (await client.query("select current_user,has_function_privilege(current_user,'memory_v1.guard_promoted_knowledge_approval()','EXECUTE') allowed")).rows[0];
      expect(privilege).toEqual({ current_user: "memory_v1_review_login",allowed: true });
      const result = await recordDecisionFromClient(client,{ workspaceId: manifest.destinationWorkspaceId,candidateId: manifest.reviewerCandidateId,reviewerId: "real-reviewer-proof",rationale: "Verified disposable source fixture" },"approved");
      expect(result.provenance_edge_count).toBe(0);
      const approved = (await client.query("select * from memory_v1.approved_knowledge where workspace_id=$1 and approved_knowledge_id=$2",[manifest.destinationWorkspaceId,result.approved_knowledge_id])).rows[0];
      for (const [change,error] of [
        [{ approved_value: {} }, /exact receipt value/],
        [{ provenance_edge_ids: ["fabricated-edge"] }, /exact receipt value/],
        [{ approval_event_id: "missing-human-approval" }, /matching human approval/],
        [{ pipeline_version: "wrong-pipeline/1" }, /candidate does not exist at this pipeline version/]
      ] as const) {
        const id = deterministicId("approved_knowledge",manifest.destinationWorkspaceId,["forged",Object.keys(change)]);
        await rejectedSql(client,() => immutableInsert(client,"approved_knowledge","approved_knowledge_id",{
          ...approved,...change,approved_knowledge_id: id,idempotency_key: sha256(id)
        }),error);
      }
    } finally { try { await client.query("rollback"); } finally { client.release(); } }
  });

  it("approves legacy chunk-backed knowledge through the real reviewer credential with the live guard", async () => {
    const manifest = JSON.parse(await readFile("/tmp/hhs-reconciliation-review-proof.json","utf8"));
    const client = await reviewerPool!.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memory_v1.workspace_id',$1,true)",[manifest.sourceWorkspaceId]);
      const role = (await client.query("select current_user")).rows[0];
      expect(role.current_user).toBe("memory_v1_review_login");
      const result = await recordDecisionFromClient(client,{ workspaceId: manifest.sourceWorkspaceId,candidateId: manifest.legacyCandidateId,reviewerId: "real-reviewer-proof",rationale: "Verified original local message" },"approved");
      expect(result.provenance_edge_count).toBeGreaterThan(0);
      const detail = await getApprovedKnowledgeFromClient(client,manifest.sourceWorkspaceId,result.approved_knowledge_id!);
      expect(detail.approved_knowledge.provenance_edge_ids).toHaveLength(1);
      expect(detail.promotion_receipt).toBeUndefined();
    } finally { try { await client.query("rollback"); } finally { client.release(); } }
  });

  it("uses the real writer credential for scoped promotion and preserves least privilege", async () => {
    await promotionProof(async (client, request) => {
      const role = await client.query("select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user");
      expect(role.rows[0]).toMatchObject({ current_user: "memory_v1_ingest_login", rolsuper: false, rolbypassrls: false });
      const promoted = await promoteReconciliationFromClient(client, request);
      expect(promoted.replay).toBe(false);
      expect((await promoteReconciliationFromClient(client, request)).replay).toBe(true);
      expect((await client.query("select * from memory_v1.observations where workspace_id=$1", [WORKSPACE])).rows).toEqual([]);
      await rejectedSql(client, () => client.query("insert into memory_v1.approved_knowledge default values"), /permission denied/);
      const receipt = (await client.query("select * from memory_v1.promotion_receipts where workspace_id=$1", [request.destinationWorkspaceId])).rows[0];
      await rejectedSql(client, () => promotionImmutableInsert(client, "promotion_receipts", "promotion_receipt_id", { ...receipt, workspace_id: WORKSPACE }), /row-level security/);
    }, true);
    for (const [role, scopedPool] of [["reader", readerPool], ["reviewer", reviewerPool]] as const) {
      const client = await scopedPool!.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('memory_v1.workspace_id',$1,true)", ["promotion-isolation-empty"]);
        expect((await client.query("select * from memory_v1.knowledge_candidates where workspace_id=$1", [process.env.MEMORY_WORKSPACE_ID])).rows).toEqual([]);
        const permissions = await client.query(`select
          has_table_privilege(current_user,'memory_v1.promotion_receipts','INSERT') receipt_write,
          has_table_privilege(current_user,'memory_v1.approved_knowledge','INSERT') approval_write,
          has_table_privilege(current_user,'memory_v1.promotion_receipts','SELECT') receipt_read`);
        expect(permissions.rows[0]).toEqual({ receipt_write: false, approval_write: role === "reviewer", receipt_read: true });
      } finally { try { await client.query("rollback"); } finally { client.release(); } }
    }
  });
  it("promotes across workspace scopes, replays, reviews and retrieves with durable receipt lineage without local evidence", async () => {
    await promotionProof(async (client, request) => {
      const pack = await preparePromotionFromClient(client, request);
      expect(pack.source_lineage_sha256).toBe(sha256(pack.source_lineage));
      expect(pack.promoted_value_sha256).toBe(sha256(pack.promoted_value));
      const first = await promoteReconciliationFromClient(client, request);
      expect(first.replay).toBe(false);
      expect(Number((await client.query("select count(*) proposed from memory_v1.knowledge_candidates where workspace_id=$1 and status='proposed'",[request.destinationWorkspaceId])).rows[0].proposed)).toBeGreaterThanOrEqual(1);
      expect((await client.query("select promotion_receipt_id from memory_v1.knowledge_candidates where workspace_id=$1",[request.destinationWorkspaceId])).rows[0].promotion_receipt_id).toBe(first.promotion_receipt_id);
      expect((await promoteReconciliationFromClient(client, request)).replay).toBe(true);
      expect((await client.query("select knowledge_candidate_id from memory_v1.trusted_knowledge_candidates where workspace_id=$1", [request.destinationWorkspaceId])).rows).toHaveLength(1);
      const inbox = (await client.query(PENDING_REVIEWS_SQL, [request.destinationWorkspaceId])).rows.filter((item) => item.kind === "knowledge_candidate");
      expect(inbox).toHaveLength(1);
      expect(inbox[0].detail.promotion_receipt_id).toBe(first.promotion_receipt_id);
      // Exercise the actual promoted trust predicate against mismatched row projections;
      // immutable receipts/candidates and their origin guard remain untouched.
      const migration = await readFile("supabase/migrations/20261006124036_memory_v11_trusted_promoted_candidates.sql","utf8");
      const promotedTrust = migration.split("union all\n")[1]!.split(";\n")[0]!;
      const projectedTrust = promotedTrust.replace("memory_v1.knowledge_candidates k", `memory_v1.knowledge_candidates original
        cross join lateral jsonb_populate_record(null::memory_v1.knowledge_candidates,to_jsonb(original) || $2::jsonb) k`)
        + " and k.workspace_id=$1";
      for (const mismatch of [{ kind: "claim" },{ proposed_value_sha256: "a".repeat(64) },{ proposed_value: { statement: "altered" } }]) {
        expect((await client.query(projectedTrust,[request.destinationWorkspaceId,JSON.stringify(mismatch)])).rows).toEqual([]);
      }
      const counts = await client.query(`select
        (select count(*)::int from memory_v1.message_range_chunks where workspace_id=$1) chunks,
        (select count(*)::int from memory_v1.provenance_edges where workspace_id=$1) edges,
        (select count(*)::int from memory_v1.candidate_evidence where workspace_id=$1) evidence`, [request.destinationWorkspaceId]);
      expect(counts.rows[0]).toEqual({ chunks: 0, edges: 0, evidence: 0 });
      const invisible = await client.query("select * from memory_v1.observations where workspace_id=$1", [WORKSPACE]);
      expect(invisible.rows).toHaveLength(2); // Admin fixture connection bypasses RLS; credentialed proof below covers isolation.
      const listed = await listProposedCandidatesFromClient(client, request.destinationWorkspaceId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ promotion_receipt_id: first.promotion_receipt_id, chunk_id: null, evidence_count: 0 });
      const detail = await showCandidateFromClient(client, request.destinationWorkspaceId, first.knowledge_candidate_id);
      expect(detail.promotion_receipt?.source_lineage).toEqual(pack.source_lineage);
      const issued = detail.promotion_receipt!.promoted_at as Date;
      expect(Math.abs(issued.getTime() - Date.now())).toBeLessThan(10000);
      expect(issued.toISOString()).not.toBe(pack.created_at);
      expect(detail.evidence).toEqual([]);
      const before = await client.query(APPROVED_KNOWLEDGE_QUERY_SQL, [request.destinationWorkspaceId, "business", 20]);
      expect(before.rows).toEqual([]);
      const decision = await recordDecisionFromClient(client, { workspaceId: request.destinationWorkspaceId,
        candidateId: first.knowledge_candidate_id, reviewerId: "fixture-human", rationale: "Verified source decision" }, "approved");
      expect(decision.provenance_edge_count).toBe(0);
      await expect(recordDecisionFromClient(client, { workspaceId: request.destinationWorkspaceId,
        candidateId: first.knowledge_candidate_id, reviewerId: "fixture-human", rationale: "Repeat" }, "approved")).rejects.toThrow(/already reviewed/);
      const approved = await getApprovedKnowledgeFromClient(client, request.destinationWorkspaceId, decision.approved_knowledge_id!);
      expect(approved.promotion_receipt?.source_lineage).toEqual(pack.source_lineage);
      const matches = await client.query(APPROVED_KNOWLEDGE_QUERY_SQL, [request.destinationWorkspaceId, "business", 20]);
      expect(matches.rows).toHaveLength(1);
      expect(matches.rows[0]).toMatchObject({ promotion_receipt_id: first.promotion_receipt_id, source_lineage: pack.source_lineage,
        message_id: null, provenance_edge_id: null, review_status: "approved" });
      expect(await listProposedCandidatesFromClient(client, request.destinationWorkspaceId)).toEqual([]);
      expect((await client.query(PENDING_REVIEWS_SQL, [request.destinationWorkspaceId])).rows.filter((item) => item.kind === "knowledge_candidate")).toEqual([]);
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [WORKSPACE]);

    });
  });

  it("legacy approval retains local evidence with the new guard installed twice", async () => {
    await promotionProof(async (client, _request, fixture) => {
      await client.query(await readFile("supabase/migrations/20261006114409_memory_v11_promotion_review.sql", "utf8"));
      const privileges = await client.query("select has_function_privilege('memory_v1_review_login','memory_v1.guard_promoted_knowledge_approval()','EXECUTE') allowed");
      expect(privileges.rows[0].allowed).toBe(true);
      const candidate = await seedLegacyReviewFixture(client, WORKSPACE, fixture.userObservationId);
      const result = await recordDecisionFromClient(client, { workspaceId: WORKSPACE, candidateId: candidate, reviewerId: "legacy-human", rationale: "Exact original message range" }, "approved");
      expect(result.provenance_edge_count).toBeGreaterThan(0);
      const approved = await getApprovedKnowledgeFromClient(client, WORKSPACE, result.approved_knowledge_id!);
      expect(approved.approved_knowledge.provenance_edge_ids).toHaveLength(1);
      expect(approved.promotion_receipt).toBeUndefined();
      expect((await showCandidateFromClient(client,WORKSPACE,candidate)).candidate.promotion_receipt_id).toBeNull();
    });
  });

  it("bounds source content and metadata while resolving exact text only in source scope", async () => {
    const longStatement = "The user decided HHS Core 2 will be the business OS. " + "private source context ".repeat(100);
    await promotionProof(async (client, request) => {
      const firstPack = await preparePromotionFromClient(client,request);
      expect((await preparePromotionFromClient(client,request)).source_lineage).toEqual(firstPack.source_lineage);
      expect(JSON.stringify(firstPack.source_lineage)).not.toContain(longStatement);
      expect(JSON.stringify(firstPack.source_lineage)).not.toContain("private_account_id");
      expect(JSON.stringify(firstPack.source_lineage)).not.toContain("must-stay-at-source");
      const observations = firstPack.source_lineage[0]!.observations as Array<Record<string, unknown>>;
      const evidence = observations.flatMap((o) => o.evidence as Array<Record<string, unknown>>);
      expect(evidence.every((e) => String(e.text_excerpt).length <= PROMOTION_EXCERPT_LIMIT)).toBe(true);
      expect(Object.keys(evidence[0]!.source_metadata as object).sort()).toEqual(["source_conversation_id","source_family","source_observed_at"]);
      const promotion = await promoteReconciliationFromClient(client,request);
      const detail = await showCandidateFromClient(client,request.destinationWorkspaceId,promotion.knowledge_candidate_id);
      await client.query("select set_config('memory_v1.workspace_id',$1,true)", [WORKSPACE]);
      const resolved = await resolvePromotionEvidenceFromClient(client,WORKSPACE,detail.promotion_receipt!);
      expect(resolved.some((e) => e.text_value === longStatement)).toBe(true);
      await expect(resolvePromotionEvidenceFromClient(client,"unauthorized-source",detail.promotion_receipt!)).rejects.toThrow(/authorized source/);
      const forged = structuredClone(detail.promotion_receipt!);
      const forgedLineage = forged.source_lineage as typeof firstPack.source_lineage;
      const entry = (forgedLineage[0]!.observations as typeof observations)[0]!;
      (entry.evidence as typeof evidence)[0]!.representation_sha256 = "a".repeat(64);
      forged.source_lineage_sha256 = sha256(forgedLineage);
      await expect(resolvePromotionEvidenceFromClient(client,WORKSPACE,forged)).rejects.toThrow(/hash mismatch/);
    }, false, longStatement);
  });

  it("refuses rejected reconciliations and preserves superseded historical statements", async () => {
    await promotionProof(async (client,request,fixture) => {
      const input = await prepareReconciliationInputFromClient(client,WORKSPACE,[fixture.userObservationId]);
      for (const temporal of ["rejected","superseded"] as const) {
        const output: ReconciliationOutput = { schema_version: "hhs-reconciliation-output/0.1.0", source_workspace_id: WORKSPACE,
          reconciliations: [{ reconciliation_ref: temporal, kind: "decision", statement: "Historical direction", authority: "user", temporal_status: temporal,
            destination: request.destination, observations: [{ observation_id: fixture.userObservationId,relation: "supports" }] }] };
        const validated = validateReconciliationOutput(input,output);
        const stored = await persistValidatedReconciliation(client,WORKSPACE,validated.valid!);
        const selection = { ...request, reconciliationId: stored.reconciliation_ids[temporal]! };
        if (temporal === "rejected") await expect(preparePromotionFromClient(client,selection)).rejects.toThrow(/rejected reconciliation/);
        else expect((await preparePromotionFromClient(client,selection)).promoted_value.temporal_status).toBe("superseded");
      }
    });
  });

  it("refuses mixed-citation forgery accepted by the previous aggregate-role gate and reports attribution mismatch", async () => {
    await promotionProof(async (client, request, fixture) => {
      for (const addUserContext of [true, false]) {
        const original = (await client.query("select * from memory_v1.observations where workspace_id=$1 and observation_id=$2", [WORKSPACE, fixture.assistantObservationId])).rows[0];
        const id = deterministicId("observation",WORKSPACE,["forgery",addUserContext]);
        const fields = { ...original }; delete fields.record_sha256; delete fields.idempotency_key;
        const payload = { ...original.payload, attribution: { subject: "user",claim_type: "decision" } };
        await immutableInsert(client,"observations","observation_id",immutableRow("observation",WORKSPACE,["forgery",addUserContext], {
          ...fields, observation_id: id, payload, payload_sha256: sha256(payload), created_at: original.created_at.toISOString()
        }));
        const sourceIds = addUserContext ? [fixture.assistantObservationId,fixture.userObservationId] : [fixture.assistantObservationId];
        const edges = (await client.query("select * from memory_v1.provenance_edges where workspace_id=$1 and target_record_id=any($2::text[])",[WORKSPACE,sourceIds])).rows;
        for (const edge of edges) {
          const body = { ...edge }; delete body.record_sha256; delete body.idempotency_key;
          await immutableInsert(client,"provenance_edges","provenance_edge_id",immutableRow("provenance_edge",WORKSPACE,[id,edge.provenance_edge_id], {
            ...body, provenance_edge_id: deterministicId("provenance_edge",WORKSPACE,[id,edge.provenance_edge_id]), target_record_id: id, created_at: edge.created_at.toISOString()
          }));
        }
        const input = await prepareReconciliationInputFromClient(client,WORKSPACE,[id]);
        const item: ReconciliationOutput["reconciliations"][number] = { reconciliation_ref: `forgery-${addUserContext}`, kind: "decision", statement: "Company selected the assistant proposal.", authority: "company", temporal_status: "current",
          destination: request.destination, observations: [{ observation_id: id, relation: "supports" }] };
        const output: ReconciliationOutput = { schema_version: "hhs-reconciliation-output/0.1.0",source_workspace_id: WORKSPACE,reconciliations: [item] };
        expect(validateReconciliationOutput(input,output).valid).toBeUndefined();
        // Model an already persisted forgery independently of the repaired reconciliation validator.
        const stored = await persistValidatedReconciliation(client,WORKSPACE,{ output,reconciliations: [item],trusted_observations: input.observations });
        await expect(preparePromotionFromClient(client,{...request,reconciliationId: stored.reconciliation_ids[item.reconciliation_ref]!}))
          .rejects.toThrow(addUserContext ? /user.company authority/ : /attribution mismatch/);
      }
    });
  });

  it("rejects scope mismatches and assistant-only company/user authority from persisted source", async () => {
    await promotionProof(async (client, request, fixture) => {
      await expect(preparePromotionFromClient(client, { ...request, sourceWorkspaceId: "wrong" })).rejects.toThrow(/not found/);
      await expect(preparePromotionFromClient(client, { ...request, destination: { brain_type: "project", target_ref: "wrong" } })).rejects.toThrow(/destination/);
      const input = await prepareReconciliationInputFromClient(client, WORKSPACE, [fixture.assistantObservationId]);
      const validation = validateReconciliationOutput(input, { schema_version: "hhs-reconciliation-output/0.1.0", source_workspace_id: WORKSPACE,
        reconciliations: [{ reconciliation_ref: "company-assistant", kind: "decision", statement: "Company decided", authority: "company", temporal_status: "current",
          destination: request.destination, observations: [{ observation_id: fixture.assistantObservationId, relation: "supports" }] }] });
      expect(validation.valid).toBeUndefined();
      expect(validation.issues.some((issue) => /company authority requires user-authored evidence/.test(issue.problem))).toBe(true);
      // Model-independent historical forgery: bypass only the newly added validation in this fixture.
      const mixed = validateReconciliationOutput(input, { schema_version: "hhs-reconciliation-output/0.1.0", source_workspace_id: WORKSPACE,
        reconciliations: [{ reconciliation_ref: "company-assistant", kind: "decision", statement: "Company decided", authority: "mixed", temporal_status: "current",
          destination: request.destination, observations: [{ observation_id: fixture.assistantObservationId, relation: "supports" }] }] });
      mixed.valid!.reconciliations[0]!.authority = "company";
      const persisted = await persistValidatedReconciliation(client, WORKSPACE, mixed.valid!);
      await expect(preparePromotionFromClient(client, { ...request, reconciliationId: persisted.reconciliation_ids["company-assistant"]! })).rejects.toThrow(/user.company authority/);
    });
  });

  it("enforces receipt/candidate equality, immutable receipts, approval integrity and collision safety", async () => {
    await promotionProof(async (client, request) => {
      const first = await promoteReconciliationFromClient(client, request);
      const receipt = (await client.query("select * from memory_v1.promotion_receipts where workspace_id=$1", [request.destinationWorkspaceId])).rows[0];
      await expect(promotionImmutableInsert(client, "promotion_receipts", "promotion_receipt_id", { ...receipt, record_sha256: "a".repeat(64) })).rejects.toThrow(/collision/);
      const candidate = (await client.query("select * from memory_v1.knowledge_candidates where workspace_id=$1", [request.destinationWorkspaceId])).rows[0];
      await rejectedSql(client, async () => {
        await immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", { ...candidate, knowledge_candidate_id: "wrong-value", idempotency_key: sha256("wrong-value"), proposed_value: { statement: "Forged" } });
      }, /value does not match/);
      await rejectedSql(client, () => immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", {
        ...candidate, knowledge_candidate_id: "wrong-kind", idempotency_key: sha256("wrong-kind"), kind: "claim"
      }), /kind does not match/);
      await rejectedSql(client, () => immutableInsert(client, "knowledge_candidates", "knowledge_candidate_id", {
        ...candidate, knowledge_candidate_id: "wrong-hash", idempotency_key: sha256("wrong-hash"), proposed_value_sha256: "a".repeat(64)
      }), /value does not match/);
      const sourceEdge = (await client.query("select * from memory_v1.provenance_edges where workspace_id=$1 limit 1", [WORKSPACE])).rows[0];
      await rejectedSql(client, async () => {
        await immutableInsert(client, "provenance_edges", "provenance_edge_id", { ...sourceEdge,
          workspace_id: request.destinationWorkspaceId, provenance_edge_id: "cross-workspace-proof", idempotency_key: sha256("cross-workspace-proof"),
          target_record_type: "knowledge_candidate", target_record_id: first.knowledge_candidate_id, pipeline_version: candidate.pipeline_version });
        await client.query("set constraints all immediate");
      }, /foreign key|exact provenance/);
      await rejectedSql(client, () => client.query("update memory_v1.promotion_receipts set kind='claim' where workspace_id=$1", [request.destinationWorkspaceId]), /append-only/);
      await rejectedSql(client, () => client.query("delete from memory_v1.promotion_receipts where workspace_id=$1", [request.destinationWorkspaceId]), /append-only/);
      const decision = await recordDecisionFromClient(client, { workspaceId: request.destinationWorkspaceId, candidateId: first.knowledge_candidate_id, reviewerId: "human", rationale: "Verified" }, "approved");
      const approved = (await client.query("select * from memory_v1.approved_knowledge where workspace_id=$1 and approved_knowledge_id=$2", [request.destinationWorkspaceId, decision.approved_knowledge_id])).rows[0];
      await rejectedSql(client, () => immutableInsert(client, "approved_knowledge", "approved_knowledge_id", { ...approved, approved_knowledge_id: "forged-approved", idempotency_key: sha256("forged-approved"), approved_value: {} }), /exact receipt value/);
    });
  });
  it("reloads observation authority from exact provenance instead of trusting payload", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );
      await client.query("set constraints all deferred");

      const fixture = await seedFixture(client);

      const input = await prepareReconciliationInputFromClient(
        client,
        WORKSPACE,
        [fixture.userObservationId, fixture.assistantObservationId]
      );

      expect(input.observations).toHaveLength(2);

      const user = input.observations.find(
        (item) => item.observation_id === fixture.userObservationId
      )!;

      const assistant = input.observations.find(
        (item) => item.observation_id === fixture.assistantObservationId
      )!;

      expect(user.evidence_roles).toEqual(["user"]);
      expect(assistant.evidence_roles).toEqual(["assistant"]);

      await client.query("rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("rejects unknown observations before reconciliation output is accepted", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );

      await expect(
        prepareReconciliationInputFromClient(
          client,
          WORKSPACE,
          ["observation_does_not_exist"]
        )
      ).rejects.toThrow(/unknown observation/i);

      await client.query("rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  it("persists reconciliation and observation lineage idempotently, then rolls back", async () => {
    const client = await pool!.connect();

    try {
      await client.query("begin");
      await client.query(
        "select set_config('memory_v1.workspace_id',$1,true)",
        [WORKSPACE]
      );
      await client.query("set constraints all deferred");

      const fixture = await seedFixture(client);

      const input = await prepareReconciliationInputFromClient(
        client,
        WORKSPACE,
        [fixture.userObservationId, fixture.assistantObservationId]
      );

      const output: ReconciliationOutput = {
        schema_version: "hhs-reconciliation-output/0.1.0",
        source_workspace_id: WORKSPACE,
        reconciliations: [
          {
            reconciliation_ref: "current-business-os",
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
                observation_id: fixture.userObservationId,
                relation: "supports"
              },
              {
                observation_id: fixture.assistantObservationId,
                relation: "supersedes"
              }
            ]
          }
        ]
      };

      const validated = validateReconciliationOutput(input, output);

      expect(validated.issues).toEqual([]);
      expect(validated.valid).toBeDefined();

      const first = await persistValidatedReconciliation(
        client,
        WORKSPACE,
        validated.valid!
      );

      const replay = await persistValidatedReconciliation(
        client,
        WORKSPACE,
        validated.valid!
      );

      expect(first).toMatchObject({
        reconciliations_inserted: 1,
        reconciliation_observations_inserted: 2,
        replay: false
      });

      expect(replay).toMatchObject({
        reconciliations_inserted: 0,
        reconciliation_observations_inserted: 0,
        replay: true
      });

      const rows = await client.query(
        `select r.kind, r.payload,
                count(ro.reconciliation_observation_id)::int as observation_count
         from memory_v1.reconciliations r
         join memory_v1.reconciliation_observations ro
           on (ro.workspace_id,ro.reconciliation_id,ro.pipeline_version) =
              (r.workspace_id,r.reconciliation_id,r.pipeline_version)
         where r.workspace_id=$1
         group by r.kind,r.payload`,
        [WORKSPACE]
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].kind).toBe("decision");
      expect(rows.rows[0].observation_count).toBe(2);
      expect(rows.rows[0].payload.statement).toBe(
        "HHS Core 2 is the current business OS."
      );

      await client.query("rollback");

      const after = await pool!.query(
        "select count(*)::int n from memory_v1.reconciliations where workspace_id=$1",
        [WORKSPACE]
      );

      expect(after.rows[0].n).toBe(0);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
});

async function promotionProof(callback: (client: import("./db.js").DbClient, request: import("./promotion.js").PromotionRequest, fixture: { userObservationId: string; assistantObservationId: string }) => Promise<void>, useWriter = false, userStatement?: string) {
  const client = await (useWriter ? writerPool! : pool!).connect();
  const destination = "promotion-layer-rollback-proof";
  try {
    await client.query("begin");
    // Exercise the additive migration without changing the local schema or migration history.
    if (!useWriter) {
      await client.query(await readFile("supabase/migrations/20261006114409_memory_v11_promotion_review.sql", "utf8"));
      await client.query(await readFile("supabase/migrations/20261006124036_memory_v11_trusted_promoted_candidates.sql", "utf8"));
    }
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [WORKSPACE]);
    await client.query("set constraints all deferred");
    const fixture = await seedFixture(client, userStatement);
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [destination]);
    await immutableInsert(client, "workspaces", "workspace_id", immutableRow("workspace", destination, ["fixture"], {
      workspace_id: destination, name: "Promotion rollback fixture", isolation_key: destination, status: "active", created_at: "2026-10-05T00:00:00.000Z"
    }));
    await client.query("select set_config('memory_v1.workspace_id',$1,true)", [WORKSPACE]);
    const input = await prepareReconciliationInputFromClient(client, WORKSPACE, [fixture.userObservationId, fixture.assistantObservationId]);
    const scope = { brain_type: "organization" as const, target_ref: "HHS" };
    const validation = validateReconciliationOutput(input, { schema_version: "hhs-reconciliation-output/0.1.0", source_workspace_id: WORKSPACE,
      reconciliations: [{ reconciliation_ref: "promote-current", kind: "decision", statement: "HHS Core 2 is the current business OS.", authority: "user", temporal_status: "current", destination: scope,
        observations: [{ observation_id: fixture.userObservationId, relation: "supports" }, { observation_id: fixture.assistantObservationId, relation: "context" }] }] });
    const persisted = await persistValidatedReconciliation(client, WORKSPACE, validation.valid!);
    await callback(client, { sourceWorkspaceId: WORKSPACE, reconciliationId: persisted.reconciliation_ids["promote-current"]!, destinationWorkspaceId: destination, destination: scope }, fixture);
  } finally {
    try { await client.query("rollback"); } finally { client.release(); }
  }
  const after = await pool!.query("select count(*)::int n from memory_v1.workspaces where workspace_id=any($1::text[])", [[WORKSPACE, destination]]);
  expect(after.rows[0].n).toBe(0);
}

async function rejectedSql(client: import("./db.js").DbClient, action: () => Promise<unknown>, message: RegExp) {
  await client.query("savepoint rejection_proof");
  await expect(action()).rejects.toThrow(message);
  await client.query("rollback to savepoint rejection_proof");
}

const seedFixture = (client: import("./db.js").DbClient, statement?: string) => seedReconciliationFixture(client, WORKSPACE, statement);

function immutableRow(
  kind: string,
  workspaceId: string,
  natural: unknown,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const body = {
    ...fields,
    idempotency_key: idempotencyKey(kind, workspaceId, natural)
  };

  return {
    ...body,
    record_sha256: sha256(body)
  };
}
