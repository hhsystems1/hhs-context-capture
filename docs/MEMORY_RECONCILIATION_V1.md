# HHS Memory Reconciliation V1

## Purpose

Bridge verified source evidence and persisted Understanding Discovery observations into trusted approved knowledge without weakening workspace isolation or provenance.

This stage comes after source-specific capture/import and Understanding Discovery.

## Pipeline

source adapter
-> normalized immutable evidence
-> observations + observation links
-> reconciliation
-> promotion
-> knowledge candidate
-> human review
-> approved knowledge
-> brain retrieval

Source adapters may include browser Context Capture, native exports, Google Drive, Gmail, GitHub, files, APIs, and future sources. Reconciliation must not depend on which adapter originally produced the evidence.

## Invariants

1. Source evidence is immutable.

Original source records, source versions, messages/content blocks, observations, and provenance remain unchanged.

2. Workspace isolation remains intact.

Normal provenance edges never cross workspaces. Do not weaken the existing cross-workspace provenance invariant.

3. Models do not receive database authority.

A model may propose reconciliation results. Trusted deterministic code validates identities, hashes, evidence references, authority, and allowed persistence.

4. Reconciliation is not promotion.

Reconciliation determines what observations mean together:
- atomic claims
- duplicates
- support
- contradictions
- refinements
- supersession
- current versus historical state
- authority
- intended destination brain

Nothing becomes approved knowledge merely because reconciliation produced it.

5. User/company authority must remain evidence-backed.

A user decision, preference, instruction, commitment, or company decision cannot be inferred solely from assistant-authored evidence.

6. History is never overwritten.

Old facts and decisions remain preserved. Newer knowledge may supersede, reverse, contradict, refine, or apply to a different context.

7. Destination brain is the scope boundary.

Organization, project, and personal knowledge is promoted into the appropriate Context workspace. Core resolves those workspaces through brain bindings.

8. Promotion across workspaces uses an explicit immutable promotion boundary.

A destination brain must not hold a normal provenance edge that directly references evidence rows in another workspace.

Promotion must carry a tamper-evident receipt/package containing enough source identity and hashes to prove exactly which reconciled source evidence produced the proposed knowledge.

9. Legacy extraction remains valid.

Existing message-range-chunk -> knowledge-candidate workflows must continue to work unchanged.

Reconciliation-backed candidates are additive. They must not fabricate fake message chunks merely to satisfy the legacy candidate schema.

10. Review must expose evidence.

A human reviewing a reconciliation-backed candidate must be able to see where it came from, including the original source workspace, observations/evidence identities, source metadata where available, and verification hashes.

11. Approved knowledge retains durable lineage.

After approval, the system must preserve the promotion receipt/evidence lineage required to trace the knowledge back through reconciliation to original source evidence.

12. Reconciliation must be replay-safe.

Equivalent trusted inputs must produce deterministic identities or deterministic validation behavior. Re-running the stage must not silently create divergent duplicate knowledge.

## V1 work

The implementation should add only the minimum additive pieces required for:

- persisted reconciliation output
- immutable promotion receipts
- reconciliation-backed knowledge candidates
- review of promotion evidence
- approval with preserved lineage
- supersession/contradiction relationships using the existing knowledge model

Do not redesign Context Capture, Understanding Discovery, the reconstruction runners, brain provisioning, or workspace-aware retrieval as part of this feature.

## Trusted promotion worker

`apps/memory-ingest/src/promotion.ts` exposes `promoteReconciliation` for an
operator-resolved source workspace, persisted reconciliation ID, and destination
workspace/brain scope. Brain binding resolution remains the caller's responsibility;
these arguments must never come directly from model output. The persisted proposed
brain type/target must match the resolved request. The destination must be active.

The worker reloads reconciliation and observation rows and exact source provenance,
recomputes immutable/payload hashes, validates pipeline identities and relations,
requires verified source versions/captures and hash-matching representations, and
revalidates attribution. Reconciliation and promotion share the same conservative
user/company authority predicate: a `supports`, `refines`, or `duplicates` observation
must have a user-authored `quotes`, `derived_from`, or `supports` provenance edge
whose hash-verified text shares at least `STATEMENT_EVIDENCE_OVERLAP = 0.5` of the
statement's unique content tokens (case/whitespace normalized, small stopword set
removed), or contains a quoted span from the statement verbatim after normalization.
This lexical heuristic supports paraphrased observations; it does not prove semantic
entailment. An unrelated user acknowledgement beside an assistant proposal does not
meet the overlap gate. A future validated per-citation statement-bearing designation
at the discovery source should supersede this heuristic.
Model-authored attribution is only a consistency check: claiming a user subject with
no user-role citation is an explicit mismatch. Discovery's existing
`claimsUserAuthority()` check remains wired into validation. These checks prove
source authorship and a statement-bearing citation, not corporate authorization or
semantic entailment of a model's reconciled interpretation; human review remains required.
Operators must select a supporting observation with a verified user citation meeting
the named overlap threshold or quoted-span check. Nonprivileged authority categories
retain their existing behavior. The predicate is transient and changes no receipt
hash content; `memory-promotion/0.2.0` and existing receipt replay identities remain unchanged.

The deterministic package includes source workspace/reconciliation version/hash,
sorted observation IDs/versions/relations/hashes, provenance identities and hashes,
source locators, bounded excerpts and allow-listed metadata, destination workspace/brain scope, kind,
and promoted value. Source lineage and promoted value each have a deterministic
SHA-256. Timestamp normalization and the existing provenance convention for omitted
unused source-family columns preserve compatibility with persisted rows.

