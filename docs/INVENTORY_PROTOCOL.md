# Inventory Protocol

## Scope

An inventory is a read-only observation of conversation references exposed by an authorized platform interface. It does not capture conversation contents, submit requests, open conversations, prove remote deletion, or authorize deletion of local records.

The contract is platform-neutral. Platform selectors, scrolling behavior, and evidence locators belong in adapters.

## Integrity

Each inventory contains stable opaque platform/account/conversation identities, boundary verification, ordered observations, evidence, warnings, and a deterministic snapshot SHA-256. Every evidence payload has its own SHA-256. A run labeled `complete` is invalid unless both boundaries, scrolling stabilization, and observation-count stabilization are verified and there are no warnings.

## Classification

- `new`: first stable observation.
- `possibly_changed`: visible inventory fingerprint changed, or no verified-complete capture supports an unchanged classification.
- `unchanged`: the stable inventory fingerprint matches and the latest immutable capture is verified complete. This means no visible inventory evidence of change, not proof of server equality.
- `missing`: not observed in a verified-complete inventory for the same platform/account. The catalog record is retained; this never authorizes deletion.
- `needs_review`: incomplete inventory, uncertain identity, evidence warning, or another material ambiguity.

Incomplete inventories cannot create `missing` or `unchanged` conclusions.

## Persistent catalog

The minimal catalog uses an immutable, hash-verified transaction journal plus an atomically replaced snapshot. The journal is written first. Startup replays unapplied transactions, making updates resumable. Reapplying the same inventory snapshot is idempotent. Capture references are immutable: a repeated capture ID must have identical metadata and hashes.

This file-backed implementation is a local foundation and uses no database or external service. A future SQLite storage adapter may replace the snapshot mechanism while preserving these contracts and classification rules.

## Real-inventory gate

No real sidebar inventory is authorized by this implementation. Before the first one, the user must explicitly approve a read-only ChatGPT sidebar inventory for the named opaque account and confirm that the extension may scroll the sidebar, preserve inventory evidence in the approved private archive, and restore the initial sidebar position where possible. The run must not open or capture any conversation.
