# HHS Context Engine

The **HHS Context Engine** is the memory, evidence, provenance, and knowledge backbone for Helping Hands Systems.

It began as a local-first conversation capture system, but the repository now contains a broader platform-neutral memory foundation: authorized capture, immutable evidence, normalized source records, provenance-preserving knowledge, human review, workspace isolation, approved-knowledge query services, and deterministic workspace provisioning for HHS Core.

ChatGPT is the first browser adapter. It is not a core architectural dependency.

## What this system owns

The Context Engine owns the durable context layer beneath HHS applications and agents:

```text
Authorized sources
      |
      v
Capture / ingestion
      |
      v
Immutable evidence
      |
      v
Normalized source records
      |
      v
Proposed knowledge
      |
      v
Human-reviewed approved knowledge
      |
      v
Permissioned query / agent context
```

The system preserves the distinction between **what a source actually contained** and **what HHS later inferred or approved from it**.

## Core capabilities

- **Authorized capture** of accessible rendered AI-platform conversations through platform adapters.
- **Immutable versioned evidence** with manifests, hashes, verification, and no silent overwrite of prior capture versions.
- **Inventory and change detection** for identifying new, possibly changed, unchanged, missing, and needs-review conversations.
- **Normalized memory contracts** for conversations, messages, content blocks, entities, relationships, decisions, tasks, SOPs, and other structured knowledge.
- **Exact provenance** from derived knowledge back to source record, capture version, conversation, message, content block, representation kind, and SHA-256.
- **Human governance** that keeps proposed knowledge separate from approved knowledge.
- **Workspace isolation** so personal, organization, project, and other context boundaries do not collapse into one global memory pool.
- **Approved-knowledge querying** through a least-privilege, loopback-only report-reader service.
- **Workspace provisioning** through a dedicated least-privilege service used by HHS Core.
- **Local operational visibility** through the Context Console, historically named Mission Control V1.

## Relationship to HHS Core 2

HHS Core 2 and the Context Engine have different responsibilities.

| System | Responsibility |
|---|---|
| **HHS Core 2** | Operate the business: users, organizations, projects, CRM, tasks, agents, workflows, dashboards, Mission Map / Mission Studio. |
| **HHS Context Engine** | Remember and explain the business: evidence, history, provenance, approved knowledge, brain workspaces, retrieval. |
| **Core Mission Control** | Human-facing operating dashboard for the company. |
| **Context Console** | Local inspection and governance interface for capture and memory operations. |

Core does not become the memory database. It stores a binding from a Core identity to the authoritative Context Engine workspace.

Current Core identity forms are:

```text
hhs-core:user:<uuid>
hhs-core:org:<uuid>
hhs-core:project:<uuid>
```

The Context Engine provisioning service exposes:

```text
POST /memory/workspaces/ensure
```

and deterministically returns the corresponding Context Engine workspace.

See [HHS Context Engine Architecture](docs/HHS_CONTEXT_ENGINE_ARCHITECTURE.md) for the full integration model.

## Brain model

The intended operating model is shared, scoped memory rather than one disconnected memory store per agent:

```text
                   HHS Context Engine
                         |
          +--------------+--------------+
          |              |              |
     Personal brain  Org brain      Project brain
          |              |              |
          +------- permissioned --------+
                         |
              +----------+----------+
              |          |          |
           Sidekick   Agents    Workflows
```

Agents can change. Models can change. The durable organization/project memory remains anchored in the Context Engine.

## Evidence and trust model

The memory foundation separates four layers:

1. **Immutable source evidence** — what was captured.
2. **Normalized source records** — platform-neutral records preserving identity, order, representations, locators, and hashes.
3. **Proposed knowledge** — machine- or human-proposed interpretation that is not yet trusted truth.
4. **Approved structured knowledge** — human-reviewed knowledge with exact provenance.

Corrections add review events, relationships, or superseding records. They do not rewrite source evidence.

See [Memory Foundation M1 Architecture](docs/MEMORY_FOUNDATION_ARCHITECTURE.md).

## Local services

The current runtime is intentionally local-first and least-privilege.

- **Collector** — receives authorized capture payloads on loopback.
- **PostgreSQL/Supabase** — stores memory lineage, operational state, provenance, review state, and workspace-isolated records.
- **Memory Query Service** — read-only approved-knowledge retrieval using the report-reader role.
- **Memory Provisioning Service** — creates/ensures deterministic HHS Core workspaces using the ingest role and dedicated service tokens.
- **Context Console** — read-only operational UI for health, capture operations, review queues, memory exploration, and archive inspection.

The provisioning service defaults to `127.0.0.1:54432`. The query service defaults to `127.0.0.1:54431`.

## Current limitations

- The query service is currently configured for **one workspace per process** through `MEMORY_WORKSPACE_ID`. A trusted multi-workspace query gateway for general Core agent execution is still an integration step.
- Capture does not recover hidden reasoning, internal instructions, deleted messages, inaccessible branches, server-only data, or source Markdown that the rendered interface does not expose.
- External-source adapters beyond the implemented repository capabilities should not be assumed merely because the architecture is platform-neutral.
- The system remains local-first; cloud deployment and broad remote exposure are not part of the current security model.
- Approved knowledge is not created implicitly from capture. Human review remains a distinct trust boundary.

## Contributor starting points

- [HHS Context Engine Architecture](docs/HHS_CONTEXT_ENGINE_ARCHITECTURE.md)
- [Contributor Guide](docs/CONTRIBUTOR_GUIDE.md)
- [Local Operations Runbook](docs/LOCAL_OPERATIONS_RUNBOOK.md)
- [Context Console / Mission Control V1](docs/MISSION_CONTROL_V1.md)
- [Memory Foundation M1 Architecture](docs/MEMORY_FOUNDATION_ARCHITECTURE.md)
- [Capture Operations Logging V1](docs/CAPTURE_OPERATIONS_LOGGING_V1.md)
- [Security and Privacy](docs/SECURITY_AND_PRIVACY.md)
- [Publication Status](PUBLICATION_BLOCKED.md)

## Local operations

Start the local operational stack:

```bash
npm run hhs:up
```

Inspect it:

```bash
npm run hhs:status
npm run hhs:security
```

Stop it without deleting archive or database data:

```bash
npm run hhs:down
```

Private captures, credentials, runtime databases, and local archive data are separate from this sanitized public code repository and must never be committed.
