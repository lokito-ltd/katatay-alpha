---
status: active
---

The referee starts only git, its own Node runtime, and the commands the rulebook or the operator's command line names.

## Scenarios

- [INV0004.1] Every referee command run through ktty, with logging shims on PATH, starts only git, its own runtime and the commands the rulebook or its arguments name.

## Why

The referee must be language-free, so a project's toolchain enters only
through the rulebook. Before this rule, the risk command ran `npx vitest`
itself, and a guard call stayed hidden in the Stop hook. The old check looked
for `npx` and `tsc` and missed `npm`.

The operator's command line counts too: `ktty defaults` and `ktty init --agent`
start the adapter command they are given, because the operator named it there.
Agent adapters are not the referee, so what `ktty agent` starts is the
adapter's own business.

The black-box check puts a logging shim in front of every program on `PATH`
and marks the rulebook's commands, so anything else the referee starts shows
up unmarked. A scan of the referee's source, `language-free.test.mjs`, holds
the same rule from inside, and fails on a program or tool name it does not
expect.
