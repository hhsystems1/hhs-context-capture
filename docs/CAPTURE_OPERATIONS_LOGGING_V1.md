# Capture Operations Logging V1

Capture Operations Logging V1 is the authoritative, local-only operational history for pairing, capture, and recapture attempts. It is platform-neutral and contains no source conversation payload.

## Durable boundaries

- PostgreSQL stores operation identity, current state, immutable events, and receipt indexes.
- `HHS_ARCHIVE_ROOT/operations/capture-operations-v1/events` stores append-only event receipts.
- `HHS_ARCHIVE_ROOT/operations/proofs/capture-operations-v1` stores synthetic acceptance proofs.
- Chrome storage keeps at most five safe recent summaries for user experience.
- Source captures remain beneath the capture archive boundary and never contain operational logs.

PostgreSQL and private receipts survive popup, service-worker, collector, browser, and computer restart.

## Operation state machine

```text
created
  |-- pairing_requested --> pairing -- pairing_succeeded --> prepared
  |                                  \- pairing_failed ----> failed
  |
  |-- identity_observed -----------------------------------> prepared

prepared -- capture_started --> capturing -- delivery_started --> delivering
delivering -- delivery_succeeded --> delivering -- archive_started --> archiving
archiving -- archive_completed --> archiving -- verification_completed --> verifying
verifying -- capture_completed ----> completed
          \- capture_needs_review --> needs_review

Any nonterminal state -- capture_failed ------> failed
Any nonterminal state -- capture_interrupted -> interrupted
Any nonterminal state -- operation_canceled --> canceled
```

`completed`, `needs_review`, `failed`, `interrupted`, and `canceled` are terminal. A retry is a new operation whose `parent_operation_id` points to a `failed`, `interrupted`, or `canceled` operation.

## Supported events

1. `operation_created`
2. `pairing_requested`
3. `pairing_succeeded`
4. `pairing_failed`
5. `identity_observed`
6. `identity_verified`
7. `identity_mismatch`
8. `capture_requested`
9. `capture_started`
10. `capture_progress`
11. `collector_delivery_started`
12. `collector_delivery_succeeded`
13. `collector_delivery_failed`
14. `archive_started`
15. `archive_completed`
16. `verification_completed`
17. `capture_completed`
18. `capture_needs_review`
19. `capture_failed`
20. `capture_interrupted`
21. `operation_canceled`

Every authoritative event has an operation and correlation ID, workspace, source component, event type, contiguous sequence, timestamp, resulting state, allowlisted metadata, schema version, SHA-256, and idempotency key.

## Database enforcement

Migration `20260723030000_capture_operations_v1.sql` creates schema `capture_ops`. Follow-up migration `20260723030100_capture_operations_v1_lint.sql` corrects the transition function’s declared volatility without changing data or behavior. Migration `20260723030200_capture_operations_privacy_guards.sql` mirrors the application error-code, summary, verification-status, and safe-reference allowlists inside PostgreSQL.

The application writer cannot insert, update, or delete base rows directly. It may execute controlled creation, append, reconciliation, and receipt-registration functions. The reader receives `SELECT` only.

PostgreSQL enforces:

- forced workspace row-level security;
- parent-operation workspace and terminal-state constraints;
- exactly one contiguous event sequence;
- nondecreasing event timestamps;
- event/state transition agreement;
- terminal-state protection;
- immutable event and receipt rows;
- immutable operation identity and lineage;
- event-hash mismatch rejection;
- unique idempotency and sequence keys;
- safe metadata keys and scalar values;
- rejection of paths, URLs, credential-like material, and payload fields; and
- one-time safe capture and archive-hash linkage.

## Metadata allowlist

Allowed keys:

- `stage`
- `progress_current`
- `progress_total`
- `message_count`
- `content_block_count`
- `safe_error_code`
- `safe_error_summary`
- `verification_status`
- `delivery_receipt_sha256`
- `archive_manifest_sha256`
- `safe_capture_reference`
- `reason_code`
- `timeout_seconds`
- `last_successful_stage`
- `identity_verified`
- `archive_created`
- `retry_safe`

Values must be bounded scalars. Error summaries must match an allowlisted error code. Unknown keys and nested objects are rejected.

Never include transcript text, prompts, responses, DOM, HTML, screenshots, attachments, raw payloads, arbitrary exceptions, pairing codes, tokens, credentials, cookies, authorization headers, private keys, full paths, or populated URLs.

## Receipts

Each accepted event receives a deterministic directory based on operation ID, sequence, and event hash. It contains:

- `receipt.json`
- `manifest.json`
- `hashes.sha256`

Writes use a private staging directory and atomic rename. Replaying the same event verifies and reuses the same receipt. The database stores only its relative locator and hashes.

## Reconciliation

Reconciliation is explicit. It requires a timeout of at least 60 seconds and a stale nonterminal operation. It appends `capture_interrupted` with the prior successful stage and reason `stale_timeout`.

It cannot mark an operation complete, cannot reopen terminal work, and never starts a retry.

## Read-only report

Run:

```powershell
npm run operations:report
```

The report answers:

- latest operation and final source component;
- whether capture and identity verification occurred;
- last successful stage;
- delivery, archive start, archive completion, and verification outcomes;
- safe capture reference;
- terminal result and safe stop reason;
- retry safety and parent/retry links; and
- stuck or nonterminal operations.

It runs through the local report-reader role in a read-only transaction.

## Synthetic acceptance

`npm run operations:prove` creates synthetic operations only. It covers successful, failed, needs-review, interrupted, replay, ordering, transition, terminal, retry, workspace, hash, privacy, restart, and report behavior. It never runs the browser adapter or writes a source capture.

Proofs are append-only and do not modify Memory V1.1 proof directories.
