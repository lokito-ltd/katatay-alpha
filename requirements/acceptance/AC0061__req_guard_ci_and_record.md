---
status: active
---

Under `CI=true` the guard ignores the logbook and only lists approvable changes for the reviewer, and with `--record` only a change file accounts for a change.

## Scenarios

- [AC0061.1] Under CI=true, a reworded requirement with a change file is listed for the reviewer and does not fail.
- [AC0061.2] CI set to anything other than true is treated as local.
- [AC0061.3] Under CI=true the guard does not read the logbook.
- [AC0061.4] Under CI=true the guard fetches the target first, and when the server does not answer it exits 1 with one line naming the target.
- [AC0061.5] Without the target ref, the guard exits 1 with one line naming the target and judges nothing.
- [AC0061.6] Before record, a plan entry stands in for the change file, but with --record the change file is required.
- [AC0061.7] Under CI=true, a new requirement with a change file is listed for the reviewer, and one without a change file fails.

## Why

CI does not read the logbook, because a branch can write to it. There the merge
on the hosting platform is the approval, so approvable changes are printed for
the reviewer. A deletion, a missing change file or a false record still fail,
because no approval could permit them.

The plan entry stands in for the change file until `record`, so the file can be
written once the outcome is known. The record step then insists on the file.
