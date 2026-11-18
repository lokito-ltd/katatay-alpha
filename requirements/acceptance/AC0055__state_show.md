---
status: active
---

`ktty state show` prints the phase, why it is that phase, whether the logbook is committed and how much of it is merged, and exits 1 when the logbook is broken.

## Scenarios

- [AC0055.1] It prints the phase as broken and the offending file, and exits 1, for a broken logbook.
- [AC0055.2] It reports an uncommitted logbook as unprotected, not as empty.
- [AC0055.3] It reports a committed logbook as held against git.
- [AC0055.4] It tells a deleted logbook apart from one that never started.
- [AC0055.5] It says how many of its events the target already holds, and only when some are.
- [AC0055.6] It shows no approved plan after a reset, even while the old snapshot can still be read.
- [AC0055.7] It names each agent whose extra-hook check is switched off.

## Why

Uncommitted events can be erased with no trace, so the operator has to see
whether git is witnessing the logbook.

A line printed on every run is a line nobody reads, so the merged count appears
only when it matters. A folder full of events that reports `open` needs to say
why, or it looks like a fault.

Each adapter checks its own hooks. Switching off the extra-hook check hides its list of unexpected registrations while missing or disabled workflow hooks still produce warnings. Naming the adapter makes clear which list the operator can rely on.
