---
status: active
---

Each rulebook check maps its exit code to clean, findings or broken, and any code the rulebook does not list counts as broken.

## Scenarios

- [AC0034.1] An exit code the rulebook lists is read as what the rulebook says, ranges included.
- [AC0034.2] An exit code the rulebook does not list is broken, and the message names where to list it.
- [AC0034.3] A run stopped by a signal or past its time limit is broken.
- [AC0034.4] A command that names the changed files is skipped when no file changed, and verify passes.
- [AC0034.5] Verify runs compile, tests, coverage and mutation first, then the test-quality checks, then the code-quality checks, whatever the rulebook's order.

## Why

A code that is not listed means broken, so a crash never reads as a clean run.
Exit-code ranges exist for tools such as dependency-cruiser, which exit with
their number of findings.

A command naming `{changedFiles}` is skipped when nothing changed, because many
tools given no file check the whole project.
