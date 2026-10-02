# Next Vertical Slice Plan

Status: proposed; implementation requires explicit approval  
Baseline date: 2026-07-17  
Scope: ChatGPT inventory, versioned recapture, and disconnected derived-output foundations

## Verified baseline

The first controlled, branch-free acceptance capture is independently verified as complete.

- Capture ID: retained in the private archive audit record
- Conversation identity: intentionally omitted from repository documentation
- Archive path: retained in the private archive audit record; intentionally omitted from repository documentation
- Messages: 8 total, alternating 4 user and 4 assistant messages, with contiguous sequence numbers
- Content exercised: headings, nested lists, tables, code, blockquote, links, Unicode, repeated text, and sufficient length to scroll
- Boundaries: earliest and latest verified; scrolling and message count stabilized
- Branches and truncation: no indicators observed
- Representations: inner text, text content, sanitized structural HTML, and deterministic canonical text present and hash-valid for every message
- Archive integrity: all 11 manifest hashes independently recomputed and verified
- Verification: no failed checks and no warnings
- Visual evidence: initial viewport, earliest boundary, latest boundary, and artifact-associated viewport records

This baseline establishes that the current vertical slice can produce a verified-complete exact accessible rendered transcript for a controlled conversation. It does not prove complete traversal of conversations with branches or every future ChatGPT interface variant.

## Architectural boundary

The next slice keeps two one-way, separately operated pipelines:

```text
Preservation pipeline
ChatGPT UI -> read-only inventory -> approved capture -> immutable archive
                                      -> rebuildable local catalog

Derived-knowledge pipeline
approved archive versions -> provenance-preserving export -> PostgreSQL/pgvector
                                                  \-> Obsidian notes
```

The immutable archive remains authoritative. The catalog, PostgreSQL records, vectors, and notes are indexes or derived products and can be rebuilt. Derived processing must never modify an archived capture or change its verification status.

## Safety defaults and approval gates

- Sidebar discovery is read-only and must never open, edit, regenerate, submit, delete, archive, or rename a conversation.
- A real capture, recapture, or batch run requires explicit user approval.
- Batch processing is disabled by default and remains foreground/manual in this slice.
- Task Scheduler artifacts may be generated and tested, but no task is registered or enabled without separate approval.
- PostgreSQL schemas and export payloads may be built and tested locally, but no local or cloud database is connected without separate approval.
- Obsidian output is tested in repository fixtures first. Writing to a real vault requires its path and separate approval.
- No telemetry, deployment, publishing, cloud synchronization, or GitHub push.
- Raw captures continue to be written only under the configured private archive root.

## Proposed components

```text
apps/
  browser-extension/
    src/inventory/              # sidebar observation and virtualized accumulation
    src/batch/                  # user-approved sequential runner UI/client
  local-collector/
    src/catalog/                # catalog API and archive reconciliation
    src/jobs/                   # resumable job API
    src/derived/                # explicit export endpoints, off by default

adapters/
  chatgpt/
    src/inventory-adapter.ts    # ChatGPT-only sidebar selectors/behavior

packages/
  inventory-schema/             # platform-neutral inventory observations
  conversation-catalog/         # persistent, rebuildable local index
  change-detection/             # conservative classification and hash comparison
  batch-orchestrator/           # state machine, checkpoints, pacing, cancellation
  provenance/                   # stable capture/message/block citations
  postgres-export/              # disconnected schema, migrations, and records
  obsidian-export/              # deterministic notes and citation links

scripts/
  task-scheduler/               # generate/validate disabled task definitions

docs/
  INVENTORY_PROTOCOL.md
  CATALOG_AND_CHANGE_DETECTION.md
  BATCH_CAPTURE_PROTOCOL.md
  DERIVED_KNOWLEDGE_PIPELINE.md
```

Package boundaries should be introduced only as working behavior requires them. The first proof is inventory plus catalog for one account, not a full abstraction pass.

## Data model

### Inventory observation

An inventory run records its own ID, platform, opaque account reference, start/end times, boundary and stabilization evidence, warnings, and ordered conversation observations. Each observation contains the platform conversation ID when accessible, title exactly as rendered, URL when accessible, sidebar position, visible status indicators, observation time, evidence locator, platform metadata, and a deterministic observation fingerprint.

Inventory fingerprints are hints, not proof that server content is unchanged. They must not include account email/name, cookies, tokens, authorization data, or unrelated browsing history.

### Catalog record

The persistent catalog maps `(platform, opaque_account_ref, platform_conversation_id)` to:

- first and last inventory sightings;
- latest title and source URL observations;
- latest classification and its reasons;
- latest capture ID, status, time, message count, and archive location;
- capture-version history;
- message identity and representation hashes from each immutable version;
- inventory/capture warnings and review state.

