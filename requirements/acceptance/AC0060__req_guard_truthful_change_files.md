---
status: active
---

`ktty req guard` fails a change file that does not say truthfully what changed.

## Scenarios

- [AC0060.1] A change file whose status, statement or scenarios differ from the catalogue fails, in CI too.
- [AC0060.2] Only the newest change file that records a requirement must match the catalogue.
- [AC0060.3] A mention of an id in prose accounts for nothing.
- [AC0060.4] A retirement must be recorded in a change file even when the statement is unchanged.
- [AC0060.5] The change file template and change files already on the target are not judged.
- [AC0060.6] A renumber needs a change file that records the requirement under its new id.

## Why

A record that misdescribes its own change reads as evidence while being false,
so no approval can lift it. Entries state the requirement as it now stands,
because "reworded for clarity" means nothing without the old version.

Change files are named by timestamp, not sequence number, because a number
chosen when a branch starts guesses the merge order wrong whenever two branches
are open at once.
