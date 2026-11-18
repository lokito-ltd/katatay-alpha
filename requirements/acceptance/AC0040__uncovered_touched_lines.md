---
status: active
---

After a verify pass, the touched lines that no test runs are listed by file and line range, and they never block.

## Scenarios

- [AC0040.1] A pass names the touched lines no test runs, before the mutation findings, and the phase is verified.
- [AC0040.2] Only lines added or changed since the baseline are listed, never old lines or tests.
- [AC0040.3] Coverage is measured afresh on every pass.
- [AC0040.4] Uncovered touched lines are read from the coverage snapshot the verification names, not from the working output file.
- [AC0040.5] A broken coverage report fails verify.
- [AC0040.6] With coverage switched off, the summary says coverage was not checked.
- [AC0040.7] ktty coverage run by hand saves no snapshot.

## Why

Folder minimums guard the whole codebase. The touched-line list shows what this
change added without a test. A covered line ran, and nothing says anything was
asserted, so the list is advice, and mutation is the check on assertions.

The verification keeps the raw LCOV and the analysis as digest-named snapshots,
so changing or deleting the working output after verify changes nothing. A hand
run writes no snapshot, so no snapshot exists that no event names.