Use an embedded SQLite catalog in the private archive's operational-metadata area, not in the code repository. SQLite provides transactional checkpoints and querying without adding a service. It remains rebuildable from append-only inventory manifests and capture manifests. Before adopting the dependency, verify its Windows packaging and archive-path behavior.

### Capture versions and message hashes

Every recapture writes a complete new immutable archive version. Message-level comparison is a derived index; it never substitutes a delta for preserved evidence. Comparison should prefer accessible platform message IDs, then use role, parent/branch identity, sequence neighborhood, and representation hashes conservatively. Ambiguous matching becomes `needs_review` rather than silently treating messages as identical.

### Batch job

A job stores a durable job ID, inventory ID, explicit user-selected conversation IDs, creation/approval times, pacing policy, and item states. Item states are `pending`, `running`, `cooldown`, `complete`, `needs_review`, `failed`, `cancelled`, or `skipped`. Each transition is append-only and checkpointed after a conversation, so collector or browser restarts can resume only after user confirmation.

### Provenance reference

Every derived record can cite platform, opaque account reference, conversation ID, capture ID, message ID, sequence, block ID, representation hash, and optional character range. Human-readable notes must show at least capture ID and message ID and retain a machine-readable full reference.

## Read-only ChatGPT sidebar inventory

1. Detect the authenticated ChatGPT sidebar without reading credentials or intercepting network traffic.
2. Incrementally observe visible conversation rows while scrolling because the sidebar may be virtualized.
3. Accumulate observations by stable conversation ID/URL where available; retain conflicting observations rather than merging by title.
4. Record initial, earliest, and latest boundary evidence plus warning viewports under the selective screenshot policy.
5. Require stabilized row count, stabilized scroll position, and verified earliest/latest boundaries before calling inventory complete.
6. Restore the initial sidebar scroll position where possible and record restoration success.
7. If IDs are unavailable, rows collide, boundaries are uncertain, or the UI changes, finish as `needs_review` and prohibit `missing` classification.

Inventory acceptance gate: manually compare one complete sidebar inventory against the visible ChatGPT sidebar before it can feed recapture selection.

## Classification rules

- `new`: a stable inventory conversation identity has never appeared in the catalog.
- `possibly_changed`: the conversation exists, but title, visible status metadata, observation fingerprint, or latest known capture evidence differs; or the last capture was incomplete/old enough to require confirmation.
- `unchanged`: inventory identity and available stable hints match the last observation and the latest capture is verified complete. This means "no visible inventory evidence of change," not proof that remote content is byte-identical.
- `missing`: previously cataloged but absent from a fully verified inventory of the same opaque account. Missing records are retained forever and never treated as deleted proof.
- `needs_review`: identity collision, incomplete inventory, uncertain boundary, ambiguous hash match, branch uncertainty, capture warning, or other material verification failure.

Classification stores reason codes and supporting observation IDs. A partial inventory may classify observed rows as `new` or `possibly_changed`, but may not classify unseen rows as `missing` or confidently `unchanged`.

## Incremental immutable recapture

1. User approves selected `new`, `possibly_changed`, or `needs_review` conversations.
2. The extension navigates to one approved conversation and uses the existing capture protocol.
3. The collector writes a full immutable capture before catalog mutation.
4. Manifest and representation hashes are independently verified.
5. The catalog transaction adds the version and computes message-level relationships: added, unchanged, changed representation, reordered/reparented, absent in new accessible view, or ambiguous.
6. The prior capture remains untouched. Any apparent removal is recorded as a version difference, never deletion.
7. A capture that does not satisfy existing verification rules remains `partial` or `needs_review`; classification rules are not weakened to obtain a pass.

## Resumable sequential batch processing

The initial runner processes one explicitly selected conversation at a time in one browser tab. It checkpoints after every state transition and has pause, resume-with-confirmation, and cancel controls. It stops automatically on authentication changes, challenge pages, navigation uncertainty, collector failure, repeated adapter failures, or possible rate limiting.

Pacing is configurable and tested with a fake clock. Start conservatively with randomized 15–45 second inter-conversation delays, a longer cooldown after every small group, no parallel tabs, capped retries, and exponential backoff. These are safety defaults to validate, not claims about platform rate limits. No unattended run is enabled in this slice.

## Windows Task Scheduler

Create a generator for a disabled, current-user task definition and a dry-run validator. The future task should start the local collector/orchestrator, verify the approved archive root, write local logs, and exit safely if Chrome authentication or explicit capture authorization is unavailable. Do not embed credentials.

Registration, enabling, daily timing, wake behavior, and whether a logged-in interactive session is required are separate approval decisions. Scheduling must not bypass the real-capture approval gate; initially it can refresh local catalog state and report that capture approval is needed.

## PostgreSQL and pgvector ingestion

Build this as a disconnected derived pipeline:

