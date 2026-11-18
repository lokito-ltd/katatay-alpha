---
status: active
---

A change reaches `recorded` only after `git ls-remote` shows that every baseline in its logbook is on the server's target; while the server does not answer, it stays `declared`.

## Scenarios

- [AC0052.1] While the server does not answer, the change waits in declared, says why, and records once the server answers.
- [AC0052.2] A baseline not on the server's target is refused, naming it, and ktty state verify in CI fails it too.
- [AC0052.3] A commit only this branch has is not proved, even when the local ref says otherwise.
- [AC0052.4] A tip this repository has not seen yet is fetched before ancestry is checked.
- [AC0052.5] CI passes a recorded change whose baseline is not on the target, because recording proved it.
- [AC0052.6] In CI, ktty state verify fetches the target first and fails if the server does not answer; outside CI it works offline.

## Why

A remote-tracking ref is a file a session can rewrite; the server's protected
branch is not. Checking the result catches every way the ref could have been
moved, where a list of forbidden commands would always be one form behind.

While the server is down, the stop is news, not work, so the turn is not
blocked. CI trusts a baseline pinned before a `recorded` event so that a batch
branch, whose baselines reach the target only when it merges, can merge. The
cost is that the proof then rests on the recording step alone, and only a
reviewer reading the diff would see it skipped.
