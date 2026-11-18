---
status: active
---

A failed verify is not run again at turn end while the tree, the rulebook and the baseline are unchanged.

## Scenarios

- [AC0031.1] A turn end does not run verify again while nothing has changed since it failed.
- [AC0031.2] A turn end runs verify again when the tree has changed since it failed.
- [AC0031.3] A turn end runs verify again when the rulebook has changed since it failed.
- [AC0031.4] A baseline move to the same commit keeps the failure standing.
- [AC0031.5] A target that advances, even by an empty commit, gets the same failing tree verified again.
- [AC0031.6] A pass after the failure ends the hold, even if the tree returns to the one that failed.

## Why

On the same tree, rulebook and baseline, verify would fail the same way, and it
can take minutes. The rulebook sits outside the tree fingerprint, so it is
compared on its own. Otherwise a fix there, such as a coverage minimum, would
never be verified until some file changed.

When verify is not run again, the turn end repeats the stored failure from the
event alone and points to `--rerun`.
