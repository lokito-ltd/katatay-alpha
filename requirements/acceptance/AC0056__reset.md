---
status: active
---

The operator's `reset`, typed as the whole message, appends a reset event, starts a new epoch at `open`, and keeps every earlier event and change file.

## Scenarios

- [AC0056.1] reset typed as the whole message moves the phase to open and appends a reset event after the others.
- [AC0056.2] A sentence that mentions resetting is not a reset.
- [AC0056.3] A reset lists the branch's change files and tells the operator they stay on the branch but no longer count.
- [AC0056.4] Approvals, triages and receipts from before a reset grant nothing afterwards.
- [AC0056.5] After a reset, the same plan bytes get a fresh approval.
- [AC0056.6] A reset into a logbook whose committed events were edited is refused and records nothing.
- [AC0056.7] A reset mends a logbook broken only by a missing recorded change file.

## Why

Only the operator ends an epoch, and they do it by appending, so history is
never removed. Matching the whole message, ignoring case, with an optional
`: note`, means a question like "should we reset?" is prose and not a command.

A reset can mend only a breakage that belongs to the epoch it abandons: a
missing change file named by `recorded`. Edited events stay visible to every
later read, so a reset on top would fix nothing.
