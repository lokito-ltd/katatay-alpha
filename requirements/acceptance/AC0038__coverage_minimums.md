---
status: active
---

`ktty coverage` exits 1 when a folder is below its line or branch minimum, and 0 when every folder is at or above it.

## Scenarios

- [AC0038.1] A report below the minimum exits 1, naming the folder, the figure and the minimum.
- [AC0038.2] A report at every folder's minimum exits 0 and shows each figure beside its minimum.
- [AC0038.3] A missing or unreadable report exits 1.
- [AC0038.4] Figures are rounded down to one decimal place.
- [AC0038.5] A folder that has a minimum but no measured file fails.
- [AC0038.6] With no coverage entry it exits 1 and explains how to switch coverage off; with none it exits 0 and reports that choice.

## Why

The minimums sit in `.katatay/rulebook.json`, which no session can write. They
used to be in a session-writable settings file and could be lowered from a
session.

A check that passed with no report would pass for ever after someone removed
the coverage flag, so a missing report is a failure. Enabled coverage runs on
every verify and cannot be skipped in CI.
