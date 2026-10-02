# Phase 2C Plan: Controlled Immutable Recapture and Message-Level Change Comparison

Status: first manually confirmed recapture accepted; corrective hardening completed locally

Precondition: verified read-only inventory and catalog baseline

Scope: one manually selected conversation at a time

## Objective

Phase 2C will let the user select a cataloged conversation, create a new complete immutable capture version, and compare it with the latest eligible prior version. It will preserve every version and produce an evidence-backed operational change report without summarizing, extracting knowledge, or modifying ChatGPT.

## Verified acceptance outcome

One manually opened, catalog-matched conversation was recaptured after separate preparation and confirmation. The new immutable version passed every capture check with no warnings, retained the prior version, increased the accessible transcript from 8 to 10 messages, added the catalog reference transactionally, and produced a hash-valid comparison. Corrective ruleset 0.2 identifies two appended messages, four rendered-structure changes, and zero textual edits; content-block and artifact dimensions remain separately visible. Historical archive files and transaction journals were not rewritten.

The first vertical slice will never navigate to a conversation automatically. The user will select a catalog record, manually open that exact conversation in ChatGPT, and separately approve capture after the extension confirms that the active URL matches the selected catalog identity.

## Explicit exclusions

- No automatic knowledge extraction, summaries, embeddings, or semantic interpretation.
- No unattended or multi-conversation batch capture.
- No scheduled task.
- No PostgreSQL, pgvector, Supabase, Convex, Obsidian, cloud service, telemetry, deployment, publishing, or push.
- No automatic opening, editing, regenerating, submitting, sharing, archiving, deleting, or renaming of ChatGPT conversations.
- No weakening of capture or verification rules to obtain a complete result.

## Preservation boundary

The immutable capture archive remains authoritative. A comparison is operational metadata derived from two immutable capture versions. It must cite exact capture, message, block, branch, attachment, citation, artifact, representation, and hash identifiers. It must never modify either source capture or replace preserved evidence.

An apparent removal means only that content was not present on the newly captured active path. It is never treated as proof of server deletion and never authorizes deletion from the archive or catalog.

## Proposed components

```text
packages/
  capture-versioning/       # immutable version references and archive reconciliation
  capture-comparison/       # platform-neutral matching and change classifications
  review-queue/             # durable uncertainty records and resolution audit

apps/local-collector/src/
  recapture/                # selection intents, checkpoints, and recovery
  comparisons/              # validation and private comparison storage

apps/browser-extension/src/
  recapture/                # active-tab identity check and explicit capture confirmation

docs/
  RECAPTURE_PROTOCOL.md
  MESSAGE_COMPARISON_STANDARD.md
```

Packages will be introduced only when exercised by the smallest vertical slice. ChatGPT selectors and URL parsing remain inside the ChatGPT adapter; versioning and comparison contracts remain platform-neutral.

## Manual selection and authorization

1. The collector exposes a read-only list of catalog records containing opaque catalog key, title, source URL, current classification, latest capture status, and review state.
2. The user manually selects exactly one catalog record. Selection creates a durable local intent with a random intent ID, selected conversation identity, creation time, and `awaiting_manual_open` status. It does not contact ChatGPT.
3. The user manually opens the selected conversation in Chrome.
4. The extension compares the active platform, opaque account reference, and stable conversation ID with the intent. A mismatch blocks capture.
5. The extension shows the selected title and explicit statement that a new immutable version will be captured. The user must confirm again.
6. Only that confirmation authorizes the existing capture engine to run once.

Closing the popup, changing tabs, changing account identity, changing the active conversation, or expiring the intent returns the operation to a safe stopped state. Selection never authorizes a different conversation or a later capture.

## Archive-to-catalog reconciliation

The current catalog was created from sidebar observations, while some immutable captures predate the catalog. Before comparing versions, a read-only reconciler will:

1. scan capture manifests only beneath the approved private archive;
2. verify each capture's archive hashes and verification report;
3. match platform, opaque account reference, and stable conversation identity;
4. add immutable capture references to the catalog in a hash-verified transaction;
5. reject conflicting capture IDs or archive paths;
6. route corrupt, ambiguous, cross-account, or unmatched records to review;
7. never rewrite, move, rename, or delete a capture.

