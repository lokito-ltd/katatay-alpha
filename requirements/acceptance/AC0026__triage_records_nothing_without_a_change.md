---
status: active
---

`ktty triage` refuses with exit 1 and records nothing when there is no logbook to write to or no change to measure.

## Scenarios

- [AC0026.1] With no target in the rulebook it refuses and says no logbook event was recorded.
- [AC0026.2] With a broken logbook it refuses and says to stop and tell the operator.
- [AC0026.3] With no approved plan it refuses and says there is no change to triage.
- [AC0026.4] When the compile step cannot run it refuses and passes on why.
- [AC0026.5] When the approved plan snapshot is unreadable or belongs to another branch, it refuses before any test runs.

## Why

Without a readable logbook, or without a change, there is nothing for a
refusal to belong to. Predictions come only from the approved snapshot's exact
bytes, so missing evidence must be restored rather than guessed.
