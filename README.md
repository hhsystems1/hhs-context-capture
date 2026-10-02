# Helping Hands Systems Universal Context Capture Engine

This local-first project preserves the **exact accessible rendered transcript** and supporting evidence from authorized AI-platform conversations. ChatGPT is the first adapter, not a core architectural dependency.

Phase 1 is a thin vertical slice: capture one open ChatGPT conversation through a Chrome extension, send it to a loopback-only collector, and write a versioned immutable capture beneath the private archive root configured by `HHS_ARCHIVE_ROOT` in an ignored local environment file.

The project does not claim to recover source Markdown that the rendered interface does not expose, hidden reasoning, internal instructions, deleted messages, inaccessible branches, or server-only data.

Contributor starting points:

- [Contributor Guide](docs/CONTRIBUTOR_GUIDE.md)
- [Local Operations Runbook](docs/LOCAL_OPERATIONS_RUNBOOK.md)
- [Mission Control V1](docs/MISSION_CONTROL_V1.md)
- [Capture Operations Logging V1](docs/CAPTURE_OPERATIONS_LOGGING_V1.md)
- [Security and Privacy](docs/SECURITY_AND_PRIVACY.md)
- [Publication Blocker](PUBLICATION_BLOCKED.md)

Start the local operational interface with `npm run hhs:up`, inspect it with
`npm run hhs:status`, and stop it without deleting data with `npm run hhs:down`.
