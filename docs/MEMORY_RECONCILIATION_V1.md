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
