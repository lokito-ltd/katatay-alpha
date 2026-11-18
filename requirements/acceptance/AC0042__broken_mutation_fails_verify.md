---
status: active
---

A crashed mutation run or an invalid mutation report fails verify, and a failed verify uses up no run.

## Scenarios

- [AC0042.1] A mutation command that fails without a report fails verify, records verify_failed, and shows the tool's error.
- [AC0042.2] A stale report is removed first, and a run that writes none fails.
- [AC0042.3] An invalid report fails with the specific validation error.
- [AC0042.4] A run stopped by its backstop is reported as having overrun.
- [AC0042.5] A broken run is tried again after a fix.
- [AC0042.6] A plan whose code check failed later runs mutation again, and only the successful verify is recorded as the plan's run.

## Why

Silence would read as "nothing survived". A tool that crashed checked nothing,
so the result cannot be a pass. A run stopped by the referee's backstop
proves nothing either, because a process stopped from outside may leave its
workers running. Only a passing receipt uses up the plan's run,
so a broken attempt never stands in for a measurement.
