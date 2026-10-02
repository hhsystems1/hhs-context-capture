# Memory Foundation M1 Architecture

## Purpose

Memory Foundation M1 defines the platform-neutral contracts downstream of the immutable HHS capture archive. It does not ingest a real capture, connect a database, extract knowledge automatically, publish notes, or change source evidence. Its acceptance fixture is entirely synthetic.

## Layer boundaries

1. **Immutable source evidence** — source systems, opaque source accounts, ingestion runs, source records, capture versions, conversations, messages, content blocks, and verification results point to preserved evidence. They are never rewritten by downstream interpretation.
2. **Normalized source records** — conversation, message, and content-block records preserve source identity, ordering, accessible representation values, locators, and hashes. Normalization does not assert that content is true.
3. **Proposed knowledge** — knowledge candidates and candidate-evidence links contain machine- or human-proposed interpretations. A proposal is not approved truth.
4. **Approved structured knowledge** — approved knowledge, entities, relationships, use cases, decisions, tasks, and SOPs require a separate human-authored approval event and exact provenance.

Quarantine and dead-letter records are operational safety lanes. Unsupported or failed input remains visible and does not enter approved knowledge implicitly.

## Workspace isolation

Every contract includes `workspace_id`, including source-facing records. Semantic validation requires every reference to resolve inside the same workspace. A future persistence adapter must enforce the same rule with composite workspace-aware keys and row-level access controls; M1 supplies no persistence adapter.

## Exact provenance

Every provenance edge contains an evidence locator with all of:

- source record ID
- immutable capture-version ID
- conversation ID
- message ID
- content-block ID
- representation kind
- representation SHA-256

The invariant validator resolves the chain and confirms that the named representation and SHA-256 exist on the content block. Provenance edges are append-only records with deterministic identities. Corrections add edges or review events; they do not mutate evidence.

## Candidate and approval lifecycle

The only M1 transitions are:

```text
proposed -> in_review -> approved
                      -> rejected
                      -> disputed
                      -> superseded
```

Each transition is a separate append-only `HumanReviewEvent` with `actor_kind: human`, reviewer identity, rationale, timestamp, and event hash. `ApprovedKnowledge` is invalid unless it references the candidate's human event ending in `approved`. Approval does not alter the candidate evidence or source record.

## Conflicts and history

Relationships support `contradicts`, `supersedes`, `refines`, `supports`, `duplicates`, and `applies_to_different_context`. Contradictions and supersessions are also explicit records so resolution never erases prior approved knowledge. A later record may supersede an earlier record only through a cited, human-reviewed record.

## Determinism and replay

`deterministicId` and `idempotencyKey` hash a record kind, workspace, and stable natural key using canonical JSON and SHA-256. Idempotent replay keeps byte-equivalent records once. The merge helper throws on a deterministic-ID collision with different content rather than silently overwriting it.

## Validation

The package uses two gates:

- JSON Schema Draft 2020-12 validates required structure, enumerations, timestamps, and SHA-256 shapes.
- Semantic invariants validate uniqueness, workspace isolation, foreign-key resolution, exact provenance hashes, lifecycle event chains, separate human approval, and approved-record references.

The synthetic acceptance bundle exercises every M1 contract, including quarantine and dead-letter paths. It uses `synthetic://` evidence locators and contains no private archive identifiers or real conversation content.

## Explicitly deferred

M1 has no PostgreSQL, Supabase, pgvector, Convex, Obsidian, n8n, embedding, cloud, browser, scheduled, or batch-processing integration. M2 should add one explicitly approved, read-only one-conversation ingestion acceptance path into an isolated local staging target, preserving the capture unchanged and stopping before any candidate becomes approved knowledge.
