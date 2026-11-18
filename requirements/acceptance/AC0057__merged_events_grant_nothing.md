---
status: active
---

Events the target already holds grant nothing, so after a merge the branch, even under the same name, needs a new plan.

## Scenarios

- [AC0057.1] Once the target holds the whole logbook, the phase is open and edits are denied.
- [AC0057.2] A recorded change whose logbook is committed but not yet merged stays recorded, and one more edit sends it to converging.
- [AC0057.3] A second plan on a branch whose change is recorded is refused, and the operator is told to merge first or reset.
- [AC0057.4] A merged change's committed events do not count as the new change's events being committed.
- [AC0057.5] An approval appended after recorded grants nothing.
- [AC0057.6] After a merge, the same plan bytes get a fresh approval.

## Why

The logbook is committed and travels to the target with the branch. A name
reused two months later arrives carrying the old events. Read as live, they
would hand the new change a plan nobody approved and a freeze that is already
over.

Git cannot tell further work on a merged branch from a reused name, so both
start over. Nothing is deleted. Up to the merge nothing moves, so "one more fix
before I merge" still works.
