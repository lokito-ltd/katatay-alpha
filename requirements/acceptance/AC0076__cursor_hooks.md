---
status: active
---

The Cursor hooks gate Write, Delete and Shell, take the plan approval from Build's prompt and the plan Cursor saved, give the agent the workflow's context on every prompt, and answer stop with a follow-up only when there is more to do.

## Scenarios

- [AC0076.1] A Write is checked as a write of its file and a Delete as a delete, so a requirement cannot be deleted in any phase.
- [AC0076.2] A write the referee refuses is denied with the referee's reason for the agent.
- [AC0076.3] Build saves the plan Cursor kept for it, without its frontmatter, to a new file in the plans folder, and the approval is recorded.
- [AC0076.4] A Build with no plan in the conversation records nothing and tells the operator.
- [AC0076.5] Every prompt gives the agent the workflow state as additional context.
- [AC0076.6] The stop hook prints an empty object when it has nothing to say.
- [AC0076.7] A stop the referee refuses is answered with a follow-up message.
- [AC0076.8] The Claude Code workflow hooks answer nothing when Cursor runs them.
- [AC0076.9] A Cursor workflow hook missing from .cursor/hooks.json is reported.
- [AC0076.10] An extra stop or prompt hook in a Cursor hooks file is reported as able to send the approval.

## Why

A capture under Cursor 3.32.10 on 2026-11-26 settled what Cursor's hook
documentation leaves open. Every file edit reaches `preToolUse` as `Write`,
with the file's absolute path and its whole new content, and a removal as
`Delete`. A delete under the requirements folder must be refused like any
other agent's.

Cursor has no approval hook. The agent proposes a plan with `CreatePlan`,
which no hook sees, and Cursor saves it to `~/.cursor/plans/` with YAML
frontmatter the referee refuses. Build sends a fixed prompt that names no
plan. The conversation's transcript names it, and Cursor's saved copy holds
the operator's edits from its plan editor. Both folders are locked, so a
session cannot rewrite the text the operator's Build records. Only the
operator sends a prompt, so the channel is still theirs. A Build with nothing
to approve must record nothing, and say so, because a silent no-op would leave
the operator thinking the change had started.

The prompt hook's `additional_context` is not in Cursor's documentation. The
capture showed the agent receiving it, and it is the only way the referee's
state reaches the agent before it acts.

Cursor cannot refuse a stop. A `followup_message` is sent to the agent as a new
prompt instead, and `loop_count` says whether one has run in this turn. Cursor
shows the operator nothing a hook says that the capture could prove, so reports
for the operator go to the agent to post word for word.

Cursor also runs the hooks in `.claude/settings.json`, with its own payloads.
In a project set up for both agents, each moment would run twice, verify
included. Claude Code's hooks see `cursor_version` in the payload and leave the
moment to Cursor's own.

A stop hook's follow-up arrives as a prompt, and a prompt hook sees every
prompt, so an extra one in any Cursor hooks file could send or hold back
Build's prompt. The check reports each one until the operator acknowledges it.
