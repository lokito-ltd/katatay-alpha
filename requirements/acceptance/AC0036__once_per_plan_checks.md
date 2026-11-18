---
status: active
---

A `oncePerPlan` check runs until a pass measures it, and later passes under the same approval, rulebook bytes and baseline reuse that result.

## Scenarios

- [AC0036.1] A once-per-plan check's result is stored on a pass, skipped afterwards, and its findings repeated.
- [AC0036.2] A reused result is listed as stale, with the command that runs it again.
- [AC0036.3] New rulebook bytes or a new baseline make the check run again.
- [AC0036.4] A blocking once-per-plan check runs on every verify until it comes back clean, and nothing is stored while verify fails.
- [AC0036.5] A clean check, blocking or not, is listed as passed in one line.

## Why

Some checks are slow and need running once per plan. The reused result points
at the receipt that produced it, and reports read that original evidence, so
reuse never hides a limitation. Only receipts with the current rulebook
fingerprint and baseline count. A skipped or failed result speaks for nothing,
so an older receipt is asked instead.
