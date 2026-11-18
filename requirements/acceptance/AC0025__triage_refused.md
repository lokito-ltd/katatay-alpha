---
status: active
---

When a change cannot be measured, `ktty triage` exits 1, appends `triage_refused` with a reason, and says what to do.

## Scenarios

- [AC0025.1] Tests or support files that differ from the baseline give tests_modified with the files, before the suite runs.
- [AC0025.2] An implementation that changed since the last triage gives implementation_changed.
- [AC0025.3] An implementation that does not compile gives typecheck_failed with the files, and compile errors in tests count as failing tests.
- [AC0025.4] Test reports that cannot be read give invalid_test_run, and the raw reports are kept.
- [AC0025.5] A tree or approval that changed during the run gives measurement_changed.
- [AC0025.6] A triage snapshot that cannot be saved gives snapshot_failed, and the test reports are kept.
- [AC0025.7] A test-only change whose suite is not green gives suite_not_green with the failures.

## Why

The preconditions are checked in the command rather than trusted, because the
Stop hook can be pushed past and this command cannot: without its event there
is no route to `verified`. A turned-away attempt is part of how the change
went, so it is recorded.

Only the implementation has to compile. Refusing on test compile errors
deadlocked any change to a public contract's types, because the tests that
needed changing were frozen.

A test-only change needs a green suite first. Once new tests land on top of old
failures, nobody can tell which failures they found.
