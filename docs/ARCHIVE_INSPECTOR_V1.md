# Mission Control Archive Inspector V1

Archive Inspector V1 is a local, read-only view of explicitly approved derived inspection reports. It does not ingest a capture, write to PostgreSQL, approve knowledge, or modify immutable source archives.

## Storage boundary

Private derived reports live beneath:

```text
HHS_ARCHIVE_ROOT/
  derived-reports/
    mission-control/
      archive-inspector-v1/
        capture-<safe-reference>/
```

This boundary is outside Git and is a sibling of—not a child of—`captures`. A report directory contains:

- `inspection-report.md`
- `message-index.json`
- `topic-outline.json`
- `uncertain-regions.json`
- `derived-report-manifest.json`
- `hashes.sha256`

Writes use a private staging directory, exclusive file creation, complete hash verification, and atomic rename. An existing report is never overwritten. Generation hashes the entire source-capture tree before and after the derived write and fails if the immutable source changes.

## Authority and identity

The generator accepts only a safe capture reference. The existing PostgreSQL report-reader role resolves that reference to an operation status, message count, and archive-manifest hash in a `READ ONLY` transaction. The manifest hash must resolve to exactly one finalized capture in the append-only capture ledger.

The derived manifest stores:

- safe capture reference;
- `usable_with_review`;
- `active_path_complete=true`;
- `branches_complete=false`;
- source manifest and source hash-index SHA-256 values;
- exact message count and sequence boundary;
- a safe operation reference; and
- hashes for all derived artifacts.

It does not store or serve an absolute source path, account identifier, conversation identifier, source URL, pairing code, credential, or database locator.

## Evidence and knowledge layers

Archive Inspector keeps four explicit layers:

1. **Raw Evidence** — the immutable source archive. The UI serves only a privacy-sanitized projection linked to the raw representation hash.
2. **Derived Summary** — local topics, summaries, and uncertainty notes with exact message ranges and ordered source hashes.
3. **Proposed Knowledge** — empty in V1.
4. **Approved Knowledge** — empty in V1.

User role is not treated as proof of approval. Messages and topic statements distinguish user statements, assistant suggestions, pasted external material, decisions, corrections, requirements, and unresolved questions. Pasted material remains uncertain unless a human separately establishes authorship and approval.

## Read-only serving

Mission Control:

- uses only `memory_v1_report_login`;
- begins every database transaction with `BEGIN READ ONLY`;
- verifies the operation-to-manifest linkage before returning an inspection;
- recomputes every derived artifact hash before serving it;
- accepts transcript search and filters only in a local POST body;
- limits transcript pages to 100 messages; and
- never serves private archive directories as static files.

If any identity, sequence, provenance, or hash check fails, the inspection fails closed.

## Private generation

Provide a private topic plan through ignored local input or the process environment, then run:

```powershell
npm run inspection:generate -- capture-<safe-reference>
npm run inspection:verify -- capture-<safe-reference>
```

The topic plan must cover every active-path message. Every topic and statement must specify an exact inclusive range. The generator adds each message’s canonical source hash and computes an ordered range hash.

Do not commit the topic plan or derived artifacts.
