---
status: active
---

No session writes the rulebook.

## Scenarios

- [INV0002.1] An edit to .katatay/rulebook.json is denied as locked in every phase, whatever the rulebook says.
- [INV0002.2] A shell redirect or write verb aimed at the rulebook is denied.
- [INV0002.3] Reading the rulebook through the shell is allowed.
- [INV0002.4] An adapter install answer naming a locked path is refused.

## Why

The rulebook holds the target, the minimums, the locks and the acknowledged
hooks. A session that could write it could lower its own floor.

The shell is read for locks only, and a `git` command that names no locked path
is not caught. The checks after the fact are what hold, which is why the
rulebook is always on the "Must look" list.
