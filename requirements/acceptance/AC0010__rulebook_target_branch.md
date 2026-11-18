---
status: active
---

Katatay does no project work unless the rulebook's `targetBranch` is written as `<remote>/<branch>` and names a remote git knows.

## Scenarios

- [AC0010.1] A missing, blank or non-string targetBranch is refused.
- [AC0010.2] A value such as main, /main or origin/ is refused as not remote/branch.
- [AC0010.3] A remote that git does not list is refused.
- [AC0010.4] origin/release/2026 is read as remote origin and branch release/2026.
- [AC0010.5] Without a target, plan approval records nothing.
- [AC0010.6] Without a target, edits are denied except the files that never need a plan.
- [AC0010.7] Without a target, the turn end blocks, ktty state show exits 1, and ktty triage refuses without recording.

## Why

A change is measured from its baseline, the commit where `HEAD` meets the
target. With no target there is nothing to measure from, so only the files
that never need a plan may be written.

The remote is checked up front. A misspelled remote would otherwise show later
as a failed fetch, which reads as the server being down, and that has a
different fix.

The value is split at the first slash, so branch names that contain slashes
work. Every refusal shows the line the operator must write.
