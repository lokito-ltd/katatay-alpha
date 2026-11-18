---
status: active
---

`ktty verify --rerun` runs verify now and records the result as the turn end would, but only in `converging` and never under `CI=true`.

## Scenarios

- [AC0032.1] A rerun pass is recorded, exits 0, and the operator is told it came from a rerun.
- [AC0032.2] A rerun failure is recorded, exits 1, and the next turn end repeats it without verifying.
- [AC0032.3] A failure whose cause lay outside the tree is verified again by a rerun, and the next turn end accepts it.
- [AC0032.4] Under CI=true the rerun is refused with exit 2 and nothing is recorded.
- [AC0032.5] A rerun is refused in implementing and in verified.
- [AC0032.6] A rerun is refused, and starts no verify, when the implementation changed after triage.
- [AC0032.7] A rerun pass is refused when the tree or the rulebook changed while verify ran.

## Why

Some failures come from causes outside the tree, rulebook and baseline: the
network, the operating system, the sandbox, another branch's logbook. The
no-repeat rule cannot see such a fix, and a plain verify records nothing.
Before `--rerun` existed, a stale failure stood until someone edited the tree
for no other reason.

The command records only where the turn end would verify. Under `CI=true`,
`skipInCi` checks and mutation are left out, so a pass measured that way must
not become this change's receipt. Each event it writes is marked as a rerun,
and a pass says so, because the agent's shell is not the hook's: a changed
`PATH`, for example, can shape the result.
