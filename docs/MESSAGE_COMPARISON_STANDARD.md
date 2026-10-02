# Message-Level Version Comparison Standard

Comparisons are operational preservation metadata, not derived knowledge. They compare two immutable versions of the same platform, opaque account, and conversation and cite exact hashes.

Ruleset 0.2 separates textual edits from rendered-structure drift and from content-block, attachment, citation, artifact, tool-event, metadata, and branch changes. A record has one conservative primary classification plus explicit change dimensions. A change to sanitized HTML alone is never called a textual edit; canonical, inner-text, or text-content evidence must differ.

Matching priority is unique platform message ID, unique canonical message ID, then a unique exact role/parent/branch/representation/block-hash context. Ambiguous fallback candidates are never selected silently.

Classifications are:

- `unchanged`: all preserved hashes and relationships match.
- `appended`: unambiguous new content follows the prior verified active-path tail.
- `edited`: a stable identity has changed representations, structure, metadata, attachments, citations, artifacts, or tool events.
- `regenerated`: an assistant alternative has the same parent and explicit branch evidence.
- `branched`: captured parent, branch, alternative, or active-path relationships changed.
- `removed_from_active_path`: prior content is absent from a new verified-complete active path; this never means deleted and never removes history.
- `uncertain`: matching, boundaries, branches, hashes, roles, or evidence do not support a stronger conclusion.

Any `uncertain` record makes the entire comparison `needs_review` and creates a private review-queue item. Partial or needs-review source captures cannot confirm removal.
