---
status: active
---

`ktty help` lists the available commands and how to invoke them, in any folder.

## Scenarios

- [AC0073.1] ktty help outside a project prints help on stdout, leaves stderr empty, and exits 0.
- [AC0073.2] Help starts with 'Usage: ktty <command> [arguments]' and lists every available command with a short description under 'Commands:'.
- [AC0073.3] ktty help with an argument exits 2 and prints the correct invocation and help hint on stderr.

## Why

An operator can ask the installed release which commands it supports before
setting up a project. Writing the list to stdout lets them search it in a pipe.
