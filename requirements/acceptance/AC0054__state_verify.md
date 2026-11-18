---
status: active
---

`ktty state verify` checks the logbook against its chain, git and the target, exits 1 on any problem, and reports the agent's setup only as warnings.

## Scenarios

- [AC0054.1] It exits 0 for a sound committed logbook.
- [AC0054.2] It exits 1 for a broken logbook, names the folder and the cause, and prints no stack trace.
- [AC0054.3] It exits 1 when a committed logbook folder was deleted whole.
- [AC0054.4] It exits 1 for a baseline that is not on the target, unless a later recorded event vouches for it.
- [AC0054.5] It prints a warning for each missing workflow hook and still exits 0.

## Why

A merged logbook is committed history that a later branch could quietly edit,
so every logbook is checked, not only the current branch's.

A recorded baseline is trusted, because recording already proved it against
the server. That is what lets a batch branch merge.

Setup problems are warnings, because the agent's settings are locked and the
user's settings are outside the repository. A red check would stop the change
that noticed, and no session could clear it.
