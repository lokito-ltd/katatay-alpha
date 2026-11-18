---
status: active
---

Every path listed in the rulebook's `agent.lockedPaths` is denied for writes, inside the repository and outside it, in every phase.

## Scenarios

- [AC0020.1] Entries relative to the repository, under ~/, or absolute are each locked.
- [AC0020.2] With a plan approved, editing a locked agent settings file is still denied, inside the repository and out.
- [AC0020.3] A file a relative entry does not name, or one outside its base, is not locked.
- [AC0020.4] A call that writes several files is denied whole when any one of them is locked.
- [AC0020.5] A symlink into a locked folder is judged by the folder it leads to.
- [AC0020.6] agent.lockedPaths is required whenever there is an agent section, and an empty list is valid.

## Why

Editing its own settings or hooks from inside a session would let an agent
switch off its own constraints. Each agent keeps its settings somewhere
different, so the list belongs in the rulebook, which no session can write.

The rule set lives in one place, because two rule sets meant to agree have
drifted apart here before: the adapter's old fixed patterns never enforced
`agent.lockedPaths`.

The referee owns the lock rules and the agent adapters own none. An adapter's
`defaults` command proposes its agent's settings and hooks for the list,
`init` writes them into the rulebook, and the operator owns the list from
there. A write outside the repository is none of the referee's business except
for these entries, which may name the agent's own configuration outside the
repository.
