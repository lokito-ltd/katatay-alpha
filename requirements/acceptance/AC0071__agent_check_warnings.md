---
status: active
---

The agent check warns, and never fails, about any setup that could switch the workflow's hooks off or answer the plan dialog.

## Scenarios

- [AC0071.1] A workflow hook that is missing, points at another script, covers fewer tools, or has a Stop timeout too short for the suite is reported with what stops working.
- [AC0071.2] An extra hook in any settings file is reported with the file that registers it, and called out when it can answer the plan dialog, unless the operator acknowledged it.
- [AC0071.3] A hook declared in a skill's or an agent's frontmatter is reported.
- [AC0071.4] disableAllHooks and allowManagedHooksOnly are reported.
- [AC0071.5] A Claude plansDirectory that differs from the rulebook's plans folder is reported.
- [AC0071.6] An env entry such as CI, PATH or NODE_OPTIONS is reported with what it changes.
- [AC0071.7] A missing instructions file is reported.

## Why

`.claude/settings.local.json` is git-ignored, and `disableAllHooks` there would
switch every hook off with no diff. The 2026-09-17 loss of hooks showed only as
a write that should have been denied. A hook matching ExitPlanMode can approve
a plan, and a stray `plansDirectory: "."` once made `CLAUDE.md` writable before
approval.

This detects and does not prevent. It cannot see `--settings`, managed policy
or plugin hooks, so a clean report means only that the files are clean.

How hard hooks are to switch off, and whether the agent can act as the
operator, differ by agent. Each adapter reports what it cannot guarantee as a
`check` warning, so the referee needs no knowledge of any agent.

When Claude Code's `plansDirectory` puts plans outside the rulebook's
`plans.dir`, plan mode cannot write its plan before approval, and the dialog
arrives empty. An `env` entry named `CI`, `GIT_*`, `NODE_OPTIONS`, `PATH`,
`HOME` or `CLAUDE_CONFIG_DIR` changes what the hooks run or read. `.claude/` is
locked and the operator's own settings are outside the repository, so no session
can repair either. A failing verify would stop the change that noticed and leave
nobody able to clear it, so the finding is a warning for the operator.
