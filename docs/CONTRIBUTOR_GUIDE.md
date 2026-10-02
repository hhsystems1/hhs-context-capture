# HHS Context Capture Contributor Guide

This guide is for current and future contributors. It describes the local system without exposing any private identity, path, credential, or capture value. Replace placeholders only in ignored local configuration, never in tracked files.

## The fifth-grade explanation

HHS Context Capture is like a careful librarian.

When a person says it is okay to save one open AI conversation, the Chrome extension reads what the person can see. It hands the result to a helper program running on the same computer. The helper checks the package, saves a copy that cannot be silently replaced, and writes a safe diary of what happened.

The diary does not copy the conversation. It says things such as “capture started,” “the package reached the helper,” and “the archive was finished.” Each diary line has a number and a fingerprint. Missing, reordered, or changed lines are rejected.

Another local program can later read an approved archive into PostgreSQL. It first creates proposed knowledge with exact links back to source blocks. A human must approve knowledge; the system does not approve it automatically.

Everything stays local. Publishing is blocked.

## What the project is

HHS Context Capture preserves exact accessible rendered AI conversations and supporting evidence after a person explicitly authorizes a capture. ChatGPT is the first adapter, but the capture contracts and operations log are platform-neutral.

The project does not claim access to hidden reasoning, server-only data, deleted content, private prompts, inaccessible branches, or original Markdown that the rendered page does not expose.

## Architecture and data flow

```text
Contributor
    |
    v
Chrome popup -> content adapter -> extension worker
    |                |                  |
    | safe events    | capture bundle   | authenticated loopback delivery
    +----------------+------------------+
                                      |
                                      v
                              Local collector
                              /             \
                             v               v
                  immutable archive      local PostgreSQL
                  source payloads        operation events
                  and hash indexes       reports and Memory V1.1
                             \               /
                              v             v
                         private receipts and proofs
```

The extension is not authoritative. PostgreSQL is authoritative for operational state. The private archive is authoritative for captured source bytes. Git contains code, schemas, migrations, tests, and redacted documentation only.

## Component responsibilities

### Chrome extension

- Starts only after a manual contributor action.
- Observes the active supported page and creates opaque operation and correlation IDs.
- Extracts accessible rendered content through a platform adapter.
- Emits safe lifecycle events without transcript content.
- Streams the capture only to the loopback collector.
- Keeps at most five safe recent status summaries for the popup.
- Reconciles that cache with the collector after reopening.
- Never acts as the authoritative operation log.

### Local collector

- Listens on loopback only.
- Uses a one-time pairing code to issue an in-memory session token.
- Validates capture and inventory schemas.
- Validates operation identity, sequence, transitions, hashes, and privacy metadata.
- Persists authoritative events to local PostgreSQL.
- Writes immutable capture archives and separate operational receipts.
- Exposes authenticated local read-only operation reports.

### Immutable archive

- Stores source capture versions using exclusive writes.
- Stores raw sanitized evidence, canonical and normalized forms, verification, manifests, and hashes.
- Never mixes operational event logs into source-capture directories.
- Stores operations, proofs, and backups under separate private operations boundaries.
- Is configured at runtime with `HHS_ARCHIVE_ROOT`.

### Local Supabase/PostgreSQL

- Runs in local Docker containers.
- Stores Memory V1.1 lineage, proposals, provenance, exact hash resolutions, quarantine, and proof indexes.
- Stores Capture Operations V1 operation headers, immutable events, and receipt indexes.
- Enforces workspace isolation, sequence monotonicity, state transitions, terminal states, immutability, idempotency, and least privilege.
- Provides security-invoker read-only reports.

## Inventory, capture, and ingestion

| Term | Plain meaning | Writes conversation content? |
|---|---|---:|
| Inventory | A read-only list of conversations visible in the sidebar | No |
| Capture | One authorized preservation of the currently open conversation | Yes, to a new immutable archive version |
| Ingestion | Reading one approved archived capture into local PostgreSQL Memory tables | It reads the archive; it does not recapture |

Never describe inventory as capture, or capture as ingestion.

## Evidence and knowledge

- Raw evidence is what the adapter observed: sanitized DOM evidence, screenshots, extraction observations, and exact representations.
- Proposed knowledge is a deterministic candidate derived from source message ranges. It is not accepted truth.
- Approved knowledge requires a later human review event. Capture and ingestion never approve knowledge automatically.
- Provenance connects every trusted derived record to a workspace, platform, account, conversation, capture, message or range, evidence locator, exact archived hash, ingestion run, and pipeline version.
- Exact hash resolution proves that the representation used by a derived record is byte-for-byte the representation preserved in the archive.

## States

Capture Operations uses these nonterminal states:

- `created`: the operation identity exists.
- `pairing`: a local pairing attempt is underway.
- `prepared`: identity is observed or pairing succeeded.
- `capturing`: page extraction started.
- `delivering`: the extension is sending the local payload.
- `archiving`: the collector is writing the immutable version.
- `verifying`: capture verification finished writing and is being classified.

Terminal states:

- `completed`: archive and verification completed successfully.
- `needs_review`: archive exists, but a warning or comparison needs human review.
- `failed`: a known failure ended the attempt.
- `interrupted`: progress stopped and explicit reconciliation classified it.
- `canceled`: the contributor canceled it.

