---
status: active
---

The rulebook's `version` must equal the harness schema version that `ktty version` prints.

## Scenarios

- [AC0009.1] A rulebook without a version is refused, saying it must state the version.
- [AC0009.2] A rulebook at a version Katatay does not read is refused, naming the version it reads.
- [AC0009.3] A version given as a string, a fraction or null is refused.

## Why

A newer harness may add a key that is a safety setting. Reading the file
without knowing that key would be the generous guess, so any other version is
refused.

The version must be written out. Guessing the shape from missing keys would
report "no target" and send the operator to the wrong place.

The number is raised only for a breaking schema change, such as removing or
renaming a field.
