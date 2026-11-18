---
status: active
---

`ktty version` names the Katatay release and the harness schema version, in any folder.

## Scenarios

- [AC0001.1] ktty version prints the release and the schema version on two lines, and exits 0.
- [AC0001.2] ktty version answers in a folder that is not a project.
- [AC0001.3] ktty version with an argument exits 2 and prints the correct invocation and help hint on stderr.

## Why

The release and the schema version change for different reasons. The release
moves with every package. The schema version moves only when a rulebook, event
or hook message changes shape in a way an older reader cannot follow. A
project's rulebook names the schema version, so the operator needs to see both
numbers apart to tell whether an installed `ktty` can read the project.

It answers outside a project because the first thing anyone runs after an
install is a version check, before any rulebook exists.