Memory ingestion also uses `partial`, `failed`, `quarantined`, and dead-letter records:

- `partial` means a durable checkpoint exists but the ingestion run is not complete.
- `quarantined` means fatal evidence made that ingestion run terminal.
- A dead letter records an operation that could not be processed normally and may need an explicit later action. It is not an automatic retry queue.

Terminal capture operations never reopen. A retry receives a new operation ID and a parent-operation link.

## IDs, checkpoints, events, and receipts

- `operation_id` identifies one attempt.
- `correlation_id` follows that attempt across extension and collector components.
- `event_sequence` starts at 1 and must be contiguous.
- `event_sha256` fingerprints the authoritative safe event.
- `idempotency_key` makes an identical replay return the existing event.
- A checkpoint records durable progress for resumable ingestion.
- An event records one durable capture-operation transition.
- A receipt is an append-only file with a manifest and SHA-256 index.
- A proof receipt records a synthetic acceptance result. It is separate from source evidence.

Popup closure and browser restart may erase in-memory work, but they do not erase committed PostgreSQL events or private receipts.

## Pipeline generations and retry lineage

A pipeline version is part of every derived identity. Replaying the same capture with the same version is idempotent. Running a different version creates a separate generation and cannot overwrite an earlier one.

A failed or interrupted capture retry follows the same rule: create a new operation and set `parent_operation_id`. Never reuse the terminal parent.

## Workspace isolation

Every database operation runs with a transaction-local workspace setting. Composite keys, foreign keys, forced row-level security, and security-definer functions reject cross-workspace references. Do not bypass this with an owner connection in application code.

## Privacy and publication

Tracked files must not contain:

- private usernames or absolute private paths;
- populated credentials, tokens, pairing codes, or database URLs;
- real account, conversation, workspace, capture, or operation identifiers;
- transcript content, archive payloads, screenshots, DOM, or runtime database state.

Use `.env.example` for redacted placeholders and `.env.memory-v1.local` for ignored local values. The pre-push hook and `PUBLICATION_BLOCKED.md` remain authoritative. Do not add a remote or bypass the hook.

Operational metadata is an allowlist, not a general logging object. Never log arbitrary exceptions.

## Private storage map

All exact roots come from ignored local configuration:

| Data | Location rule |
|---|---|
| Source captures | beneath `HHS_ARCHIVE_ROOT/captures` |
| Inventory records | beneath `HHS_ARCHIVE_ROOT/inventories` |
| Capture operation event receipts | beneath `HHS_ARCHIVE_ROOT/operations/capture-operations-v1/events` |
| Capture Operations synthetic proofs | beneath `HHS_ARCHIVE_ROOT/operations/proofs/capture-operations-v1` |
| Memory proofs | `MEMORY_PROOF_ROOT` |
| Database backups | beneath the approved private operations backup boundary |
| Local credentials and identities | ignored `.env.memory-v1.local` |

Do not copy any of these values into an issue, commit, screenshot, chat, or tracked document.

## Contributor checklist

- [ ] Read this guide, `SECURITY_AND_PRIVACY.md`, and `PUBLICATION_BLOCKED.md`.
- [ ] Confirm there are no Git remotes.
- [ ] Confirm the worktree is clean before starting.
- [ ] Start Docker Desktop and local Supabase.
- [ ] Confirm ignored local configuration exists.
- [ ] Start the collector and pair the extension.
- [ ] Obtain explicit approval for the exact conversation before capture.
- [ ] Keep the exact tab active until the operation reaches a terminal state.
- [ ] Inspect `npm run operations:report`.
- [ ] Run tests, privacy scans, and database lint before checkpointing.
- [ ] Create a recoverable database backup before migrations.
- [ ] Never push, publish, deploy, schedule, batch-capture, or add external integrations.

## Glossary

- Adapter: code that knows how to read one platform’s rendered interface.
- Append-only: new records may be added; old records cannot be rewritten or deleted.
- Archive: the private immutable files for one capture version.
- Capture: one authorized attempt to preserve the open conversation.
- Checkpoint: durable progress from which an ingestion may continue.
- Correlation ID: an opaque ID connecting events from different components.
- Dead letter: a durable record of work that could not be processed normally.
- Evidence: preserved material supporting what the system observed.
- Hash: a fingerprint used to detect changed bytes.
- Idempotent: repeating the exact same request does not create a duplicate.
- Ingestion: importing an approved archive into local Memory tables.
- Inventory: a read-only observation of visible conversation-list entries.
- Operation: one pairing, capture, or recapture attempt.
- Pipeline generation: derived records made by one named pipeline version.
- Provenance: the exact chain from a derived record back to its source.
- Quarantine: terminal isolation caused by invalid or fatal evidence.
- Receipt: a small immutable record plus a manifest and hashes.
- Reconciliation: explicitly classifying stale nonterminal work; never completing it.
- Retry lineage: a new attempt’s link to its failed, interrupted, or canceled parent.
- Workspace: the database isolation boundary for one local context.

See [LOCAL_OPERATIONS_RUNBOOK.md](LOCAL_OPERATIONS_RUNBOOK.md) for commands and troubleshooting and [CAPTURE_OPERATIONS_LOGGING_V1.md](CAPTURE_OPERATIONS_LOGGING_V1.md) for the event contract.
