# Captured hook payloads

The JSON files here are what Claude Code sent the workflow hooks in a real
session on 2026-09-17. They are evidence, not examples. Nothing in them was
written by hand except the placeholder values listed below.

`payloads.mjs` loads them for the tests. Read the comment at the top of that
file for why the tests are built this way.

`post-tool-use-exit-plan-mode-edited.json` was captured on 2026-10-27, from
an approval where the operator edited the plan in the dialog before
approving. It settled whether Claude Code saves those edits to the plan file:
it does. The workflow hook of that day recorded the hash of
`tool_response.plan`, and `state:show` then reported the file unchanged since
approval, so the file held the edited text. The payload itself cannot show
this, because it carries the text and not the file. Its plan text and the
plan file's name were replaced like the rest.

## What was replaced

Only these, and only because a captured payload otherwise carries one machine's
paths and one session's identifiers:

| Placeholder       | Stands for                                    |
| ----------------- | --------------------------------------------- |
| `{{HOME}}`        | the operator's home directory                 |
| `{{REPO}}`        | the repository root, as `cwd`                 |
| `{{SCRATCHPAD}}`  | the session's scratchpad directory            |

Session ids, prompt ids and tool-use ids were replaced with fixed values of the
same shape. Prompt, plan and message text was replaced with something short,
and a plan file's three-word name with `a-plan.md`. Nothing
else was touched: fields no hook reads are still here, spelled the way Claude
Code spells them, because the next time one of them starts mattering we want the
real name rather than a guess at it.

## When to recapture

When a hook warns in a live session that a field it reads is missing. That
warning is the only thing that can notice Claude Code changing what it sends —
these files cannot, being copies of a day that has passed.

Recapturing on a schedule was considered and dropped. It would churn the
fixtures without telling anyone anything.

## How to recapture

The capture hook writes its stdin and does nothing else. It goes in
`.claude/settings.local.json`, which is not committed, so it stays temporary and
never touches the registered workflow hooks:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "mkdir -p ~/hook-capture && cat > ~/hook-capture/UserPromptSubmit-$(date +%s)-$RANDOM.json" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "mkdir -p ~/hook-capture && cat > ~/hook-capture/PreToolUse-$(date +%s)-$RANDOM.json" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "mkdir -p ~/hook-capture && cat > ~/hook-capture/PostToolUse-$(date +%s)-$RANDOM.json" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "mkdir -p ~/hook-capture && cat > ~/hook-capture/Stop-$(date +%s)-$RANDOM.json" }] }]
  }
}
```

It must go in `settings.local.json`. Putting it in `.claude/settings.json`
replaces the file that registers every workflow hook, which switches the whole
gate off silently — that happened while these fixtures were being captured, and
the only sign was a `Write` in the `open` phase that should have been denied.

Add it yourself. The protection hook denies a session writing either settings
file, the local one included.

Then run an ordinary session: send a prompt, edit a file, let the turn end. The
`ExitPlanMode` payload needs a plan the operator actually approves, since the
event fires nowhere else. Scrub the results as above, and take the capture hook
back out when you are done.

## Do not derive these from transcripts

`~/.claude/projects/*.jsonl` holds Claude Code's own record of a tool result,
which is not the JSON handed to a hook. Building fixtures from it would be a
second guess at the question these files exist to answer.
