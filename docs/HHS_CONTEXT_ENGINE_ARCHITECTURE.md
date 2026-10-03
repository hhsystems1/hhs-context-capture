# HHS Context Engine Architecture

## Purpose

The HHS Context Engine is the durable memory, evidence, provenance, and knowledge layer for Helping Hands Systems.

It exists so HHS applications and agents can operate from shared, scoped context without making every model, agent, or UI its own source of truth.

The core design principle is:

> **HHS Core operates the business. The Context Engine remembers and explains the business.**

## System boundary

```text
                    HHS CORE 2
     users / orgs / projects / CRM / tasks / agents
           Mission Control / Mission Map / Studio
                          |
                     brain binding
                          |
                          v
                 HHS CONTEXT ENGINE
     evidence / history / provenance / knowledge / retrieval
                          |
                   scoped brain access
                          |
              +-----------+-----------+
              |           |           |
           Sidekick     Agents     Workflows
```

HHS Core stores business entities and the mapping between those entities and Context Engine workspaces.

The Context Engine remains authoritative for memory content, provenance, evidence lineage, knowledge review state, and workspace isolation.

## Why the systems are separate

Combining operational data and memory into one undifferentiated database creates several problems:

- agents become coupled to one application;
- provenance gets lost when notes are rewritten;
- project context can leak across boundaries;
- changing models can imply changing memory;
- derived summaries can accidentally replace source evidence;
- business UI concerns can distort evidence and governance rules.

The split keeps each system focused.

### HHS Core owns

- authenticated users;
- organizations/workspaces;
- projects;
- CRM contacts and pipeline data;
- tasks and calendar-facing operations;
- social operations;
- agent/provider configuration;
- Mission Map / workflow definitions and run state;
- dashboards and human-facing business operations;
- `brain_bindings` that point Core identities at Context Engine workspaces.

### Context Engine owns

- authorized capture and ingestion;
- immutable source evidence and capture versions;
- normalized source records;
- exact provenance;
- proposed knowledge;
- human review events;
- approved structured knowledge;
- workspace-isolated memory;
- read-only approved-knowledge retrieval;
- deterministic memory-workspace provisioning.

## Brain scopes

The integration currently models three Core brain types:

```text
personal      -> hhs-core:user:<uuid>
organization  -> hhs-core:org:<uuid>
project       -> hhs-core:project:<uuid>
```

These external keys are stable identity inputs. The Context Engine deterministically derives the authoritative memory workspace ID.

A display name is metadata, not identity. Renaming a project or organization must not silently create a new brain.

## Provisioning flow

Current HHS Core provisioning flow:

```text
Authenticated Core user
        |
        v
POST /api/brain/provision
        |
        +-- validate personal/org/project authorization
        |
        +-- look for existing brain_bindings row
        |
        v
ensureMemoryWorkspace(...)
        |
        v
POST 127.0.0.1:54432/memory/workspaces/ensure
        |
        +-- authenticate dedicated bearer token
        +-- validate exact HHS external key
        +-- run with memory_v1_ingest_login only
        +-- enforce loopback-only access
        +-- ensure deterministic workspace
        |
        v
Context workspace ID
        |
        v
Core brain_bindings
```

The provisioning service is intentionally narrow. It does not expose admin, reviewer, or query credentials and refuses to start if forbidden credentials are present in its process environment.

## Query flow

The current Memory Query Service is read-only and returns approved knowledge only.

```text
Agent / trusted local client
        |
        v
POST /memory/query
        |
        v
memory-query-service
        |
        +-- loopback-only
        +-- bearer-token authenticated
        +-- report-reader database role
        +-- approved knowledge only
        |
        v
Matches with provenance
```

Current limitation: the query service receives one `MEMORY_WORKSPACE_ID` at process startup. General HHS Core agent execution therefore still needs a trusted workspace-aware query layer or another safe routing mechanism before arbitrary Core project/org brains can be queried by one long-running agent runtime.

That limitation should be solved without weakening workspace isolation.

## Evidence and knowledge lifecycle

The trust model is layered:

```text
Immutable source evidence
        |
        v
Normalized source records
        |
        v
Proposed knowledge
        |
     human review
        |
        v
Approved structured knowledge
```

### Immutable source evidence

Preserved source material is never rewritten by later interpretation.

### Normalized source records

Platform-specific captures become common records for conversations, messages, content blocks, identities, order, locators, and hashes.

Normalization does not assert that source content is factually true.

### Proposed knowledge

A model or person may propose structured knowledge such as:

- entities;
- relationships;
- decisions;
- tasks;
- SOPs;
- use cases;
- client/project facts.

A proposal is not approved truth.