- versioned SQL migrations for platforms, accounts, conversations, captures, messages, content blocks, branches, citations, attachments, artifacts, verification results, provenance links, and embeddings;
- deterministic export records generated only from hash-verified captures approved for derivation;
- capture ID/message ID uniqueness and foreign keys that prevent loss of provenance;
- idempotent ingestion keyed by capture and representation hashes;
- vector model name/version/dimensions stored with every embedding;
- no embedding generation in the preservation process and no vectors written back to captures.

Tests use fixtures and, only after approval, an ephemeral local PostgreSQL instance. No cloud database connection is part of this slice.

## Obsidian note generation

Generate deterministic Markdown from approved derived records, never directly into the raw archive. Notes include YAML provenance, conversation/capture metadata, exact capture and message citations, and clear labels for quoted versus summarized content. A citation resolver can map a stable local reference such as `hhs-capture://<capture-id>/message/<message-id>` to the immutable archive and verify the cited representation hash.

Golden-file tests run in a repository fixture directory. A real vault path, note organization, overwrite/conflict behavior, and attachment policy require approval. Regeneration must be deterministic and must not rewrite user-authored notes without an explicit merge policy.

## Test and acceptance strategy

- Synthetic sidebar fixtures covering virtualization, duplicate titles, missing IDs, lazy loading, boundary failures, and UI mutations.
- Adapter tests proving shared packages contain no ChatGPT selectors or assumptions.
- Catalog migration, transaction, corruption recovery, and full rebuild tests.
- A classification truth table including partial inventories and identity collisions.
- Immutable recapture tests for additions, edits, order changes, branches, disappearing accessible content, and ambiguous matches.
- Batch state-machine crash/restart tests, fake-clock pacing tests, retry caps, stop conditions, and approval-gate tests.
- Task XML generation/validation tests without registration.
- PostgreSQL migration and idempotency tests against fixtures before any database connection.
- Obsidian golden files and citation-resolution/hash-verification tests.
- Manual gates: one verified sidebar inventory, one approved changed-conversation recapture, then a small explicitly approved sequential batch.

## Implementation sequence

### 2A — Freeze baseline and contracts

Record this acceptance result, add minimal inventory/catalog schemas and threat boundaries, and preserve the existing capture behavior with regression fixtures.

Exit gate: current capture checks still pass and the baseline report remains independently hash-verifiable.

### 2B — One-account inventory and catalog

Implement virtualized sidebar accumulation, inventory verification, append-only inventory manifests, and the rebuildable local catalog.

Exit gate: one user-approved sidebar inventory is manually reconciled; no conversations are opened or captured by inventory.

### 2C — Classification and manual recapture

Implement reasoned classification, full immutable recapture, and message-hash version comparison.

Exit gate: one explicitly approved changed conversation produces two intact versions and an accurate, reviewable difference report.

### 2D — Resumable foreground batch

Implement explicit selection, sequential orchestration, checkpointing, pacing, pause/cancel, stop conditions, and restart recovery. Keep execution disabled until separately approved.

Exit gate: synthetic jobs survive interruption; then a small real batch requires a new explicit approval.

### 2E — Scheduler artifacts

Generate and validate disabled Task Scheduler definitions and operating instructions. Do not register or enable them.

Exit gate: dry-run output is reviewable and contains no credentials or path escapes.

### 2F — Disconnected PostgreSQL/pgvector export

Add provenance schema, migrations, deterministic exports, and fixture tests. Do not connect a database.

Exit gate: every exported row resolves to a hash-verified capture/message/block in fixtures.

### 2G — Obsidian export

Add deterministic, citation-rich note generation against fixture vaults. Do not write to a real vault.

Exit gate: notes pass golden tests and every citation resolves and verifies.

## Known limitations retained

- A complete capture means complete relative to the authorized, accessible rendered interface and verification evidence; it cannot establish recovery of hidden, deleted, or unavailable data.
- Sidebar hints cannot prove remote conversation content is unchanged.
- ChatGPT DOM and accessibility structure can change without notice.
- Existing-alternative branch traversal is not yet complete; indicated uncaptured alternatives prohibit completion.
- Scheduled browser capture may require an interactive logged-in Windows session and must not evade authentication or platform controls.
- Application-level archive encryption is still deferred; existing Windows disk protection remains the initial control.

## Decisions to confirm at each gate

The recommended defaults are SQLite for the rebuildable private catalog, one foreground tab, conservative randomized pacing, disabled scheduler artifacts, disconnected PostgreSQL exports, and fixture-only Obsidian output. Before later activation, obtain explicit approval for:

1. the first real sidebar inventory;
2. each real recapture or batch selection;
3. installing any new SQLite/PostgreSQL-related dependency;
4. registering or enabling a Windows scheduled task;
5. connecting any PostgreSQL instance or embedding provider;
6. the real Obsidian vault path and conflict policy.
