# HHS Reconstruction Inventory V1

This read model is the deterministic control plane for chronological company
reconstruction. It does not discover, synthesize, reconcile, approve, or write
memory.

## Authority

Conversation identity and evidence health come from `memory_v1.conversations`,
the verified clean `memory_v1.source_versions`, their messages/content blocks,
and exact capture-version linkage. The corpus predicate is intentionally the
same 976-conversation native-export container plus verified-complete browser
captures used by understanding discovery.

The older ChatGPT sidebar inventory/catalog answers what the remote platform
listed at capture time. It is not reconstruction workflow state and is not
duplicated here.

Discovery state comes from one of two receipts:

1. persisted `memory_v1.observations` and `observation_links`; or
2. a bounded exchange/output pair that passes the unchanged 0.2.0 validator.

Receipt type 2 covers both the original bounded pilot and each processed batch.
Their conversations are marked `pilot_discovery_processed` and
`awaiting_reconciliation` unless persisted observation coverage independently
proves reconciliation as described below. Discovery artifacts alone never certify
reconciliation, approval, or current truth. The artifacts do not contain a
trustworthy processing-completion timestamp, so those timestamps remain `null`.

### Receipt rules

A receipt is a validated artifact pair layered over canonical `memory_v1`
evidence. There is no discovery receipt table and no second queue authority.

- **Membership comes from the validated exchange**, never from a file name, a
  batch number, or a supplied count. `buildDiscoveryReceipt` re-runs the trusted
  0.2.0 validator and derives `source_conversation_ids` from `exchange.selection`.
- **Receipt size is unconstrained and independent of batch size.** A receipt may
  cover five conversations, ten, or a set that spans several batches. Batching is
  a property of the chronological read model; receipt size is a property of the
  exchange that was actually processed.
- **Any number of receipts may be layered.** Each is validated independently.
- **Overlapping claims are refused, never merged.** If two receipts claim the
  same conversation, `buildReconstructionInventory` throws and reconciliation is
  required; nothing is double counted and no receipt silently wins.
- **Supplying the same exchange twice is refused** by the CLI with a distinct
  error, so an operator mistake is not reported as a corpus conflict.

## State semantics

- `unprocessed`: no validated discovery receipt and no persisted observations.
- `pilot_discovery_processed`: included in the validated bounded pilot.
- `discovery_processed`: persisted observations exist for the conversation.
- `not_started`: no discovery output exists to reconcile.
- `awaiting_reconciliation`: discovery output exists but no separate
  reconciliation authority has certified it.
- `reconciled`: at least one persisted observation exists and every persisted
  observation in the conversation has a same-workspace
  `memory_v1.reconciliation_observations` link to an existing immutable
  `memory_v1.reconciliations` record whose `payload.temporal_status` is not
  `rejected`. Rejected outcomes do not count toward coverage. The status filter
  excludes only `rejected`; it does not require `current`. All existing link
  relations (`supports`, `contradicts`, `refines`, `supersedes`, `duplicates`,
  `context`) retain their coverage behavior. Both the observation and
  reconciliation pipeline identities must match. Partial coverage remains
  `awaiting_reconciliation`; adding uncovered observations returns the conversation
  to that state. This derives coverage from trusted reconciliation persistence,
  never from observation existence, lifecycle status, promotion, or approval. It
  represents trusted reconciliation **coverage**, not human acceptance,
  a conversation completion event, or reconciliation of unpersisted artifact
  proposals. Discovery persistence alone does not count. Reconciliation
  remains distinct from promotion and human review.
- `healthy`: verified complete with at least one non-empty canonical text block.
- `evidence_incomplete`: zero blocks, no usable canonical text, or a non-complete
  verification status. Empty representations are counted but do not alone make
  a conversation unhealthy because image/internal blocks may legitimately have
  empty canonical text.

## Ordering and batching

The stable chronology key is:

1. native source conversation creation time, when present;
2. earliest source message time;
3. source observation/capture time;
4. source conversation UUID;
5. source version ID.

Rows are assigned sequentially to fixed ten-conversation batches. Regeneration
derives the same order, batch, evidence state, and inventory SHA-256 from the
same database and receipts. `generated_at` is excluded from the inventory hash.

## CLI

The workspace flag is mandatory; `.env.memory-v1.local` is never allowed to
silently select a different workspace.

Receipts are supplied explicitly as repeatable `--receipt-exchange` /
`--receipt-output` pairs, matched positionally in the order given. No receipt is
assumed: with none supplied the CLI logs `RECONSTRUCTION_RECEIPTS_LOADED=0` and
derives discovery state from persisted observations alone. Each loaded receipt
logs its exchange ID, conversation count, and originating files to stderr, so
identity is always visible as having come from validated content rather than a path.

```bash
npx tsx --env-file=.env.memory-v1.local scripts/reconstruction-inventory.ts report \
  --workspace proof-workspace-5plus2-db \
  --receipt-exchange .runtime/discovery/hermes-pilot-input.json \
  --receipt-output  .runtime/discovery/codex-pilot-output.json \
  --receipt-exchange .runtime/reconstruction/batch-001-input.json \
  --receipt-output  .runtime/reconstruction/batch-001-output.json
```

`--pilot-exchange` / `--pilot-output` remain accepted spellings of the same
inputs so the original bounded-pilot invocation keeps working.

Machine-readable JSON can be printed to stdout or written once to a new runtime
path. `--output` uses exclusive creation and refuses to overwrite history.

```bash
npx tsx --env-file=.env.memory-v1.local scripts/reconstruction-inventory.ts json \
  --workspace proof-workspace-5plus2-db \
  --receipt-exchange .runtime/reconstruction/batch-001-input.json \
  --receipt-output  .runtime/reconstruction/batch-001-output.json \
  --output .runtime/reconstruction/master-conversation-inventory-v1_TIMESTAMP.json
```

Mission Control, Sidekick, Operator, and governed Stephen/Brendon-side workers
should call this shared read model (or a future read-only service around it),
not maintain private queue copies. Reconciliation coverage is read from the
existing immutable reconciliation records and their observation links under the
report-reader workspace scope; this inventory adds no queue, receipt table, or
write authority. Batch completion continues to mean discovery processing, not
reconciliation, promotion, or approval.
