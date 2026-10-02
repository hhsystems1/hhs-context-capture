# Phase 1 Operating Runbook

## Build and start

1. Run `npm run check` in the code workspace.
2. Set `HHS_ARCHIVE_ROOT` from ignored local configuration, run `npm run collector`, and retain the one-time pairing code printed locally.
3. In Chrome, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
4. Select `<repository-root>\\apps\\browser-extension\\dist`.
5. Open the selected ChatGPT conversation and keep that tab active throughout capture.
6. Open the extension, enter the collector pairing code, and choose **Pair**.
7. Choose **Capture Current Conversation**. Do not edit, regenerate, submit, close, or switch away from the conversation while it runs.

## First real acceptance conversation

Prefer a conversation containing multiple turns, headings, lists, code, links/citations, an image or attachment reference, and enough content to require scrolling. Existing alternatives may be navigated read-only and the adapter will attempt to restore the initial alternative.

## Manual comparison checklist

- Record archive path and final status.
- Compare the number and order of visible user/assistant turns.
- Compare the exact first and last captured messages.
- Spot-check exact punctuation, Unicode, line breaks, and repeated content.
- Compare headings and list nesting.
- Compare code indentation and line breaks.
- Compare links and citations.
- Compare every visible attachment/image/generated-file reference and availability state.
- Review branch navigation/restoration logs.
- Review initial, earliest-boundary, latest-boundary, and warning screenshots.
- Review verification failures and warnings.
- Run hash verification against `hashes.sha256`.
- Record known losses or uncertainties before broadening Phase 1.

The result is an **exact accessible rendered transcript**. It is not a claim that original source Markdown or inaccessible platform data was recovered.

## Audit a stored sidebar inventory

Run the read-only verifier with an immutable inventory directory and its corresponding private catalog directory:

```powershell
npm run audit:inventory -- "<inventory-archive-path>" "<catalog-path>"
```

The verifier checks inventory, evidence, archive-file, and catalog-transaction hashes; unique conversation identities and sidebar positions; classification counts; boundaries; and restoration evidence. It does not write to the archive or catalog. Exit code `0` means all material integrity checks passed; exit code `1` means the JSON report contains at least one failure.
