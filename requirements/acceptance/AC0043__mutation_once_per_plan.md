---
status: active
---

Mutation runs once per plan: later passes under the same approval, rulebook and baseline reuse the first measured run, and a revised plan gets a fresh run.

## Scenarios

- [AC0043.1] A later pass repeats the first run's report as stale, without running the tool again.
- [AC0043.2] A removed or altered mutation snapshot fails verify, and verify passes again without a new run once the exact bytes are restored.
- [AC0043.3] A partial measurement is kept through several reuses and an intervening CI skip.
- [AC0043.4] A revised plan runs mutation again.
- [AC0043.5] New rulebook bytes or a new baseline run mutation again.

## Why

Mutation is slow. It is not run again after the agent acts on it; `ktty mutate`
is the operator's call. The reused result is marked as from an earlier tree,
because tests may have changed since, and it names the command that measures
again. Reuse reads the producer's saved evidence and never copies a working
output as history.
