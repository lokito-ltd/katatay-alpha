---
status: active
---

`ktty areas` prints a "Must look" list: each changed high-risk file under its reason, the rulebook, each existing requirement the change edits, and each file that gains a coverage-ignore or check-suppression comment.

## Scenarios

- [AC0064.1] A changed file in a high-risk area is listed under that area's reason, in the rulebook's order.
- [AC0064.2] A file that only resembles a listed path is not listed.
- [AC0064.3] A changed rulebook is listed even when the high-risk list is empty.
- [AC0064.4] An existing requirement the change edits is listed, and a requirement the change adds is not.
- [AC0064.5] The workflow logbook is listed only when a high-risk entry in the rulebook matches it.
- [AC0064.6] A file that gains a coverage-ignore comment, or a check's suppression comment, is listed under its own reason.
- [AC0064.7] It prints nothing when there is nothing to look at.

## Why

A tool writes the list from git, so it cannot leave out what the tools
flagged. The rulebook holds the coverage minimums and the target, so it is
always listed.

A comment that switches a tool off in one spot is a way past a check without
fixing anything. An ignore comment takes code out of the coverage figure, and
no path rule would list that product file. Only a reviewer can judge either, so
a tool, not the agent, puts them on the list.

The referee's own rules never list the logbook, which gains files on every
turn. Which files need a reviewer is the project's call, so a high-risk entry
that matches the logbook, such as `.katatay/**`, lists its events like any
other file.

Editing an existing requirement takes a promise away, while adding one does
not. A "Should look" list of failing tests was dropped, because it repeated on
every turn until the merge.
