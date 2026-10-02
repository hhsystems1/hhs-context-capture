# Security and Privacy Boundaries

- Capture begins only after an explicit user action on a supported conversation page.
- The extension must not collect passwords, cookies, session tokens, authorization headers, visible account names/emails, or unrelated history.
- The collector listens only on loopback and writes only beneath the private archive root supplied through ignored local configuration as `HHS_ARCHIVE_ROOT`.
- Captures are never written beneath the code repository.
- No remote telemetry, cloud synchronization, network interception, deployment, or publication is used.
- Sanitized DOM evidence removes executable elements, inline event handlers, form values, and other active content.
- Existing branch navigation may be used; prompt editing, regeneration, and submission are forbidden.
- Archive directories are immutable capture versions. Existing capture files are never overwritten.
- Capture operation events use an allowlisted scalar metadata schema. Arbitrary exceptions and source payloads are rejected.
- PostgreSQL is authoritative for operation status; extension storage is a limited recent-status cache only.
- Operational event receipts are stored beneath the separate private operations boundary and never inside source-capture payloads.
