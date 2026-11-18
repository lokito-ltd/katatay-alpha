---
status: active
---

The Claude Code prompt and pre-tool hooks put the phase in front of every turn, hear `record` and `reset`, and gate Edit, Write, NotebookEdit and Bash.

## Scenarios

- [AC0068.1] The prompt hook puts the current phase in front of every turn as added context.
- [AC0068.2] record and reset count only as the whole message, in any case, with an optional note after a colon.
- [AC0068.3] With no referee answer, the prompt hook says the state is unavailable and lets the prompt through.
- [AC0068.4] Edit, Write and NotebookEdit on a repository file are denied before a plan is approved.
- [AC0068.5] A Bash command that writes a locked path or removes a requirement is denied, and any other Bash runs before approval.
- [AC0068.6] With no referee answer, a file write is denied and a shell command is left alone.
- [AC0068.7] A pre-tool payload that is not JSON is let through with exit 0 and no output.

## Why

The phase is injected every turn, because the agent would otherwise meet each
rule only when refused.

A shell command is read only for locks. A text reading can always be dodged,
and edits made through the shell are caught at turn end. The shell stays open
on failure so someone can find out what broke.

A payload that is not JSON is the one deliberate exception to failing closed:
it names no tool and no path, so there is nothing to decide.

Whether a plan or the follow-ups file needs no plan is the referee's decision,
because both are named by the rulebook and a hook may not import the referee's
rules. So with no referee answer the hook denies every file write, plans and
the follow-ups file included. When the rulebook itself cannot be read, its
locks cannot either, so the referee then denies writes outside the repository
too, and allows only the default follow-ups file.
