---
status: active
---

Katatay denies writes to `.katatay/` and `.git/` in every phase, whatever the rulebook says.

## Scenarios

- [AC0019.1] Editing a logbook event, the rulebook, or .git/config is denied as locked.
- [AC0019.2] Neighbouring paths such as .gitignore, .githooks/ and .katatayx/ are not locked.
- [AC0019.3] A shell redirect into .katatay/state/ and rm -rf .git are denied.
- [AC0019.4] These locks still apply when the rulebook cannot be read.

## Why

A session that could write the logbook could grant itself a passing verify,
which is the one thing the machine exists to prevent. Hooks and config under
`.git/` run on the operator's machine and appear in no diff, so a change there
would survive a review that reads every line.

These locks are fixed in Katatay, because a rulebook that could drop them could
unlock itself.

Locks prevent drift. They are not security: the checks that actually hold come
afterwards, in the logbook's links, `req guard`, git and review.

The write moment checks the locks before anything else, so no later rule, such
as the exemption for plan files, can open a path a lock closes.
