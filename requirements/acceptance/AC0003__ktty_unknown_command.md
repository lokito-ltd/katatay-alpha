---
status: active
---

`ktty` refuses a command or arguments it does not know, before it runs anything.

## Scenarios

- [AC0003.1] An unknown command exits 2 and prints its name and the help hint on stderr.
- [AC0003.2] ktty agent with an unknown adapter or action exits 2 and prints the expected invocation and help hint on stderr.
- [AC0003.3] ktty agent with an argument after the action runs nothing, exits 2, and prints the expected invocation and help hint on stderr.
- [AC0003.4] ktty without a command exits 2 and prints a missing-command message and the help hint on stderr.
- [AC0003.5] A recognized command with invalid arguments runs nothing, exits 2, leaves stdout empty, and prints the correct invocation and help hint on stderr.

## Why

Exit 2 means "you asked wrongly", which is different from a check that ran and
failed (exit 1). The first line identifies the problem. The second tells the
operator how to get the command list. Both go to stderr so a script reading
stdout never mistakes the diagnostic for an answer.

`ktty agent` takes an action name, never a path. A project's hook registration
can therefore only point at the adapter's own actions, never at an arbitrary
script.

Argument checks run before project setup, stdin or any delegated command.
Otherwise a misspelling could start a verification, write a report or change
the logbook before the operator sees the correction. A correctly invoked
command reports its own outcome, including a hook refusing invalid JSON.
