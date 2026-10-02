# Local Contributor Operations Runbook

All commands run from `<repository-root>` in PowerShell unless stated otherwise. Never paste populated environment values into a terminal transcript intended for sharing.

## Install and start Docker Desktop

1. Confirm Windows meets the current Docker Desktop requirements.
2. Follow Docker’s official [Windows installation guide](https://docs.docker.com/desktop/setup/install/windows-install/).
3. Start Docker Desktop from the Start menu.
4. Wait until Docker Desktop reports that the engine is running.
5. Check:

```powershell
docker version
docker info
```

If either command cannot contact the engine, do not start Supabase yet. Open Docker Desktop and resolve its WSL, virtualization, update, or permission message first.

## Install dependencies

```powershell
npm install
```

Use the repository lockfile. Do not use `--force` to bypass dependency conflicts.

## Local configuration

`.env.example` is redacted. The populated `.env.memory-v1.local` file is ignored and must contain the required local database URLs, workspace, approved archive/capture values, pipeline version, and proof root.

Check that it is ignored:

```powershell
git check-ignore -v .env.memory-v1.local
```

Never print its contents during a shared support session.

## Start, inspect, and stop local Supabase

The project uses the local Supabase CLI described in the official [local-development guide](https://supabase.com/docs/guides/local-development/cli/getting-started).

```powershell
npm run memory:start
```

Inspect local service health and migration state:

```powershell
.\node_modules\.bin\supabase.cmd status
.\node_modules\.bin\supabase.cmd migration list --local
.\node_modules\.bin\supabase.cmd db lint --local --level warning
```

Stop local services without deleting database state:

```powershell
npm run memory:stop
```

Do not run `memory:reset`, seed, or migration repair against accepted data without separate approval and a verified backup.

## Start Mission Control

The managed local-only workflow starts Supabase when needed, prevents duplicate
collector and Mission Control listeners, and does not launch Hermes or browser
automation:

```powershell
npm run hhs:up
npm run hhs:status
npm run hhs:security
```

Open the loopback address printed by `hhs:up`. Stop the managed services safely:

```powershell
npm run hhs:down
```

See [MISSION_CONTROL_V1.md](MISSION_CONTROL_V1.md) for the beginner setup,
four-terminal guide, ownership map, and V1 limitations.

On Windows, `hhs:up` captures all raw Supabase startup output and requires both
Docker port mappings and Windows TCP listeners to be explicitly loopback-only.
It fails closed and rolls startup back before accepting wildcard, IPv6 wildcard,
LAN, missing, or unverifiable bindings. Never replace this with a Firewall or
Docker Desktop system-wide change without separate approval.

## Start and stop the collector

Start:

```powershell
npm run collector
```

The collector prints a one-time pairing code in that private terminal. Do not record or share it.

Stop it with `Ctrl+C`. Stopping the collector does not erase PostgreSQL operation events or private receipts. A partially active operation may later be explicitly reconciled to `interrupted`.

## Build and load the extension

Build:

```powershell
npm run build:extension
```

Load or reload:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `<repository-root>\apps\browser-extension\dist`.
5. After rebuilding, select **Reload** on the extension card.
6. Refresh the supported conversation tab if Chrome still has an older content script.

Do not add browser automation. Capture remains manual.

## Pairing

1. Start the collector.
2. Open the extension popup.
3. Enter the current one-time code.
4. Select **Pair**.
5. The collector records safe pairing lifecycle events but never stores the pairing code or session token.

The token is local and temporary. A collector restart creates a new token; pair again, then the popup reconciles its recent cache with PostgreSQL.

## Perform one authorized capture

1. Obtain explicit approval for the exact open conversation.
2. Verify no unrelated account or conversation is active.
3. Keep the exact tab active.
4. Open the extension and select **Capture Current Conversation**.
5. Do not edit, regenerate, submit, switch conversations, or close the tab.
6. Wait for `completed`, `needs_review`, `failed`, `interrupted`, or `canceled`.
7. Run:

```powershell
npm run operations:report
```

The report uses safe references and summaries. It does not print transcript content or full archive paths.

## Explicit stale-operation reconciliation

First inspect the report. Reconciliation never completes or retries an operation.

```powershell
npm run operations:reconcile -- <operation-id> 900
```

This is allowed only after the operation has had no valid progress for at least the timeout. It appends `capture_interrupted`, preserves the last successful stage, and marks retry as safe. A retry must be manually started with a new operation ID and parent lineage.

## Read-only Memory report

```powershell
npm run memory:report
```

This uses the report-reader role and trusted provenance views.

## Validation commands

```powershell
npm run typecheck
npm test
npm run lint
npm run build
npm audit
npm audit --omit=dev
.\node_modules\.bin\supabase.cmd migration list --local
.\node_modules\.bin\supabase.cmd db lint --local --level warning
npm run operations:report
git diff --check
git status --short
git remote -v
git config --get core.hooksPath
```

Privacy scans must include the current tracked tree and staged tree. Search for private username/path fragments, known real IDs, populated connection strings, private-key headers, authorization values, transcript fragments, and archive payload filenames. Report counts, not secret values.

Test the publication blocker:

```powershell
sh .githooks/pre-push
```

Success means the hook exits nonzero and prints the publication-blocked message.

## Safe recovery

### Popup closed

Reopen it. The popup reads its limited cache and asks the collector for the authoritative latest report.

### Extension worker restarted

Reopen the popup. PostgreSQL and event receipts remain intact. Do not invent missing events; reconcile only after the timeout.

### Collector restarted

Pair with the new one-time code. Inspect the report. If an operation is stale, explicitly reconcile it.

### Browser or computer restarted

Start Docker Desktop, local Supabase, and the collector. Rebuild/reload only if source changed. Pair again and inspect the report. Durable database and archive files survive restart.

### Delivery failed

Do not assume an archive exists. Check `collector_delivery_succeeded`, `archive_started`, and `archive_created` in the report.

### Archive failure

Do not edit or delete staging or capture directories casually. Inspect the safe operation report and collector terminal. Escalate before destructive cleanup.

### Needs review

The archive exists, but verification or comparison needs human attention. Do not treat it as failure and do not automatically ingest or approve knowledge.

### Operation appears stuck

Confirm the relevant component is no longer working, wait for the configured timeout, then use explicit reconciliation. Never mark it complete manually.

### Migration failure

Stop. Preserve output, verify the pre-migration backup, and inspect migration state. Do not reset the database.

## Troubleshooting checklist

- [ ] Is Docker Desktop running?
- [ ] Is local Supabase healthy?
- [ ] Is the migration list synchronized?
- [ ] Is `.env.memory-v1.local` present and ignored?
- [ ] Is the collector listening only on loopback?
- [ ] Was the extension rebuilt and reloaded?
- [ ] Was the conversation tab refreshed?
- [ ] Was the current collector pairing code used?
- [ ] Does `operations:report` show capture start?
- [ ] Does it show successful delivery?
- [ ] Did archiving begin and complete?
- [ ] Did verification finish?
- [ ] Is the operation terminal?
- [ ] Is a retry linked to its parent?
- [ ] Are receipt hashes valid?
- [ ] Is the archive hash unchanged when no real capture was authorized?
- [ ] Are Git remotes absent and the publication blocker active?

Never solve a troubleshooting problem by deleting accepted data, resetting PostgreSQL, weakening guards, exposing credentials, or capturing a different conversation.
