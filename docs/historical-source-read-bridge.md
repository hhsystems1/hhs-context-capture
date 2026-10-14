# Historical source read bridge — integration seam 1

This is a bounded read interface over the existing conversations, observations,
reconciliation input reader and exact provenance. It extends the existing query
service with report-reader access. Context Operations still owns its bounded
reconstruction status/Start/Resume interface; approval remains a separate review
boundary. Existing approved query routes keep their approved-only trust contract.

## Source and destination authorization

Core first authenticates the user and resolves their own active Personal
`brain_binding` using the user-scoped client. Operator-configured
`MEMORY_HISTORICAL_SOURCE_GRANTS` maps that resolved Personal memory workspace to
one source reference. A request cannot supply a raw source workspace or another
user's target ID. Missing configuration, suspended bindings and access errors
fail without fetching source evidence.

The read-only query service independently maps the source reference to the
historical workspace through optional `MEMORY_QUERY_SOURCE_COLLECTIONS`:

```json
[{"sourceRef":"stephen-history","workspaceId":"proof-workspace-5plus2-db","label":"Historical ChatGPT collection"}]
```

The new route accepts only the trusted `hhs-core` token and rejects browser Origin
headers. An absent source registry exposes no historical sources. Fixed-workspace
operator query behavior and scoped `workspace_<32 hex>` approved-query behavior
remain compatible. Legacy source IDs are handled only by the explicit source
registry; the brain workspace schema is unchanged.

## Read contract

`GET /memory/sources/:sourceRef/history`

- No selection: list already-analyzed conversations with their existing observation counts.
- `conversation=<source conversation ID>`: list existing observations, attribution,
  record hashes, pipeline identities and source-derived evidence roles.
- `conversation=...&observation=...`: resolve that observation's exact source
  provenance. Observation membership in the requested conversation is checked first.
- `cursor=...`: retrieve the next page in stable ID order. Each page contains at
  most 50 entries, with `next_cursor` when another page exists.

Unknown/duplicate parameters, unsupported methods and non-allowlisted sources
are rejected. Reads execute in explicit workspace-scoped read-only transactions
with bounded query/lock timeouts. Observation inspection reuses
`prepareReconciliationInputFromClient`; it does not approve or persist anything.

Every successful response is labelled `trust_scope: unapproved_source_evidence`.
Evidence excerpts are capped at 2,400 characters and explicitly indicate truncation
and full representation length. The full representation is hash-checked before
excerpting and requires complete source verification. Citation identity includes
source conversation, message, source/capture version, provenance edge and the
original representation SHA-256. An excerpt's text is not asserted to hash to the
full representation hash. Absolute archive locators, credentials and internal
workspace IDs are not response fields. Responses are limited to 1 MiB.

## RivRyn surface

Core exposes `GET /api/brain/context/history?targetId=<authenticated user UUID>`
with the same optional selections. The server resolves authorization and strips
internal identity from the source contract. The Context page's **Understanding**
section asks the user to choose Personal scope, lists analyzed conversations,
shows their findings, and opens source evidence. Scope changes discard the
previous component; aborted or stale requests cannot repopulate another view.

This slice does not start discovery, write observations, reconcile, promote,
approve knowledge or inject Chat context. Those remaining integration seams are
recorded in the canonical HHS ledger, not redefined here.

## Local runtime

Run the integrated query-service entrypoint in a dedicated environment containing
the report-reader URL, existing client tokens, fixed query workspace/port and
the optional source collection registry. Keep admin/ingest/reviewer credentials
out of that process. Use the same existing Core query-service token/URL for
historical reads. Private environment files remain Git-ignored.

For Stephen's first acceptance, the explicit Personal grant references
`workspace_86fcd85825ce72853f01d87bff5556b1` and `stephen-history`.
The historical collection remains in `proof-workspace-5plus2-db`; no evidence
rows or Personal binding are reassigned.
