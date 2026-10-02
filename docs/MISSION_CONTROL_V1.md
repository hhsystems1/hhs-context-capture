# HHS Mission Control V1

Mission Control is a local read-only window into HHS capture and memory operations. It runs only on `127.0.0.1`, connects only to the existing local PostgreSQL report-reader login, and creates no second source of truth.

## The fifth-grade explanation

Imagine HHS is a careful library:

- The **archive** is the locked room holding original books.
- **PostgreSQL/Supabase** is the card catalog that says what exists and where its proof came from.
- **Mission Control** is the librarian's desk. It shows what is working, what arrived, and what needs a person to look at.

The desk cannot rewrite a book, approve an idea, or send anything to the internet. It can only read the catalog. Everything stays on this computer.

## What V1 shows

- **Command Center:** Docker, Supabase, migrations, collector, extension build, Git, publication protection, recent activity, memory counts, and a single Needs You count.
- **Capture Operations:** safe operation references, lifecycle states, event timelines, message/archive/verification state, retries, and pairing-ready classification.
- **Review Inbox:** verification warnings, quarantine, proposed candidates, contradictions, and supersessions. It is read-only.
- **Memory Explorer:** source and lineage counts plus exact-text and structured-filter search. Search text is sent in a local POST body and never appears in the URL or application logs.
- **Archive Inspector:** privacy-sanitized transcript inspection, exact message-range provenance, completeness evidence, and hash status from explicitly approved private derived reports.
- **Sources, Agents, and Destinations:** a status registry only. V1 does not connect external systems.

The UI replaces database identities with short one-way hashed references. Provenance shows exact SHA-256 values without exposing a private filesystem path.

Archive Inspector reports use the separate private contract in
[`ARCHIVE_INSPECTOR_V1.md`](ARCHIVE_INSPECTOR_V1.md). Mission Control verifies
them before serving and does not expose their local directory.

## Setup a family member can follow

1. Open **Docker Desktop**.
2. Wait until Docker says the engine is running.
3. Open PowerShell.
4. Go to the repository folder:

   ```powershell
   cd <repository-root>
   ```

5. Install the exact saved dependencies:

   ```powershell
   npm install
   ```

6. Confirm the private `.env.memory-v1.local` file already exists. Do not open or share it.
7. Start the local system:

   ```powershell
   npm run hhs:up
   ```

8. Open the printed Mission Control address in a browser. The default is `http://127.0.0.1:43118`.
9. Check the system at any time:

   ```powershell
   npm run hhs:status
   npm run hhs:security
   ```

10. Stop safely:

   ```powershell
   npm run hhs:down
   ```

Stopping does not delete the archive or database. `hhs:up` and `hhs:down` are idempotent. Repeating either command is safe.

## Windows loopback security

`hhs:up` does not trust the URLs printed by Supabase. On Windows it:

1. creates or verifies the repository-managed `hhs-memory-loopback-v1` Docker bridge;
2. routes the Supabase CLI through a temporary proxy bound to `127.0.0.1`;
3. rewrites Docker container-create requests so every published port has an explicit `HostIp` of `127.0.0.1`;
4. captures and suppresses the Supabase CLI's raw startup output;
5. inspects Docker port bindings and Windows TCP listeners; and
6. starts the collector and Mission Control only after the database, API/gateway, and Studio pass.

The final gate rejects `0.0.0.0`, an empty Docker host address, `::`, any LAN
address, any missing required port, or a listener that cannot be verified. A
failure immediately stops processes started by the command, stops local
Supabase, removes private runtime state, and prints a fixed safe error.

Inspect the non-secret evidence:

```powershell
npm run hhs:security
```

This reports service names, ports, and bind addresses only. It does not print
database URLs, passwords, API keys, JWT secrets, or pairing codes.

## Terminal management

Use four clearly named PowerShell windows when doing manual work:

### HHS COLLECTOR

For manual pairing and capture work where the one-time pairing code must stay visible only in the private terminal:

```powershell
npm run collector
```

Use `Ctrl+C` to stop it. Do not paste its pairing code or archive path into chat, logs, screenshots, or source files.

### HHS OPS

For Mission Control and status:

```powershell
npm run mission-control
```

Or use the managed commands:

```powershell
npm run hhs:up
npm run hhs:status
npm run hhs:security
npm run hhs:down
```

When `hhs:up` starts the collector in the background, it writes the current pairing code to ignored private runtime storage at `.runtime\collector-pairing-code.private`. Read it only when pairing, then leave it private. `hhs:down` removes it.

### HERMES MAIN

Reserved for normal Hermes orchestration after a later approval. Mission Control V1 does not launch or control Hermes.

### HERMES DEV

Reserved for isolated Hermes development after a later approval. Mission Control V1 does not launch or control it.

## Safety and ownership

| Component | Owns |
|---|---|
| Immutable archive | Original captured evidence |
| PostgreSQL/Supabase | Structured truth, operational state, and provenance |
| Mission Control | Visibility, review, and governance |
| Obsidian | A later approved human-readable projection |
| Hermes | Orchestration |
| Codex | Building, testing, and repair |

Normal UI database work uses `memory_v1_report_login`, begins a `READ ONLY` transaction, and sets the workspace locally inside that transaction. The server refuses non-loopback database URLs. Browser responses disable caching, framing, referrers, and non-local content sources.

## Troubleshooting and recovery

### Mission Control says offline

Run:

```powershell
npm run hhs:status
```

Start Docker Desktop if Docker is offline. Then repeat `npm run hhs:up`.

### Bind addresses are unsafe

If `hhs:up` reports that startup was blocked, leave the stack stopped. Run:

```powershell
npm run hhs:down
```

Do not add a Windows Firewall exception, change Docker Desktop daemon settings,
or bypass the binding probe. Preserve the fixed safe failure message and
escalate. The repository does not make system-wide security changes.

### Migration state is degraded

Inspect without resetting data:

```powershell
.\node_modules\.bin\supabase.cmd migration list --local
```

Do not run `memory:reset`, repair migrations, or delete database files. Preserve the output and escalate.

### Collector is offline

Run `npm run hhs:up`. If doing a manual authorized capture, use the **HHS COLLECTOR** terminal instead so the one-time pairing code stays in that private terminal.

### Extension build is degraded

Run:

```powershell
npm run build:extension
```

Reload the unpacked extension in Chrome. This does not start a capture.

### A pairing operation is prepared

Prepared pairing means pairing succeeded and no capture started. It is not a failed or stuck capture. Start a capture only after explicit authorization for the exact open conversation.

### A capture appears stuck

Inspect `npm run operations:report`, confirm the component is no longer working, wait for the configured timeout, and use the existing explicit reconciliation procedure. Mission Control does not reconcile or retry.

### Search returns nothing

Choose fewer filters or use exact visible words from the approved local capture. Search is limited to preserved message and content-block representations in the current workspace.

### Safe shutdown

```powershell
npm run hhs:down
```

This stops only processes recorded as managed by `hhs:up` plus local Supabase. It does not touch Hermes, browsers, the immutable archive, or database files.

## V1 limitations

- No approval, rejection, release, reconciliation, retry, or other mutation controls.
- Archive Inspector does not create proposed or approved knowledge and does not serve unsanitized transcript bytes.
- No external systems, hosted Supabase, embeddings, model APIs, automation, scheduling, deployment, or publication.
- The source registry is declarative; only existing local capabilities report as ready or connected.
- Real-time updates use a five-second local Server-Sent Events refresh, not database replication.
- Exact-text search is intentionally capped at 100 results and 200 input characters.
- Mission Control does not display private filesystem paths or raw database identifiers.
