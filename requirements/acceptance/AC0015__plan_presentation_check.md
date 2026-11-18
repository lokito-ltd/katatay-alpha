---
status: active
---

When a plan is presented, Katatay checks its format and asks for a correction at most once, and approval never depends on that check.

## Scenarios

- [AC0015.1] A complete plan passes silently, with no event and no phase change.
- [AC0015.2] Every template problem is listed, the agent is kept working once, and the next refused stop lets the turn end.
- [AC0015.3] ktty on plan-presented answers with whether a correction is needed and its messages, changes no state, and exits 2 for a malformed request.
- [AC0015.4] With plans.validateFormat false the section checks are skipped but the workflow block checks are not, and a non-boolean value is refused.
- [AC0015.5] An unreadable plan file, or one not directly in the plans folder, gives the operator a warning and blocks nothing.
- [AC0015.6] A plan with no sections is still recorded when the operator approves it.
- [AC0015.7] An invalid presented plan does not stop the freeze check or verification at turn end.

## Why

The check helps the operator see problems before approving. Its messages never
replace the freeze check, verification, mutation or recording.

A correction is asked for at most once per prompt, because a refused stop is
one-shot: pushing past it again would only stall the machine. Template checks
can be switched off, but the YAML and declaration checks always run.
