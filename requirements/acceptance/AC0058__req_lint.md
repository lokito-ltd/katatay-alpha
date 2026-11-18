---
status: active
---

`ktty req lint` exits 1 with a heading and then the details for a malformed catalogue, and says the catalogue is OK for a sound one.

## Scenarios

- [AC0058.1] A well-formed catalogue passes and says so.
- [AC0058.2] A filename without an id, or a requirement in the wrong type folder, fails.
- [AC0058.3] A body with no statement, or an unknown status, fails.
- [AC0058.4] The same id in two files fails.
- [AC0058.5] A superseded requirement must name a replacement that exists, and its trail must not end in a withdrawn requirement.
- [AC0058.6] An accepted or active AC with no scenario fails, and an invariant without scenarios passes.
- [AC0058.7] A scenario line that is not an id and text, or whose id belongs to another requirement or is used twice, fails.

## Why

The folder gives the type, the file name gives the identity, and the first
non-empty line is the requirement. Lint keeps that structure readable by the
guard and by trace.

A supersession trail must end in a living requirement, or retirement would
quietly remove an obligation. Scenario ids are identity, never order, so a
removed id is never reused.
