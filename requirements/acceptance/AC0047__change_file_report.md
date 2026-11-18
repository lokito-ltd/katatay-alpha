---
status: active
---

The `declared` event keeps the change summary lines shown to the operator, and the newest change file must open with a `## Report` section holding exactly those lines.

## Scenarios

- [AC0047.1] The operator is shown the summary and a Details link to the declared event.
- [AC0047.2] A change file whose Report differs from the declared summary is refused, and the change stays declared.
- [AC0047.3] A change file with no Report section, a Report section that is not first, or one with no text block is refused.
- [AC0047.4] Only the newest change file is checked against the summary.
- [AC0047.5] A change file written by the agent before record declares nothing.
- [AC0047.6] With coverage or mutation switched off, the summary at record names each check it did not run.

## Why

The change file is what survives the merge; the plan is never committed. The
agent writes the file, but the harness measured the lines, so they are compared
rather than trusted. The full report is kept as a snapshot the event names.

Matching the snapshot’s decision and tree to the event keeps a report from another decision from standing in for the one the operator saw. The declaration also holds the headline lines, so a fresh checkout can compare them with the change file even when Git ignored the full report.
