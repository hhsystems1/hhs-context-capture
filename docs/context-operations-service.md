# Bounded Context Operations service

Core resolves `brain_binding -> memory_workspace_id` and calls this trusted local service. Browser requests are rejected. Mission Control remains a read-only operator console; provisioning and query retain their own credential boundaries.

Run `npm run memory:context:operations:service` in a dedicated trusted environment. No env file is loaded by the service entrypoint. Configuration:

- `MEMORY_CONTEXT_OPERATIONS_TOKENS`: comma-separated `<client>:<32+ character token>` entries with unique names and tokens. Only hashes are retained in service configuration.
- `MEMORY_CONTEXT_OPERATIONS_PORT`: default `54433`.
- Existing `MEMORY_REPORT_DATABASE_URL` using `memory_v1_report_login` and `MEMORY_INGEST_DATABASE_URL` using `memory_v1_ingest_login`, both loopback PostgreSQL credentials. Admin, reviewer, query-service and provisioning-service credentials are refused.
- The existing runner still requires its existing trusted local provider/configuration setup, including its existing child CLI env-file behavior. This slice does not provision or redesign those credentials. Operations bearer tokens are removed from the spawned child's environment.

The server binds `127.0.0.1` only. Requests require the exact `Host: 127.0.0.1:<listening port>`, no Origin header, and `Authorization: Bearer <token>`. There are no redirects, CORS, admin fallback, or raw error logging.

| Method | Route | Input |
| --- | --- | --- |
| GET | `/memory/workspaces/:workspace/reconstruction/status` | No request body or query string |
| POST | `/memory/workspaces/:workspace/reconstruction/start` | JSON object below |
| POST | `/memory/workspaces/:workspace/reconstruction/resume` | Same JSON object |

Workspace IDs must exactly match `workspace_[0-9a-f]{32}`. POST requires `Content-Type: application/json`; the maximum body size is 4096 bytes. Only `limit` (integer 1–10, default 10) and `conversation` (optional source conversation ID matching `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`) are accepted. All other keys are rejected. The runner checks actual candidate eligibility.

Both POST routes use `spawn(process.execPath, argv, { shell: false, ... })` to invoke **only** `scripts/run-reconstruction-batch.mjs --workspace <workspace> --limit <limit> --operation-id <operation_id> [--conversation <id>]`. Start and Resume differ only in the returned intent. Neither resets artifacts or introduces execution/reconstruction logic. Acceptance is HTTP 202 with `workspace_id`, `operation_id`, `intent`, and `state` (`unknown` until spawn is confirmed). HTTP 409 reports `operation_active` with the in-process operation ID, or `execution_active_or_unresolved` for durable exclusion/unresolved prior running state.

Status reuses `MissionControlStore.statusSummary()` for memory counts and `loadReconstructionInventory` for reconstruction coverage. Both share one long-lived report-reader pool owned by the service and closed on shutdown or startup failure. Inventory status transactions apply the same 5-second statement and 2-second lock timeouts as Mission Control; Start/Resume preflight uses this same bounded path. No pilot artifact is implicitly accepted as persisted processing. Batch receipt completion is separate from corpus/reconciliation coverage and approved-memory authority.

Allowlisted status fields:

- `workspace_id`, `state`, `available`.
- Where supported: `operation_id`, `started_at`, `finished_at`, `requested`, `selected`, `completed_count`, `quarantined_count`.
- `process_finished_at`, `process_termination`, `process_exit_code` describe process termination only.
- `prepared_artifact_review_required` is a fixed boolean for source-identity/evidence mismatch quarantine; reasons, titles, raw responses and paths are omitted.
- `memory`: `messages`, `blocks`, `proposed`, `approved`.
- `reconstruction`: existing inventory summary fields `total_clean_conversations`, `discovery_processed`, `unprocessed`, `awaiting_reconciliation`, `observations_awaiting_reconciliation`, `reconciled`, `evidence_issues`, `zero_evidence`, `needs_review`, `other_evidence_issues`, `batches_total`, `batches_complete`, `batches_partial`, `remaining_conversations`, `next_batch`.

States are `idle`, `unknown` (spawn pending), `running` (spawn confirmed in this service instance, exit/close/error not observed), `completed`, `partial`, `failed`, `interrupted`, or `unavailable`. Read failure/malformed summaries return HTTP 503 with `available: false`, `state: unavailable`, and a fixed error, without fabricated zero counts. Running JSON alone is never liveness evidence. Spawn errors fail closed. Exit 0/2 only record process termination; reconstruction outcomes come from the correlated batch receipt. Nonterminal correlated receipts after exit remain interrupted. A non-0/2 exit without a correlated receipt reports failed; exit 0/2 without a final receipt still reports interrupted rather than fabricating completion.

## Execution identity and exclusion

`.runtime/reconstruction/context-operations/<operation_id>.json` records only execution identity/times/termination. The existing batch receipt optionally carries the same operation ID; direct CLI usage remains valid. Receipt filenames include the optional operation ID to prevent same-timestamp service-run collisions.

An exclusive `execution.lock` in that directory serializes service execution globally, also protecting the existing shared prepared-artifact paths across workspaces. Normal exit 0/2, spawn failure, or termination without any correlated batch receipt releases only this liveness exclusion file. A non-0/2 exit without a receipt reports failed and permits retry. Reconstruction receipts, priority/oversized runs, observations, reconciliation and proof data are never removed by the service. The runner retains its existing retry/archive behavior.

Service restart never reclaims an unresolved lock automatically. It reports durable unresolved operations as interrupted and refuses another launch. Unexpected exits with a correlated batch receipt retain exclusion because subprocess liveness cannot be established safely from a parent PID. Recovery requires an operator to establish that **all** prior runner/subprocess work has stopped and resolve only the execution lock through a separate explicitly authorized operation. There is deliberately no recovery/reset HTTP endpoint in this slice. Independently launched CLI runs do not acquire this service lock; existing unresolved running CLI receipts block service starts, but a CLI launch racing a service is outside this first-slice coordination contract.

Latest service operations sort by start timestamp then operation ID (descending). Legacy batch receipts use start timestamp then operation ID or stable receipt filename. Status describes the latest service operation when one exists; unrelated later CLI receipts cannot replace its correlated outcome. Mission Control already uses `created_at desc,operation_id asc`; its ordering is unchanged.

## Prepared-artifact source refresh

The existing runner now compares a reused standard/oversized parent exchange's conversation, source-version and capture-version identity with the current existing inventory before generation or persistence. Missing/changed identities quarantine the candidate and retain artifacts. The existing trusted persistence path additionally checks exchange identity and full evidence/hash equality against current database evidence. This does not redesign invalidation, delete artifacts, or automatically prepare replacements.

Follow-up for automatic refresh: an authoritative workspace-scoped corpus generation/source identity contract binding parent and chunk exchanges/manifests to current source-version, capture-version, content hash and resolved evidence hash, plus an explicit operator-approved preserve-and-reprepare policy. Same-version content/evidence changes remain protected by the existing persistence equality check, rather than a guessed chunk invalidation algorithm.

## Proof boundaries

Tests inject reporting, child process events and temporary liveness/receipt storage. No provider, real batch, persistent database or proof-workspace mutation is needed. Real loopback HTTP acceptance, real process/service restart behavior and Core brain-binding/token integration still need separately authorized acceptance in an environment allowing sockets. Existing query/provisioning socket tests and tsx IPC-based inventory CLI tests cannot run successfully in the restricted execution sandbox (`listen EPERM`).
