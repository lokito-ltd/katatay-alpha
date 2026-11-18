---
status: active
---

The Codex hooks gate `apply_patch` and Bash, read the plan approval from the operator's prompt, and answer Stop in the JSON Codex needs.

## Scenarios

- [AC0070.1] A patch is read as every file it adds, updates or deletes, and a move counts as a delete of the old path.
- [AC0070.2] A patch that names no file is denied.
- [AC0070.3] A patch that moves a requirement away is denied in every phase.
- [AC0070.4] Yes, implement this plan saves the latest plan to a new file in the plans folder, and the change goes on to be recorded.
- [AC0070.5] Yes, clear context and implement is approved from the plan carried in the prompt.
- [AC0070.6] An approval with no plan in the thread records nothing and tells the operator.
- [AC0070.7] The hooks find the repository from a subfolder.
- [AC0070.8] The Stop hook prints an empty object when it has nothing to say.

## Why

Codex keeps no plan files, so its adapter writes one into the rulebook's plans
folder per approval. Its "Yes" arrives as an ordinary prompt, which the agent
cannot send on the operator's behalf. Codex's session transcripts are locked,
so a session cannot rewrite the transcript the plan is read from.

Hooks run from the session's folder, which may be a subfolder, so each moves to
the git root first.
