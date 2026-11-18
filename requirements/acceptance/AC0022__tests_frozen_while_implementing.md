---
status: active
---

In `implementing`, every test file and test support file must stay exactly as it was at the baseline.

## Scenarios

- [AC0022.1] Editing a test file or a support file while implementing is denied as frozen.
- [AC0022.2] A turn that changed a test, in any language, is blocked at turn end and the file is named.
- [AC0022.3] A turn that changed a fixture matched by the support globs is blocked.
- [AC0022.4] A test edited while hidden from git with skip-worktree is still caught.
- [AC0022.5] ktty triage refuses with tests_modified and lists the files that differ from the baseline.
- [AC0022.6] Tests the target gained after the baseline, and merged in, are not this change's.
- [AC0022.7] A test-only plan does not lift the freeze, and a revised plan puts it back.

## Why

Until triage runs, the freeze guarantees that every failure was caused by the
implementation and nothing else.

Support files are frozen too. In a red-team pass on 2026-10-04, a schema
fixture edited during implementation turned a real regression green, and
nothing asked anyone to look.

The freeze compares file contents, because skip-worktree hides an edit from
every diff. It measures against the pinned baseline, not the target as it
stands now, so a moved ref cannot empty the freeze.
