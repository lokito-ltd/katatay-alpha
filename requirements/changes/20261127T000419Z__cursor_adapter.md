---
requirements:
  - id: AC0067
    status: active
    statement: '`ktty agent <claude|codex|cursor> <action>` runs exactly that adapter action with the caller''s streams and exit status, and refuses anything else with exit 2.'
    scenarios:
      - '[AC0067.1] Claude accepts defaults, install, check, pre-tool, user-prompt, post-tool and turn-end, and Codex and Cursor accept all but post-tool.'
      - '[AC0067.2] An unknown adapter, an unknown action, a path-like action or a missing action exits 2 without starting anything.'
      - '[AC0067.3] The action runs with the caller''s stdin and stdout, and its exit status is returned.'
      - '[AC0067.4] check prints a versioned list of warnings and exits 0.'
      - '[AC0067.5] check exits 2 for a request that does not match.'
  - id: AC0076
    status: active
    statement: The Cursor hooks gate Write, Delete and Shell, take the plan approval from Build's prompt and the plan Cursor saved, give the agent the workflow's context on every prompt, and answer stop with a follow-up only when there is more to do.
    scenarios:
      - '[AC0076.1] A Write is checked as a write of its file and a Delete as a delete, so a requirement cannot be deleted in any phase.'
      - '[AC0076.2] A write the referee refuses is denied with the referee''s reason for the agent.'
      - '[AC0076.3] Build saves the plan Cursor kept for it, without its frontmatter, to a new file in the plans folder, and the approval is recorded.'
      - '[AC0076.4] A Build with no plan in the conversation records nothing and tells the operator.'
      - '[AC0076.5] Every prompt gives the agent the workflow state as additional context.'
      - '[AC0076.6] The stop hook prints an empty object when it has nothing to say.'
      - '[AC0076.7] A stop the referee refuses is answered with a follow-up message.'
      - '[AC0076.8] The Claude Code workflow hooks answer nothing when Cursor runs them.'
      - '[AC0076.9] A Cursor workflow hook missing from .cursor/hooks.json is reported.'
      - '[AC0076.10] An extra stop or prompt hook in a Cursor hooks file is reported as able to send the approval.'
---

# Cursor agent adapter

## Report

```text
prediction: 2 surprises · protected files: 3 · risk: HIGH
AC scenarios: 10 added, 1 reworded, 0 retired
tests: 121 added, 7 modified, 2 removed
change coverage 72% (319 of 440 lines) · mutants: 888 caught, 118 survived, 464 unproved (earlier tree)
follow-ups +0 −0 · code +1776 −9 lines
```

## Why

The operator asked for Katatay to guard changes made with Cursor, as it
already guards Claude Code and Codex. Before this change, `ktty init` set up
only those two, and a Cursor session in a Katatay project ran with no gate,
no turn-end verify and no way to approve a plan.

Cursor's hook documentation leaves open what the adapter most needs: which
tool names reach the pre-tool hook, whether the prompt hook can pass context
to the agent, and what Build sends. A capture under Cursor 3.32.10 on
2026-11-26 settled them, as a capture settled Codex's.

## What

A third agent adapter, `src/agents/cursor/`, and `ktty init` and
`ktty agent cursor …` with it.

- Every `Write` and `Delete` asks the referee first, and `Shell` is checked for
  locks only. A denial reaches the agent as `agent_message`.
- Every prompt gives the agent the workflow's state as `additional_context`.
  The operator's `record` and `reset` work as in Claude Code.
- Build's prompt is the approval. The adapter finds the plan the transcript
  names, takes Cursor's saved copy without its frontmatter, the operator's
  editor edits included, writes it to a new file in the plans folder and
  records it.
- The stop hook runs the turn end. It answers with a `followup_message` when
  the agent must keep working, or when the operator has a report to see.
- Claude Code's workflow hooks answer `{}` when Cursor runs them, so a project
  set up for both agents runs each moment once.
- Cursor's check reads the project, user and enterprise hooks files and warns
  about a missing or changed workflow hook, an extra hook (a stop or prompt
  hook as able to send Build's prompt) and a missing rule file.

Left out: installing the `ktty-init` skill in Cursor's user skills folder,
adding Cursor to this repository's own rulebook and hooks, team and plugin
hooks the check cannot see, and an approval typed by hand.

## Departures

- The AC0076.4 test was written to the message the hook prints. A Build with
  no plan tells the agent to tell the operator ("… Tell the operator."), and
  this message does not carry the "post verbatim" wrapper the recorded case has.
  The scenario holds. The test was adjusted after triage, as the
  implementation was frozen.
- After the first verification, tests were added beyond the planned delta:
  unit tests for the copied `referee.mjs`, `runaway.mjs` and `drift.mjs`, and
  cases for each surviving mutant with an observable effect. The rule test
  checks all three adapters' hooks, not only Cursor's. The copied "cannot be
  started" referee case was dropped, because Node refuses that input before
  anything starts.
- The acceptance support step is `givenACursorSavedPlan`, not
  `givenACursorPlan` as the plan named it.
- One branch in `recordBuild` (`count === 0`) is dead code and was left as
  is, because removing it needed a revised plan.
- Mutation was measured once, before the extra tests. Whether they kill the
  118 survivors is not measured.

## How

**Prompt context relies on an undocumented field.** Cursor documents only
`continue` and `user_message` for `beforeSubmitPrompt`. The capture showed the
agent receiving `additional_context`, and nothing else reaches the agent
before it acts. If a Cursor release drops it, the drift warning names the
missing field and the fixtures are recaptured.

**Build is recognised by its first sentence, exactly.** The prompt names no
plan, so the transcript's newest `CreatePlan` gives the name, and Cursor's
saved copy with that name gives the text. A copy whose text is unchanged is
preferred over a newer edited one with the same name. When no copy is found,
the proposed text is recorded with a warning that editor edits are missing.
If Cursor rewords Build, nothing is recorded and the next write is denied
with "present a plan": the failure is safe and visible.

**Plans go to `~/.cursor/katatay-plans`, not Cursor's own folder.** Cursor's
`~/.cursor/plans` is locked, because the approved text is read from it, and its
files open with frontmatter the referee refuses. `~/.cursor/projects/**` is
locked for the same reason: it holds the transcripts.

**The gate never answers `permission: "allow"`.** An allow could answer a
question Cursor would otherwise ask the operator. The capture showed `{}` from
one hook letting a call go on beside another's answer, so `{}` is the
pass-through. `failClosed: true` makes a crashed gate deny.

**Claude's hooks stand aside, rather than Cursor's.** Cursor runs
`.claude/settings.json` hooks with its own payloads. Claude's adapter does not
know Cursor's `Delete`, follow-ups or Build, so the Claude hooks answer `{}`
when the payload carries `cursor_version`. Only warning the operator to turn
off Cursor's third-party hooks was rejected, because a doubled `record` or
verify is too costly to leave to a setting.

**Reports for the operator go through the agent.** The capture found no hook
field Cursor shows the operator. So prompt context and stop follow-ups ask the
agent to post operator messages word for word, once per turn, with
`loop_limit: null` so Cursor's default cap of five follow-ups never cuts a
report short.
