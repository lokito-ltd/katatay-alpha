---
status: active
---

`ktty report` prints the change summary for the current tree and writes no event.

## Scenarios

- [AC0049.1] Before record, ktty report shows a preview that says it is a preview and links no event.
- [AC0049.2] After a decision, ktty report shows the summary kept with it, and its link.
- [AC0049.3] A kept report that no longer reads is named, and a preview is shown instead.
- [AC0049.4] A pass that came from a rerun is named on the summary's last line.
- [AC0049.5] Once the tree moves past its verification, coverage and mutation are reported as missing.

## Why

The agent or the operator can see what `record` would show without moving the
machine. A mutation line marked as from an earlier tree means the run is older
than the tree in front of you, and `ktty mutate` checks again by hand.
