---
status: active
---

`ktty req renumber <from> <to>` renames a requirement and rewrites every reference to it, and an id the target knows needs an approved plan naming both ids.

## Scenarios

- [AC0063.1] Missing arguments exit 2 and print the usage.
- [AC0063.2] It renames the file and rewrites the id in tests, pages and code wherever they are.
- [AC0063.3] It leaves alone files that are neither the catalogue, a test nor code.
- [AC0063.4] It refuses an id that is already taken, a change from AC to INV, or an id that does not exist.
- [AC0063.5] An id the target knows is refused without an approved plan, and the refusal says how to get one.
- [AC0063.6] An id the target knows is renumbered only when the approved plan names that exact pair.
- [AC0063.7] It works in the requirements folder the rulebook names.

## Why

Requirements are committed when a plan is approved, so two branches can pick
the same id. Renumbering an id the target never saw is free. Renumbering an
agreed one changes the identity of something agreed, so it needs approval. An
entry giving only the new id does not say what it moves, so it does not cover
a renumber.
