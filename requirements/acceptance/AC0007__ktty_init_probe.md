---
status: active
---

`ktty init --probe` runs the project's commands and reports each item, and writes nothing.

## Scenarios

- [AC0007.1] A probe prints each item and exits 0 when every item passed.
- [AC0007.2] A probe exits 1 when an item failed.
- [AC0007.3] A probe in a set-up project probes the project's own rulebook.
- [AC0007.4] A probe told to expect a break exits 0 when it finds that break at the item concerned.
- [AC0007.5] A probe told to expect a break exits 1 when it finds none.
- [AC0007.6] A probe told to expect a break whose item the rulebook switches off exits 2.
- [AC0007.7] Expecting a break without probing is refused with exit 2, and nothing is written.

## Why

A command that always exits 0 passes every probe item. `--expect` proves the
opposite, that each command can fail. Whoever sets the project up breaks one
thing, and the probe passes only when it sees that break, at the item
concerned, and stops there.

A rulebook is never written on a planted break, so `--expect` without
`--probe` is refused. A state whose item is switched off cannot be seen, so it
is refused too.

Nothing makes anyone ask for every state. Before `init` has run the project has
no hooks, so nothing can hold an agent to an order. The probe checks each
state when asked, the operator sees each result, and their review of the
rulebook stays the gate.
