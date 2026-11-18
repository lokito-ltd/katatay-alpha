# Captured Codex payloads

The files here are what Codex 0.155.1 sent hooks, and wrote and answered, in
real sessions on 2026-10-29. They are evidence, not examples. Nothing in them
was written by hand except the placeholders and the cuts listed below.

`payloads.mjs` loads them for the tests, with the placeholders filled in.

## How they were captured

A throwaway project in a scratch folder, outside any repository the workflow
guards, with a `.codex/hooks.json` that registered one script on
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PostToolUse` and `Stop`. The script saved its stdin to a file and printed
nothing, so it changed nothing Codex did. The operator trusted the hooks in
Codex's `/hooks`, which is how the trust entries in `~/.codex/config.toml`
were found.

Then, in the interactive CLI:

1. In Plan mode, the operator asked for a plan to add, rename and delete a
   file, and answered "Yes, implement this plan". Codex made every edit
   through `python3` in the shell, not with `apply_patch`.
2. In Plan mode again, a second plan, answered with "Yes, clear context and
   implement".

And once with `codex exec -s workspace-write`, told to use only
`apply_patch`, for the patch payloads. That run is also where
`permission_mode` came back as `bypassPermissions` with the sandbox still on.

The two app-server answers came from a script that started
`codex app-server` and asked `hooks/list` and `config/read` for the capture
project, the way `../app-server.mjs` asks.

| File | What it is |
|---|---|
| `pre-tool-use-bash.json` | A shell call |
| `pre-tool-use-apply-patch.json` | One patch that updates a file, moves one and deletes one |
| `user-prompt-submit.json` | An ordinary prompt |
| `user-prompt-submit-approval.json` | `Implement the plan.`, sent by "Yes, implement this plan" |
| `user-prompt-submit-clear-context.json` | The first prompt of the thread "Yes, clear context and implement" started |
| `user-prompt-submit-exec.json` | A prompt from `codex exec`, with `permission_mode` `bypassPermissions` |
| `stop.json` | The end of a turn |
| `transcript-plan-approved.json` | The transcript of the first session, up to and past both approvals: two `Plan` items |
| `transcript-clear-context.json` | The transcript of the thread the clear-context answer started: no `Plan` item |
| `app-server-hooks-list.json` | `hooks/list` for the capture project: six hooks, all trusted |
| `app-server-config-read.json` | `config/read` for the same project, cut to the keys `check` reads |

## What was replaced or cut

Only these, and only because a capture otherwise carries one machine's paths,
one session's identifiers, or text that is not ours:

| Placeholder | Stands for |
|---|---|
| `{{HOME}}` | the operator's home directory |
| `{{REPO}}` | the capture project, as `cwd` |
| `{{CODEX_MODE_INSTRUCTIONS}}` | Codex's own instructions for Plan mode, in `turn_context`: OpenAI's prompt, about 9,000 characters, which nothing here reads |
| `{{TIMEZONE}}` | the operator's timezone |

Session, turn and tool-use ids in the payloads were replaced with fixed values
of the same shape, and the transcript's file name with one built from them.
The transcripts keep only the lines an approval reads or passes over: turn
contexts, user and assistant messages, completed items other than reasoning,
and task starts and ends. Codex's own first message (the `AGENTS.md` text and
the environment) was dropped, and so was `encrypted_content`, which is opaque.
Codex writes a transcript as JSON lines. Here each is a JSON array with one
entry per line, in order, because coverage would read a `.jsonl` file under
`tools/` as code. `payloads.mjs` writes the lines back.
`config/read` keeps `features` and `allow_managed_hooks_only`, and its layer
list. The rest of the answer is the operator's personal settings. Prompt and
plan text is as it was. Nothing else was touched: fields nothing reads are
still here, spelled the way Codex spells them.

## When to recapture

When a hook warns in a live session that a field it reads is missing, or an
approval says a transcript shows a `<proposed_plan>` block and holds no `Plan`
item. Those warnings are the only thing that can notice Codex changing what it
sends. These files cannot, being copies of a day that has passed.

## How to recapture

Do it in a scratch project, never in a repository the workflow guards: a
second `.codex/hooks.json` there would replace the workflow's registration,
and changing the registered hooks makes Codex skip them until they are trusted
again. The capture hook can be this, saved as `capture.mjs` beside a
`.capture/` folder:

```js
import { writeFileSync } from 'node:fs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let event = 'unknown';
try { event = JSON.parse(raw).hook_event_name ?? 'unknown'; } catch {}
writeFileSync(new URL(`./.capture/${Date.now()}-${event}-${process.pid}.json`, import.meta.url), raw);
```

registered for each event in the scratch project's `.codex/hooks.json` as
`{ "type": "command", "command": "node /absolute/path/capture.mjs" }`, with
`"matcher": "*"` on the tool events. Start Codex there, trust the project and
the hooks in `/hooks`, and run the sessions above. The transcripts are in
`~/.codex/sessions/`, named in each payload's `transcript_path`. Scrub the
results as above.

## Plan-turn Stop timing

The original capture also contains a plan-turn Stop at
`2026-10-29T15:59:34.050Z`, for turn
`01a18863-3423-71a2-abc7-54cd1c6b4ee9`. Its `last_assistant_message` is null.
The matching completed `Plan` item is timestamped `15:59:33.923Z` in
`transcript-plan-approved.json`. The Stop hook therefore uses `turn_id` and
that structured item; it cannot use `last_assistant_message` as the plan.
The hook tests derive this payload and transcript prefix from the existing
fixtures without changing their captured contents.

The October capture establishes the event order. Its hook saved only the
Stop payload, so the transcript was inspected after the turn.

On 2026-11-01, a scratch project running Codex CLI 0.166.0 captured the
transcript during Stop. The hook read `transcript_path` and saved those bytes
before returning. Its first read contained an `item_completed` event for
the `Plan` titled “Add hello.txt”. The event’s `turn_id` matched the Stop
payload, and `last_assistant_message` was null. No retry was needed on
that turn. Other runs may need the adapter’s retry.
