---
status: active
---

A change file needs a non-empty `## Departures` section, and the change reaches `recorded` only when the requirements guard passes on the change files as they stand.

## Scenarios

- [AC0048.1] A change file without a Departures section is refused, nothing is recorded, and the change stays declared.
- [AC0048.2] An empty or whitespace-only Departures section is refused.
- [AC0048.3] A Departures section that says None. is accepted.
- [AC0048.4] The change walks verified, declared, recorded once the operator types record and the change file passes.
- [AC0048.5] Once recorded, every file is staged, the recorded event included, and the commit message is asked for once.
- [AC0048.6] Editing a change file after recorded sends the change back to declared.
- [AC0048.7] At record the guard runs in record mode, where only a change file accounts for a requirement change.

## Why

After the merge, the change file is the only place a reviewer can learn that
something was done differently from the approved plan. The check is presence,
not truth: nothing can check departures against a plan that is not in the
repository. Still, `None.` shows the question was asked.

Change files sit outside the tree fingerprint, so writing one does not void the
declaration. The guard's pass is keyed to their exact contents, so an edit
sends the change back to `declared`.
