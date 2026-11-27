---
status: active
---

`ktty agent <claude|codex|cursor> <action>` runs exactly that adapter action with the caller's streams and exit status, and refuses anything else with exit 2.

## Scenarios

- [AC0067.1] Claude accepts defaults, install, check, pre-tool, user-prompt, post-tool and turn-end, and Codex and Cursor accept all but post-tool.
- [AC0067.2] An unknown adapter, an unknown action, a path-like action or a missing action exits 2 without starting anything.
- [AC0067.3] The action runs with the caller's stdin and stdout, and its exit status is returned.
- [AC0067.4] check prints a versioned list of warnings and exits 0.
- [AC0067.5] check exits 2 for a request that does not match.

## Why

The caller supplies an action name, never a path to run. That keeps a
project's hook registration from being pointed at an arbitrary script.

Command lines are portable, `ktty agent …`, so a project holds no copy of the
harness and nothing it installs points back into the package's folders.

Skills are prompts. The referee ships the workflow's instructions and the
harness support skills in words any agent can follow, and each adapter's
`install` turns them into its agent's format and location. Nothing the referee
requires depends on a skill, and a project holds no copy of them that could
drift from the others.
