---
status: active
---

The baseline moves only forward, recorded as `baseline_moved`, when the target is merged into the branch.

## Scenarios

- [AC0051.1] Merging the target into the branch moves the baseline forward, and the merged-in tests are not this change's.
- [AC0051.2] A target that was fetched and not merged in does not move the baseline.
- [AC0051.3] The baseline never moves backwards.
- [AC0051.4] When the server answers, a faked remote-tracking ref moves nothing.
- [AC0051.5] While the server is down, a faked ref can move the baseline.
- [AC0051.6] The operator is told the old and new baseline after a move.

## Why

After a merge of the target, the target's new work must not be counted as this
change's. A merge base that does not descend from the current baseline would
measure from before the change started, and would count work already on the
target as this change's.

While the server is down, a faked ref can move the baseline. That gap is
accepted because the proof at `record` asks the server again.
