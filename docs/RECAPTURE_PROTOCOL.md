# Controlled Immutable Recapture Protocol

## Authorization sequence

1. The user manually opens a cataloged conversation; software never navigates to it.
2. **Prepare Current Conversation for Recapture** creates a short-lived durable intent only if platform, opaque account, and conversation identity match the local catalog.
3. No capture occurs during preparation.
4. **Confirm One Immutable Recapture** presents a second explicit confirmation for exactly one attempt.
5. Identity is verified again immediately before capture. Any mismatch or expired intent stops the operation.
6. The existing capture engine writes a complete new immutable archive version. Prior versions are never overwritten, merged, moved, or deleted.
7. Archive hashes are verified before version reconciliation, comparison, review routing, and final workflow completion.

## Durable recovery states

The local workflow checkpoints selection, identity verification, confirmation, capture, archive writing, archive verification, comparison, catalog commit, and terminal status. If an archive was written but later work failed, restart continues from that archive rather than recapturing. There are no automatic retries.

## Safety

The implementation contains no automatic browser navigation or batch loop. A 30-second minimum local cooldown follows a capture attempt. Authentication changes, active-identity changes, incomplete verification, or uncertain comparison produce a stop or `needs_review` result.

Unused intents transition append-only to `expired` when their TTL elapses or to `cancelled` after an explicit operator action. Expired and cancelled intents can never be confirmed or used to begin capture; their original selection and complete transition history remain retained.

Real archive reconciliation and each real recapture are separately approved operations.
