---
status: active
---

A plan declares things only in one fenced block labelled `workflow`, placed last in the file, holding YAML with no keys other than `test-only`, `requirement-changes` and `predicted-failures`.

## Scenarios

- [AC0012.1] A block holding any other key, a misspelling included, is refused, and every problem is named.
- [AC0012.2] A test-only value that is not true or false is refused.
- [AC0012.3] Every wrong field in every requirement-changes entry is named.
- [AC0012.4] Each predicted-failures entry must be a scenario id, a repository path, or path::test name, and each bad entry is named with the reason.
- [AC0012.5] A declaration quoted in the plan's prose declares nothing.
- [AC0012.6] An example block labelled yaml at the end of the plan declares nothing.
- [AC0012.7] The block is read as plain YAML and runs no code.

## Why

Only the closing block declares anything, so a paragraph that discusses a
change can never declare one. The keys are strict, because a misspelled
`test-only` would otherwise drop the declaration without anyone noticing.

`requirement-changes` approves rewordings for `req guard` outside CI, and until
`record` it stands in for the change file. Predictions list what is expected
and no more: an unlisted failure is a surprise, and a listed test that passes
is an over-prediction.