Reconciliation is idempotent and resumable. A repeated valid capture reference has no effect. A repeated capture ID with different metadata is a material conflict.

## Immutable capture versions

Every approved recapture writes a full capture using a new capture ID and archive directory. Delta-only preservation is prohibited. A version reference records:

- platform, opaque account reference, and conversation identity;
- capture ID, archive path, capture time, schema and adapter versions;
- capture and verification status;
- manifest SHA-256 and required archive-file hashes;
- ordered message IDs and representation hashes;
- active-path and branch identifiers;
- attachment, citation, and artifact identity/hash summaries.

The catalog appends the version reference only after the archive is finalized and independently hash-verified. All earlier versions remain addressable and unchanged.

## Comparison eligibility

The comparison engine accepts two immutable versions of the same platform, opaque account, and conversation. The preferred baseline is the most recent prior version whose required files and hashes verify.

- Two `complete` versions may produce confirmed change classifications.
- A `partial` or `needs_review` version may be compared for diagnostic evidence, but material conclusions remain `uncertain`.
- A `failed` version cannot be a confirmed comparison baseline.
- Unverified hashes, account mismatch, conversation mismatch, uncaptured alternatives, or material truncation prohibit a confident result.

## Message matching

Matching is deterministic and evidence-backed. It uses this priority:

1. unique stable platform message ID;
2. unique canonical message ID known to persist across versions;
3. parent/branch identity plus role and exact representation hashes;
4. role, sequence neighborhood, parent relationship, and exact representation hashes;
5. otherwise no automatic match.

A fallback match must record its method and confidence. Ambiguous candidates are never chosen silently; they create `uncertain` records.

For every candidate pair, comparison includes:

- sequence and role;
- parent and branch relationships;
- inner-text, text-content, sanitized-HTML, and canonical-text hashes;
- ordered content blocks and block hashes;
- code, table, list, heading, link, and other structural block types;
- attachments and availability metadata;
- citations, labels, and source references;
- artifact identities and preserved representations;
- visible tool events when present.

Text is not normalized again during comparison. A difference in any preserved representation remains visible even if canonical text happens to match.

## Change classifications

Each classification cites both capture IDs and all supporting message/block/hash evidence.

### `unchanged`

A uniquely matched message has the same role, relationships, representations, content blocks, attachments, citations, artifacts, and relevant tool-event hashes.

### `appended`

A new message or ordered group appears after the confirmed prior active-path tail, with an unambiguous parent chain. New material inserted elsewhere is not called appended automatically.

### `edited`

The same stable user or assistant message identity remains in the graph but one or more preserved representations, content blocks, role, attachment references, citations, or artifacts changed. The report preserves before/after hashes and never treats the newer form as replacing the older archive version.

### `regenerated`

An assistant response is an alternative child of the same prompt/parent, or the interface provides branch evidence linking it to a regenerated alternative. Mere textual difference without stable parent/branch evidence is `uncertain`, not automatically regenerated.

### `branched`

New or changed parent/alternative relationships, branch identifiers, active indices, or accessible alternative counts are observed. If indicated alternatives were not completely captured, the comparison and new capture require review.

### `removed_from_active_path`

A previously matched active-path message is absent from the new active path or has moved to a captured alternative branch. It remains retained in every prior version. If the new version is incomplete or branch coverage is uncertain, use `uncertain` instead.

### `uncertain`

Identity ambiguity, conflicting fallback matches, role uncertainty, incomplete boundaries, truncation, missing alternatives, changed platform semantics, unavailable required evidence, hash failure, or incompatible schema/adapter behavior prevents a stronger conclusion.

Nested changes to attachments, citations, artifacts, and tool events receive their own reason codes in addition to the message-level classification.

## Comparison record

A private immutable comparison report contains:

- comparison ID and ruleset version;
- prior and current capture IDs, manifest hashes, and verification statuses;
- deterministic input fingerprint and report SHA-256;
- ordered match records with method and confidence;
- every change classification and reason code;
- before/after message, block, branch, attachment, citation, artifact, and representation hashes;
- unmatched candidates and ambiguity evidence;
- warnings and review-queue item IDs;
- creation time and collector version.

Comparison reports are stored outside the code repository beneath the approved private archive and added to an append-only manifest. Repeating the same ruleset against identical capture hashes is idempotent.

## Resumability and failure recovery

