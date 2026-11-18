---
status: active
---

Verify runs mutation testing on the code lines touched since the baseline, and reports survivors and inconclusive runs without failing.

## Scenarios

- [AC0041.1] The verification summary shows the counts and each survivor by file, line and mutator.
- [AC0041.2] The mutation command is given its time budget and the touched lines to mutate.
- [AC0041.3] A run that proves nothing is reported as partial, never as passed.
- [AC0041.4] Tests, excluded paths and non-code files are never mutated.
- [AC0041.5] With mutation switched off, the summary says it was not checked and verify still passes.

## Why

Mutants are planted only in touched code, because the question is whether this
change's tests catch bugs in this change. Some mutants change nothing
observable, so the operator decides what to do about a survivor, and a survivor
never blocks. A run that tested nothing must not read as clean, so it is
partial. Even a clean run says only that no mutant survived by the tool's own
account: a tool that ran no test could say the same.
