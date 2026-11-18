---
status: active
---

An automatic mutation run starts only when its whole time limit plus 20 seconds remain, `skipInCi` keeps it out of a verify under `CI=true`, and `ktty mutate` runs it on request even in CI.

## Scenarios

- [AC0044.1] A run without its whole limit plus 20 seconds left is deferred, says so, and the tree is still verified.
- [AC0044.2] A deferred run records no mutation measurement.
- [AC0044.3] Under CI=true with skipInCi, mutation starts nothing, says why, keeps the report, and goes on to the next check.
- [AC0044.4] A CI skip does not use up the plan's run, and mutation runs once outside CI.
- [AC0044.5] ktty mutate runs under CI=true whatever skipInCi says.
- [AC0044.6] ktty mutate exits 0 when clean, 1 when mutants survived, 2 when the run proved nothing, and 3 on failure.
- [AC0044.7] ktty mutate with no baseline fails and says to pass --base.

## Why

A partial run would report on some files and say nothing of the rest, so the
hook does not start a run it cannot give the whole limit.

A CI stand-in has no logbook holding the plan's run and would start a fresh
one, so `skipInCi` keeps mutation out. The skip is not the plan's run.
`ktty mutate` is an explicit request, so CI policy does not apply to it, and by
hand it has no time limit.
