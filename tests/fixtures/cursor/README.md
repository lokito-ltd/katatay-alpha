# Captured Cursor payloads

The files here are what Cursor 3.32.10 sent hooks, and wrote, in a real
session on 2026-11-26. They are evidence, not examples. Nothing in them was
written by hand except the placeholders and the cuts listed below.

`payloads.mjs` loads them for the tests, with the placeholders filled in.

## How they were captured

A throwaway project in a scratch folder, outside any repository the workflow
guards. Its `.cursor/hooks.json` registered one logging script on every hook
event Cursor documents. Its `.claude/settings.json` registered the same script
on Claude Code's `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse` and `Stop`, to see whether Cursor runs those too. It does.

The script saved its stdin and environment, and answered with probes. The
prompt hook answered `additional_context` with a marker word. The pre-tool hook
denied any call naming `deny-me.txt`. The stop hook sent one follow-up after a
prompt containing `probe-stop`.

Then, in one Agent chat in the desktop app:

1. `Append the line "second line" to notes.txt.`, which Cursor made as a
   `Write` with the whole new content.
2. `Delete old.txt using your file tools, not the shell.`, a `Delete`.
3. A replacement in `deny-me.txt`. The probe denied the `Read` before it, so
   no `Write` was sent.
4. `Run ls in the terminal, then list every marker word you were given in this
   chat.` The agent named the prompt and post-tool markers.
5. `probe-stop: say hello.` The follow-up arrived as a new prompt, and the
   next stop had `loop_count: 1`.
6. In Plan mode, a plan to add `hello.txt`, then Build.
7. `record`, as a bare prompt.

| File | What it is |
|---|---|
| `pre-tool-use-write.json` | A file edit, as `Write` |
| `pre-tool-use-delete.json` | A file removal, as `Delete` |
| `pre-tool-use-shell.json` | A shell call, as `Shell` |
| `before-submit-prompt.json` | An ordinary prompt |
| `before-submit-prompt-plan-mode.json` | A prompt in Plan mode, `composer_mode: "plan"` |
| `before-submit-prompt-build.json` | The prompt Build sends |
| `before-submit-prompt-followup.json` | A stop hook's `followup_message`, arriving as a prompt |
| `stop.json` | The end of an ordinary turn, `loop_count: 0` |
| `stop-after-followup.json` | The end of the turn a follow-up started, `loop_count: 1` |
| `claude-*.json` | What Cursor sent the hooks in `.claude/settings.json` |
| `transcript-build.json` | The Plan-mode prompt, the `CreatePlan` call, the turn's end and Build's prompt, from the conversation's transcript |
| `saved-plan.plan.md` | The plan Cursor saved to `~/.cursor/plans/` for that Build, after it finished the todo |

## What was replaced

- The capture project's path is `{{REPO}}`, and the home folder `{{HOME}}`.
- The transcript's project folder under `~/.cursor/projects/` is `repo`.
- Conversation, generation and tool-call ids are numbered placeholders, the
  same id the same number everywhere.
- The account's email is `operator@example.com`.

The transcript is kept as a JSON array, one entry per line of the file, for
the reason `payloads.mjs` gives.

## When to recapture

When a hook warns that Cursor sent no field it reads. Recapture the same way,
with the same steps, and replace these files.
