---
status: active
---

A plain `ktty verify` runs every step and check, exits 0 on a pass and 1 on a failure, and writes no logbook event.

## Scenarios

- [AC0033.1] A manual verify appends no event to the logbook.
- [AC0033.2] Verify checks the requirements catalogue before any adapter step.
- [AC0033.3] Verify runs its own steps, then the rulebook's checks in the order listed, and exits 0.
- [AC0033.4] A failed test exits 1, is named, and no check runs after it.
- [AC0033.5] Verify deletes old test reports before it runs the tests.
- [AC0033.6] A branch can be verified by hand before any approval, measured from its merge base with the target.

## Why

Only the turn-end hook, or the explicit `--rerun`, may create a receipt. Verify
runs every check that CI's verify jobs run, so the agent and CI can use it as a
dry run. A report an earlier run left must never be read as this run's.
