---
status: active
---

A shell command is checked against the locks and nothing else, and is denied when it appears to write a locked path.

## Scenarios

- [AC0021.1] A redirect that lands on a locked path is denied.
- [AC0021.2] A write verb such as rm, mv, cp, tee or truncate in the same segment as a locked path is denied.
- [AC0021.3] A command that only reads a locked path is allowed.
- [AC0021.4] A heredoc body is read as content, not as a command.
- [AC0021.5] Each segment of a compound command is judged on its own.
- [AC0021.6] A shell denial says the command appears to modify a locked path.
- [AC0021.7] A shell command that touches no lock runs before any plan is approved.

## Why

Commit messages, plans and change files often quote locked paths in their text.
Writing one of those does not touch a locked path, so heredoc bodies are
skipped. Reading a locked file is always fine; only writing is closed.

A shell reading can always be dodged. A `git` command that names no locked path
is not caught, and the checks after the fact are what hold. That is why the
rulebook is always on the "Must look" list.

The reading is deliberately simple, and called rule b: a segment of the command
is denied when it names a locked path together with a write marker, which is a
redirect, `rm`, `mv`, `cp`, `tee`, `truncate` or `sed -i`. Nothing cleverer is
attempted, because any reading of a command's text can be written around. Git
commands such as `git clean` or `git config core.hooksPath` name no locked path
and are not caught.
