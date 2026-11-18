---
status: active
---

Each moment, `ktty on <write|prompt|plan-presented|plan-approved|turn-end>`, reads one JSON request and prints one versioned JSON answer holding its decision, exiting 0 for any answer and 2 for input that does not match.

## Scenarios

- [AC0066.1] A request missing a required field exits 2 with one sentence naming the field.
- [AC0066.2] A request with a missing version, or another version, exits 2 on every moment.
- [AC0066.3] A refused request records nothing.
- [AC0066.4] The last message of every prompt answer is the state.
- [AC0066.5] ktty on write before approval refuses as needing a plan, but allows a file outside the repository and a shell command.
- [AC0066.6] ktty on plan-approved reads the plan from the file, not the request, and stops without recording when the file is missing.
- [AC0066.7] An answer larger than a pipe buffer reaches the caller whole.

## Why

The adapter holds no workflow rules, so a second agent needs no referee edit.
Codex was added to prove that. Every decision sits inside a 0-exit answer, so
an exit code is never mistaken for a decision.

A shared version number lets both ends detect a message they cannot read.
Katatay and its adapters change together, so a request in another version
comes from an adapter that was left behind.

The answer is written whole, because Node exiting straight after a write kept
only 64 KB on macOS, and a cut-off turn-end answer made the adapter fail closed
on a passing verify.

Every message is `{ code, for, text }`. `for` is `agent` or `operator`,
and the text is Markdown. An adapter shows a code it does not know as its text,
so the referee can add a code without an adapter change. Messages carry no
structured data yet.