One writer transaction reads in source RLS scope, then appends the destination receipt
and exact matching candidate in destination RLS scope. Identities derive from the
source reconciliation and destination scope; hashes are excluded from identity so
changed source lineage causes an immutable collision instead of a new silent copy.
Concurrent inserts use `ON CONFLICT DO NOTHING` followed by a winning-hash check.
No source rows are changed. No chunks, candidate evidence, or provenance edges are
created by promotion. Adding source observation/provenance links after a successful
promotion intentionally makes its replay collide; reconcile a new identity instead.

Review lists identify receipt origins; candidate detail and approved knowledge detail
include the destination receipt and durable, bounded source lineage snapshot. Receipt-backed
approval validates receipt integrity and permits empty local evidence. Legacy candidate
approval continues to require local provenance. Approved knowledge retains the existing
workspace-local candidate FK, whose immutable receipt FK supplies durable lineage:
`approved_knowledge -> knowledge_candidate -> promotion_receipt -> source_lineage`.
The additive promotion-review migration enforces exact value and human approval for
promoted approvals without adding another origin column. The guard has explicit
EXECUTE grants to the worker/reader/reviewer groups, rejects missing pipeline-specific
candidates, and can be installed repeatedly. The trusted-candidate view preserves the
legacy attestation branch verbatim and adds only receipt-matching promoted candidates;
Mission Control inbox, counters and read-only reports therefore include the new origin. Retrieval searches approved
promoted statements and returns receipt lineage; local message/edge fields are null.

Promotion pipeline `memory-promotion/0.2.0` defines a fixed 240-character excerpt
for each observation statement and cited representation, labelled with full length
and excerpt limit. Full source text is not copied into lineage. Metadata is restricted
to `source_family`, `source_conversation_id`, and `source_observed_at`, taken from
source rows; the complete original metadata has only a SHA-256 digest in the receipt.
The bounds are 64 cited observations, 128 edges per observation, 262,144 UTF-8 bytes
for serialized lineage, and 10,000 characters for the promoted statement. Exceeding
any bound fails before destination writes. Changing these rules requires another
promotion pipeline version bump. Locators and exact verification hashes remain durable.

Full text resolution uses `resolveCandidatePromotionEvidence` / `review-evidence`:
first validate the destination receipt, then read in an explicitly operator-authorized
source workspace. The source scope is never inferred as an authorization grant from
model output or the receipt. Reconciliation, observation and exact representation
hashes must still match the receipt before any full text is returned. No full text is
written back into the destination. This command is for trusted operators; a future
service must supply its own authorization for the explicitly requested source scope.

`promotion_receipts.promoted_at` records DB-issued wall-clock issuance, outside the
deterministic row hash, and is protected by the immutable row guard. Source-derived
`created_at` remains in the hash. Review lists and the Mission Control inbox order
promoted candidates by issuance time and expose it. Rejected reconciliations cannot
be promoted; superseded statements can be promoted as explicitly labelled history.

Operator commands (all scope arguments must be operator-resolved):

```sh
npm run memory:reconcile -- prepare --workspace SOURCE --observations O1,O2
npm run memory:reconcile -- persist --workspace SOURCE --observations O1,O2 --output /path/to/model-output.json
npm run memory:promote -- --source-workspace SOURCE --reconciliation-id RID --destination-workspace BRAIN --brain-type organization --target-ref HHS
MEMORY_WORKSPACE_ID=BRAIN npm run memory:review-list
MEMORY_WORKSPACE_ID=BRAIN npm run memory:review-show -- CANDIDATE
MEMORY_WORKSPACE_ID=BRAIN npm run memory:review:evidence -- CANDIDATE --source-workspace SOURCE
MEMORY_WORKSPACE_ID=BRAIN npm run memory:review-approve -- CANDIDATE --reviewer HUMAN --rationale "Verified source lineage"
MEMORY_WORKSPACE_ID=BRAIN npm run memory:query -- "statement text"
```

Persistence reloads the operator-selected observation IDs independently of model
output and validates before writing. Invalid model output prints issues and exits
non-zero. No command invents a brain binding from the brain type.

For local acceptance, install only the two additive reconciliation migrations;
never reset the database. `scripts/prove-reconciliation-acceptance.ts` creates
committed, disposable source/brain fixtures (including one real native message range
for legacy approval). This setup is separate from rollback-only DB proofs because
separate writer/reviewer connections cannot share uncommitted rows. It drives the
operator CLI prepare/persist/promote/replay/review/evidence paths and writes an
identity-only manifest in `/tmp`. Approval proofs require that manifest and the live
guard. They always roll back. The optional `--complete` acceptance step durably
approves only the disposable acceptance candidate and verifies retrieval.

```sh
node --env-file=.env.memory-v1.local --import tsx scripts/prove-reconciliation-acceptance.ts
```

Run rollback-only DB proofs with:

```sh
HHS_RUN_RECONCILIATION_DB_PROOF=1 node --env-file=.env.memory-v1.local node_modules/vitest/vitest.mjs run apps/memory-ingest/src/reconciliation-db.test.ts apps/memory-ingest/src/extraction-db.test.ts
```

These proofs exercise migration re-runnability transactionally and approve both
legacy and promoted fixtures through the actual reviewer credential with the live
guard. They check Mission Control inbox inclusion/removal, bounded lineage, source
resolution, forged approvals, authority, rejection, isolation, and immutable replay.
Every test transaction rolls back. Before/after fingerprints protect
`proof-workspace-5plus2-db`; acceptance fixtures never write there. One pre-existing
Understanding Discovery test assumes the global observation tables are empty and
must not be run as an empty-DB assertion against populated source workspaces.