A single-conversation recapture intent uses durable states:

```text
selected
awaiting_manual_open
identity_verified
awaiting_capture_confirmation
capturing
archive_written
archive_verified
comparing
catalog_committed
complete | needs_review | failed | cancelled
```

Every transition is append-only and checkpointed. Recovery rules:

- Before `capturing`, restart requires the user to reopen and reconfirm.
- If capture fails before archive finalization, keep diagnostics and require manual retry.
- If an immutable archive exists but the catalog update failed, reconcile that exact capture on restart rather than recapturing.
- If comparison fails, retain both captures, checkpoint `archive_verified`, and retry only comparison.
- If a catalog transaction was committed but acknowledgement was lost, idempotency returns the existing result.
- No failure path deletes a capture, prior version, comparison, review record, or evidence.

## Conservative pacing

The smallest slice permits one foreground recapture only. There is no queue runner. After any capture attempt, enforce a configurable local cooldown before another intent can be confirmed; start with 30–60 seconds and test it with a fake clock. There are no automatic retries.

Stop immediately on authentication changes, challenge pages, navigation mismatch, suspected rate limiting, adapter uncertainty, collector failure, or capture-verification failure. Any later sequential processing requires separate approval and must use randomized delays, capped retries, longer periodic cooldowns, and one tab only.

## Review queue

Material uncertainty creates a durable private review item containing:

- review ID, reason code, severity, and status;
- platform/account/conversation identity;
- prior/current capture and comparison IDs;
- affected message, branch, block, attachment, citation, or artifact IDs;
- exact evidence locators and hashes;
- recommended manual checks;
- append-only resolution history.

Statuses are `open`, `acknowledged`, `resolved`, or `accepted_uncertainty`. Resolution does not alter source captures or the original comparison report. The review queue performs no knowledge extraction.

## Test strategy

- Synthetic version pairs for unchanged, tail append, mid-path insert, stable-ID edit, regenerated alternative, new branch, active-path removal, attachment change, citation change, artifact change, and ambiguous identity.
- Exact representation tests covering whitespace, Unicode, code indentation, tables, lists, and repeated messages.
- Branch-graph fixtures covering active-path movement and uncaptured alternatives.
- Matching tests proving ambiguous fallback candidates become `uncertain`.
- Property tests for deterministic comparison output and version-order invariants.
- Immutable archive and capture-reference conflict tests.
- Reconciliation tests for valid, duplicate, corrupt, unmatched, and cross-account capture manifests.
- Crash/restart tests at every durable recapture state.
- Idempotency tests for archive acknowledgement loss, catalog retry, and comparison retry.
- Fake-clock cooldown and stop-condition tests.
- Source-level guards against automatic navigation, batch loops, scheduling, database clients, telemetry, and cloud endpoints.

## Smallest Phase 2C vertical slice

### 2C-A — Contracts and synthetic comparison

Implement the platform-neutral version reference, comparison record, change taxonomy, review item, and deterministic comparison engine. Exercise only synthetic capture bundles.

Exit gate: all classification fixtures and ambiguity safeguards pass without changing the capture engine.

### 2C-B — Read-only archive reconciliation

Reconcile existing verified captures into the private catalog using immutable references and transaction replay. Do not access ChatGPT.

Exit gate: a dry-run report is reviewed first; an explicitly approved reconciliation then adds references without altering archive files.

### 2C-C — One manual recapture

Add one-conversation selection intent, active-tab identity verification, explicit confirmation, full immutable capture, comparison, catalog commit, and review routing. Do not auto-open the conversation.

Exit gate: after separate approval naming one cataloged conversation, one real recapture creates a new verified archive version and a manually reviewable comparison. Stop immediately afterward.

## Exact implementation approval gate

Implementation must not begin until the user explicitly approves language equivalent to:

> I approve the smallest Phase 2C implementation: platform-neutral immutable capture-version and comparison contracts, synthetic change-classification tests, a private review queue, read-only archive-to-catalog reconciliation tooling, and a manually confirmed one-conversation recapture workflow that never navigates automatically. Do not run reconciliation against the private archive or perform a real recapture until I separately approve each operation.

After implementation, archive reconciliation and the first real recapture remain two separate approval gates. The recapture approval must identify the exact cataloged conversation and applies to one capture attempt only.
