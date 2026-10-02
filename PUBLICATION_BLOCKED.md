# PUBLICATION BLOCKED

This repository must not be pushed, published, mirrored, deployed, or attached to a public or private remote yet.

Earlier local Git commits contained real private archive identifiers in documentation and production source. Memory V1.1 removes those identifiers from the current tracked tree, but normal later commits do not remove the older values from Git history.

Before any push is allowed, all of the following require explicit user approval and independent verification:

1. Create a recoverable local backup of the repository metadata.
2. Rewrite local Git history to remove private account, conversation, capture, inventory, archive-path, pairing, evidence, and catalog identifiers.
3. Scan every reachable commit, tree, blob, tag, reflog intended for retention, and generated patch/bundle.
4. Independently scan the complete rewritten history with a separate method or tool.
5. Confirm runtime logs, archives, catalogs, captures, evidence, secrets, and extension storage are absent.
6. Review the exact remote, branch, and objects that would be transferred.
7. Obtain a new explicit approval to remove the local pre-push blocker and publish.

The committed `.githooks/pre-push` hook blocks pushes by default. Local Git is configured to use `.githooks` as its hooks path. Do not bypass or remove it as part of ordinary development.
