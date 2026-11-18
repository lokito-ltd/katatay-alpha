---
status: active
---

Findings fail verify under `onFailure: block` and are only reported under `report`, but a broken or unconfigurable check fails verify either way.

## Scenarios

- [AC0035.1] Verify fails at the first blocking check that finds something.
- [AC0035.2] Verify goes past a check that only reports, and prints what it found.
- [AC0035.3] A reporting check that broke fails verify.
- [AC0035.4] A check that cannot be set up refuses verify, and none of its commands run.
- [AC0035.5] Under CI=true a skipInCi check is skipped, says so, and its output is left alone; outside CI it runs.
- [AC0035.6] Only CI set to exactly true counts as CI.

## Why

`report` lets findings through and nothing else. A tool that broke checked
nothing, so a pass after it would claim more was checked than was.

A setup error, such as no target for `{baseline}` or an output file git tracks,
is a broken harness rather than a finding, so it refuses verify as any rulebook
error does. `skipInCi` exists for a clean copy that stands in for the pipeline.
