---
status: active
---

Installing the release tarball with npm gives the operator a working `ktty` and the `ktty-init` skill in each agent's user skill folder, without the network.

## Scenarios

- [AC0074.1] The tarball installs with npm without the network, its one runtime dependency bundled.
- [AC0074.2] The install puts the same ktty-init skill in the Claude Code and Codex user skill folders.
- [AC0074.3] With CLAUDE_CONFIG_DIR and CODEX_HOME set, the install puts the ktty-init skill under those folders.
- [AC0074.4] Reinstalling the same release over its own ktty-init skills succeeds and leaves them unchanged.
- [AC0074.5] A different ktty-init skill already in a user skill folder is kept, and the install fails, naming that file.
- [AC0074.6] The installed ktty version prints the release in the package.
- [AC0074.7] The installed ktty path prints the folder the package is installed in.

## Why

The tarball is how Katatay reaches a project. The rest of the conformance suite
runs a `ktty` that is already in place, so it never sees the install itself.
These scenarios do: they build the tarball, install it into a throwaway global
npm prefix with throwaway home folders, and run what the install left behind.

An operator sets a project up by asking an agent to use the `ktty-init` skill,
so the install has to put that skill where each agent looks for user skills.
Both agents let the user move their configuration folder, with
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and the install follows them.

The skill folders belong to the user. A `ktty-init` skill that differs from
Katatay's is someone's own work, so the install keeps it and fails, naming the
file, rather than overwrite it. Reinstalling the same release finds its own
copy and goes on.

The tarball installs without the network because a machine that can run the
release should not need the registry to install it. Its one runtime
dependency travels inside it.

`ktty path` exists so a project can name the files the package ships, such as
the TypeScript adapter's reporter, wherever npm put them.
