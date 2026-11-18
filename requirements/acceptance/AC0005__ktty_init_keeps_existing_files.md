---
status: active
---

`ktty init` keeps what a project's agent files already hold and adds the workflow's part beside it.

## Scenarios

- [AC0005.1] Init keeps an existing AGENTS.md and appends the workflow's part between marker lines.
- [AC0005.2] Init keeps existing Claude settings and hooks and adds its own hooks beside them.
- [AC0005.3] Init on a shared file that already holds the workflow's markers adds nothing.

## Why

A project that adopts Katatay already has instructions and settings of its own.
Replacing them would destroy work the operator did not ask to lose. A shared
file such as Codex's `AGENTS.md` gets the workflow's part between marker lines,
so a later run can find it and add nothing. Hook registration is merged into
what the settings file holds. It is the one locked file `init` writes, because
the operator runs `init`.
