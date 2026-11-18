---
status: active
---

When the first plan is approved, the baseline is pinned where `HEAD` meets the target, asked of the server, or taken from the remote-tracking ref when the server does not answer.

## Scenarios

- [AC0050.1] The baseline is pinned where HEAD meets the target, taken from the server.
- [AC0050.2] When the server does not answer, the ref as last fetched is used, and the approval says so.
- [AC0050.3] A revised plan keeps the baseline.
- [AC0050.4] With no target ever fetched and no server answer, the approval records nothing.
- [AC0050.5] The approval warns when the branch already carries work the target does not have.

## Why

The baseline is pinned, not worked out from git on every read, because a
session can move a ref: `git branch -f main HEAD` would otherwise empty the
freeze in one command. A sha the hook writes into the logbook can be moved by
no one but the hooks.

An unreachable server is an ordinary answer, so the hook falls back rather than
hangs, and the proof at the end (AC0052) catches a faked ref.

Only the approval message says whether the server answered. The event keeps the commit ID. An older fetched commit may still pass the later ancestry check, so extra files can count as this change’s until the target is merged in.
