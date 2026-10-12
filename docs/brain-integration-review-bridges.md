# RivRyn trusted integration and dedicated review bridges

These adapters invoke existing reconciliation, promotion, evidence resolution,
review, and approved-query functions. They introduce no queue or knowledge store.
Context Operations and the read-only query service keep their existing credential
boundaries. The first destination is the authenticated user's active Personal brain.

## Trusted integration, loopback 54434

`npm run memory:context:integration:service` loads `.env.context-integration.local`.
Only the existing `MEMORY_INGEST_DATABASE_URL` role is allowed; admin, reader,
reviewer and query/review tokens are rejected. Configuration:

- `MEMORY_CONTEXT_INTEGRATION_TOKENS=hhs-core:<private-token>`
- `MEMORY_CONTEXT_INTEGRATION_GRANTS`: array of explicit grants containing
  `sourceRef`, `sourceWorkspaceId`, `destinationWorkspaceId`, `targetRef`.

Core authenticates via `getUser`, matches the signed-in user and active user-scoped
Personal binding, and resolves its existing historical-source grant. The browser
provides conversation/observation selection and proposed statement/kind/time;
Core supplies both scopes. The bridge independently checks the exact configured
source/destination/user grant before accessing data.

POST `/memory/integration/reconcile` accepts the trusted grant selectors plus
`conversation`, up to eight unique `observationIds`, `statement`, `kind`, and
`temporalStatus`. Attribution is derived from persisted selected observations;
source membership and existing evidence validation precede persistence.
Reconciliation and promotion run atomically in one transaction. Exact requests
have deterministic identities and a transaction lock; retries reuse records.
Changed statements create new proposals. Candidates remain proposed, never approved.

## Dedicated human review, loopback 54435

`npm run memory:context:review:service` loads `.env.context-review.local`.
It permits only existing report/reviewer database credentials, with no ingest,
admin, query or integration credentials. Its separate token/grants use the
`MEMORY_CONTEXT_REVIEW_` prefix and the same explicit grant shape.

POST `/memory/review/inspect` accepts trusted selectors and optional `candidateId`.
It lists the first 50 pending candidates or shows the requested promotion candidate
and revalidates its receipt against the explicitly authorized original source.
Output contains bounded verified excerpts and conversation/message/hash citations;
raw archive paths and internal scopes are excluded. The UI signals evidence truncation.

POST `/memory/review/decide` additionally requires `candidateId`, `decision`
(`approved`/`rejected`) and a nonempty rationale. Reviewer identity comes from the
trusted user grant. The existing append-only review worker records the event and,
on approval, approved knowledge. Exact decision retries are safe; conflicting
decisions return 409. An agent must not record itself as the human reviewer.

Both services deny browser Origin headers and non-loopback callers, require the
trusted Core token and exact Host, reject extra fields, bound bodies/responses,
and return fixed errors without credentials or archive details.

## Core UI and approved Chat

Understanding prepares a proposal; Knowledge's Personal review panel displays its
evidence and mediates the authenticated human decision. These records are not
`knowledge_docs`. Core tokens/URLs stay server-only, distinct for each bridge.

Chat's separate Personal panel resolves the user's Personal binding and calls
the existing approved-only scoped query service. It sanitizes retrieved matches,
preserves authorship/time and source citations, and sends bounded approved context
to the existing configured provider. Full-text question scaffolding may be dropped
for one bounded keyword retry. Empty results are reported honestly; retrieval
failure stops the model. Personal mode has no action tools and rejects unexpected
tool calls. Its exchange stays in the view and is not saved into shared org chats.

The full live operating-loop acceptance requires an actual human approval followed
by an approved-memory Chat answer with citations. Passing adapter tests or creating
a proposal alone does not complete that acceptance. Do not process more history
until the Sidekick specimen completes the loop.
