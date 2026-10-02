# Memory Vertical Slice V1 and V1.1

Memory Vertical Slice V1 imports exactly one locally approved immutable capture into local Docker-based Supabase. Capture identity, archive paths, workspace identity, database credentials, pipeline version, and proof location are private configuration and must never be committed. Hosted services and external processing are outside this slice.

## Original V1 audit result

The independent V1 acceptance audit failed despite correct live cardinalities. It found five blockers:

1. derived records had no pipeline-version lineage;
2. PostgreSQL did not enforce completion invariants;
3. immutability depended on an application helper rather than database guards;
4. replay, resume, failure, and version-coexistence results had no durable proof receipts; and
5. private archive identifiers remained in the tracked tree and older Git history.

The V1 database generation is retained as `memory-v1/legacy`. V1.1 does not delete, replace, or rewrite that generation.

## V1.1 corrections

Migrations `20260721150200_memory_v11_corrective.sql`, `20260721150300_memory_v11_operational_guards.sql`, and `20260721150400_memory_v11_legacy_report.sql` add:

- required pipeline versions for new ingestion runs and pipeline-scoped derived records;
- pipeline-versioned identities for runs, checkpoints, chunks, candidates, provenance, evidence, hash resolutions, proof metadata, quarantine, dead letters, and downstream knowledge records;
- database validation of expected source counts, checkpoint completion, contiguous chunk coverage, proposed-only candidates, exact provenance, archive-hash resolution, verification status, and fatal operational errors before completion;
- controlled ingestion, checkpoint, workspace, quarantine, and dead-letter transitions;
- update/delete guards for immutable source, capture, evidence, provenance, proof, and derived-version tables;
- forced workspace row-level security;
- separate local ingestion-writer and report-reader login roles; and
- an append-only database index of private proof receipts.

The same capture and pipeline version replays without new derived rows. A different pipeline version receives a distinct ingestion run, chunk, candidate, evidence, provenance, checkpoint, quarantine, dead-letter, and proof identity. Earlier generations are not updated or merged.

## V1.1 audit corrections

Migration `20260722233500_memory_v11_audit_corrections.sql` closes the remaining independent-audit findings without rewriting prior migrations or historical rows:

- the ingestion-run guard now executes on `INSERT`, `UPDATE`, and `DELETE`; a new run can begin only as `pending` or `running`, so an incomplete row cannot be inserted directly as `completed`;
- fatal quarantine atomically moves its run to terminal `quarantined`; later release or discard of the evidence cannot revive that run;
- a retry must use a distinct ingestion-run and pipeline identity and records both parent identity fields; only a terminal failed or quarantined run can be its parent;
- the 450 historical `memory-v1/legacy` edges remain unchanged, while 450 immutable repair records map each edge to its independently hash-resolved content-block source;
- generation attestations and trusted views exclude failed, quarantined, or retired generations and expose the repaired legacy generation only through the verified overlay; and
- archive location is read from ignored local configuration. The tracked collector, tests, and documentation contain no machine-specific username or absolute private archive path.

The corrective proof run created four append-only receipts under `MEMORY_PROOF_ROOT`: `20260723T021202694Z_completed_insert_rejection_5dfa2769`, `20260723T021203989Z_fatal_quarantine_terminal_9d1def95`, `20260723T021206537Z_retry_lineage_4f855c03`, and `20260723T021207756Z_legacy_provenance_repair_f6be58c7`. Recompute their `hashes.sha256` indexes rather than trusting this document.

## Private local configuration

`.env.example` contains redacted placeholders only. Run the local provisioning script with private values supplied in the process environment after migrations have been applied. It generates separate writer and reader passwords and atomically writes the ignored `.env.memory-v1.local` file.

Required variables are:

- `MEMORY_DATABASE_URL`
- `MEMORY_INGEST_DATABASE_URL`
- `MEMORY_REPORT_DATABASE_URL`
- `HHS_ARCHIVE_ROOT`
- `MEMORY_APPROVED_CAPTURE_ID`
- `MEMORY_APPROVED_CAPTURE_PATH`
- `MEMORY_WORKSPACE_ID`
- `MEMORY_PIPELINE_VERSION`
- `MEMORY_PROOF_ROOT`

Every database URL is rejected unless it uses a loopback host. Do not run `supabase link` or configure a hosted project.

## Verified live V1.1 behavior

The local integration proof verifies, without truncating existing data:

- clean first ingestion of the configured approved capture;
- identical replay without duplicate derived rows;
- interruption after checkpoint 2, rejection of premature completion, and resume from checkpoint 2;
- cross-workspace reference rejection;
- nonfatal invalid-evidence quarantine;
- failed-run completion rejection;
- fatal-quarantine completion rejection;
- coexistence of distinct pipeline generations without mutation of the earlier generation;
- writer permission rejection and database-trigger rejection of immutable updates and deletes;
- report-reader write rejection;
- exact content-block provenance and archive-hash resolution; and
- byte-for-byte stability of the approved source capture before and after proof execution.

Knowledge candidates remain `proposed`. V1.1 does not create human review events or approved knowledge.

## Durable proof locations

Proofs are stored outside Git beneath `MEMORY_PROOF_ROOT`. Each run creates a new timestamped directory rather than replacing an earlier receipt. A directory contains:

- `receipt.json` using schema `hhs.memory-proof-receipt/1.1.0`;
- `manifest.json` describing receipt bytes and hashes; and
- `hashes.sha256` covering both JSON files.

The database stores only append-only proof metadata and the private receipt locator. `npm run memory:prove` independently verifies every receipt directory before reporting success.

## Synthetic-only or schema-only behavior

- Human review, approval, approved knowledge, entities, relationships, contradictions, supersessions, use cases, decisions, tasks, and SOPs remain schema and synthetic-test capabilities.
- Dead-letter retry scheduling has controlled fields and guards but no live retry worker.
- Controlled maintenance bypass exists only for the database maintenance role with an explicit transaction-local maintenance setting; application login roles do not receive that role.

## Unimplemented behavior

V1.1 does not connect embeddings, external models, hosted Supabase, Convex, Obsidian, n8n, GitHub automation, cloud services, deployment, publication, or scheduling. It does not automatically approve knowledge or ingest another conversation.

## Commands

- `npm run memory:provision` provisions ignored local configuration and least-privilege login credentials after the migrations exist.
- `npm run memory:ingest` imports or idempotently replays the configured capture and pipeline version.
- `npm run memory:report` runs through the report-reader role in a read-only transaction.
- `npm run memory:prove` runs append-only local integration proofs and writes private durable receipts.
- `npm run memory:prove:corrective` runs the audit-correction proofs against the approved capture and appends four private receipts.

`memory:prove` never truncates Memory tables and never modifies source captures.

## Remaining publication and Git-history risk

The current tracked tree is intended to contain no private archive identifiers, credentials, transcript content, archive payloads, proof receipts, or runtime database state. Older Git objects still contain private identifiers and require a separately approved recoverable history rewrite and independent rescan. `PUBLICATION_BLOCKED.md` and the configured pre-push hook remain authoritative; V1.1 does not authorize pushing or publication.