### Approved knowledge

Approved knowledge requires an explicit human review event and exact provenance.

Corrections do not erase history. Contradictions, refinements, and supersessions are represented explicitly.

## Provenance

Every trusted derived record is designed to resolve through a chain that includes:

- workspace;
- source record;
- immutable capture version;
- conversation;
- message;
- content block;
- representation kind;
- representation SHA-256.

This lets HHS answer both:

> What do we currently believe?

and:

> Why do we believe it, and what exact source supports it?

## Context Console versus Core Mission Control

Historically, this repository called its local memory-operations UI **Mission Control V1**.

To avoid confusion with the HHS Core company dashboard, use the following terminology in architecture discussions:

- **Core Mission Control** — the HHS Core business operating dashboard.
- **Context Console** — the local read-only inspection and governance UI in this repository.

The existing file and commands retain the historical Mission Control name for compatibility.

### Context Console responsibilities

The Context Console shows:

- local system health;
- capture operations;
- review queues;
- memory counts;
- exact-text and structured search;
- archive/provenance inspection;
- source/agent/destination status.

It does not become a second source of truth.

### Core Mission Control responsibilities

Core Mission Control should surface business-facing context health rather than raw memory internals, for example:

```text
Database              Online
Context Engine         Online
Company Brain          Active
Project Brain          Active
Needs Review           3
Last Context Sync      ...
Agent Runtime          ...
```

The business operator should not need to understand capture IDs, database roles, or private archive paths to know whether HHS memory is healthy.

## Mission Map / Mission Studio integration

HHS Core already models Mission Map nodes for:

- company;
- contact;
- lead;
- project;
- task;
- agent;
- campaign;
- automation;
- knowledge;
- system.

The next important integration is to resolve a run's brain scope before executing an agent node.

Target flow:

```text
Project / org node
       |
       v
Resolve brain_binding
       |
       v
Query approved project/org context
       |
       v
Build agent context package
       |
       v
Execute agent node
       |
       v
Record workflow output
```

For example:

```text
Tech4Health project
       |
       +--> Tech4Health project brain
       |
       v
Content agent
       |
       +--> approved messaging
       +--> prior decisions
       +--> relevant SOPs
       +--> source-backed project facts
       |
       v
Draft content
       |
       v
Approval / publishing workflow
```

This is the path from a visual workflow editor to a context-aware operating system.

## Agent memory model

Do not create one unrelated durable truth store per agent.

Preferred model:

```text
                    Context Engine
                         |
             permissioned brain scope
                         |
          +--------------+--------------+
          |              |              |
      Coding agent   Social agent   Voice agent
          |              |              |
      Mission agent   Sales agent     Sidekick
```

Agents are workers. Brains are durable context boundaries.

An agent may receive one or more permitted scopes for a task, such as:

```text
personal brain
+ organization brain
+ active project brain
```

The exact composition must remain permission-aware.

## Security model

The current design intentionally prefers local-first, least-privilege boundaries.

Important properties include:

- loopback-only services;
- dedicated bearer tokens;
- dedicated database roles;
- no admin fallback in provisioning;
- query service refuses write-capable credentials;
- provisioning service refuses admin/reviewer/query credentials;
- immutable evidence;
- workspace-aware database controls;
- no private archive material in the public code repository;
- no assumption that publication of code implies publication of data.

## Current implementation status

Implemented in this repository:

- immutable capture/archive foundations;
- normalized memory contracts;
- provenance and review model;
- local PostgreSQL/Supabase memory foundation;
- read-only Context Console;
- approved-knowledge query service;
- deterministic HHS Core workspace provisioning service;
- exact HHS Core external-key validation;
- local-only service boundaries and least-privilege credentials.

Implemented in HHS Core 2:

- personal/organization/project brain types;
- `brain_bindings` schema;
- authenticated `POST /api/brain/provision`;
- authorization checks for personal, organization, and project provisioning;
- local provisioning bridge to the Context Engine.

Still to integrate:

- a safe workspace-aware query path for general Core agent execution;
- Mission Runner context injection;
- business-facing Context Engine health on the Core dashboard;
- approved Context Engine knowledge surfaced through Core's Knowledge UI;
- explicit project/org brain controls in the Core UI;
- broader source adapters and ingestion paths as they are actually implemented.

## Related documents

- [README](../README.md)
- [Memory Foundation M1 Architecture](MEMORY_FOUNDATION_ARCHITECTURE.md)
- [Context Console / Mission Control V1](MISSION_CONTROL_V1.md)
- [Contributor Guide](CONTRIBUTOR_GUIDE.md)
- [Security and Privacy](SECURITY_AND_PRIVACY.md)
