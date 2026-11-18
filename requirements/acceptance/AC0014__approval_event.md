---
status: active
---

An approval is recorded as one `plan_approved` event that holds the hash of the plan file's bytes, a snapshot of those bytes, the declarations and the baseline.

## Scenarios

- [AC0014.1] The event holds the proposal hash, the test-only flag, the requirement changes, the plan snapshot and the baseline, and no plan file path.
- [AC0014.2] The plan is read from the file, never from the request.
- [AC0014.3] Approving identical bytes again, even from another file, appends nothing and keeps the phase.
- [AC0014.4] A revised plan replaces the earlier one, keeps the baseline, and sends the change back to implementing.
- [AC0014.5] The snapshot stays authoritative after the working plan file is edited or removed.
- [AC0014.6] The approval message names a test-only declaration and the approved requirement ids, and a test-only approval says to run triage first.
- [AC0014.7] A first approval warns the operator when the branch already changes files the target lacks.

## Why

Approval is the only way a change gets permission to start, and it is a click
the agent cannot make for itself. The hash is taken from the bytes handed over,
so the file the logbook names is the file that was hashed.

Plans are not committed, so the snapshot under `.katatay/local/` is the
approved plan. A revision goes back to `implementing` because a triage belongs
to the plan it follows.

A branch cut from another unmerged branch is not supported. That is a warning
rather than a refusal: the work simply counts as this change's.

The adapter supplies the approved file directly in the configured plans folder.
The folder can be inside or outside the repository. Only Markdown files directly
in it qualify. Publishing a snapshot before appending its event lets an adapter
reuse a working file for a revision without destroying the first approval.
