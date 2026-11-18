---
status: active
---

Coverage fails when a code file on disk is missing from the report, so an exclusion in the test runner's config fails the check.

## Scenarios

- [AC0039.1] A code file on disk that is missing from the report makes ktty coverage exit 1, naming the file.
- [AC0039.2] Every file under the top-level code folders is compared, not only files in folders with a minimum.
- [AC0039.3] A measured file under no folder with a minimum fails.
- [AC0039.4] The failure says the file was taken out of the report, or the report is older than the file.

## Why

There are two ways past a minimum without writing a test: lower the floor, or
measure less. The rulebook lock closes the first. An exclusion or a narrower
inclusion in the coverage tool's config takes a file out of the report, and its
uncovered lines leave the figure with it. A test of the config can be edited
after triage, so the report is compared with what is on disk. Nothing allows an
exclusion: code is never left out of the figure.
