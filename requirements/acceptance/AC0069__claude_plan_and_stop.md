---
status: active
---

The Claude Code ExitPlanMode and Stop hooks check a plan without approving it, record approval only after the operator accepts, and run verify at turn end.

## Scenarios

- [AC0069.1] Pre-tool on ExitPlanMode asks for a correction at most once per prompt and never approves the plan.
- [AC0069.2] Post-tool on ExitPlanMode records plan_approved and permits edits.
- [AC0069.3] Post-tool writes the approved text into the plan file when the file still holds the draft.
- [AC0069.4] Post-tool records nothing, and says so, when Claude Code sends no plan text or no file path.
- [AC0069.5] On a passing verify, the Stop hook refuses the stop once to relay the report to the operator.
- [AC0069.6] The Stop hook keeps the agent working on a failure, but not after a stop was already refused.
- [AC0069.7] With no referee answer, the Stop hook says nothing was verified and blocks unless that could loop.

## Why

Only the operator approves, and PostToolUse fires only when they accept, so a
turned-down plan records nothing. The approval is read from the file, never
from the request, so text alone grants nothing. The operator may edit the plan
in the dialog, so the approved text is written back into the file.

A Stop block is one-shot, so a session can never loop. The block that relays a
pass does not use up the shot. The desktop app folds hook messages away, so the
results the operator most needs go through a block that Claude repeats in chat.

The answer carries `keepWorking`, and the request carries `stopRefusedBefore`:
an earlier stop in this turn was refused, by the referee or by the adapter
delivering a message. That flag only stops a turn looping. Whether to run
verify again comes from the logbook. A pass answers `keepWorking: false`, and
delivering it to the operator is the adapter's job. The reminder in phase
`verified` is addressed to the agent, which tells the operator: addressed to
the operator, Claude's adapter would refuse every stop in that phase.

Without that exception, a failure in the forced turn, such as Claude editing a
file while repeating the result, could only be a folded message. So a turn gets
at most two blocks and still cannot loop. The reverse is not covered: a pass on
the stop after a failure's block is a message, because blocking there too would
need a budget of blocks per turn to stay loop-free.
