---
status: active
---

`ktty path` prints the absolute folder Katatay is installed in, so a project can name the adapter files shipped with it.

## Scenarios

- [AC0002.1] ktty path prints an absolute folder that holds the TypeScript adapter.
- [AC0002.2] ktty path with an argument exits 2 and prints the correct invocation and help hint on stderr.

## Why

Projects use the TypeScript adapter, its test reporter and its mutation
wrapper, from the global install. A project's scripts and configs cannot know
where npm put the package, so they ask `ktty path` and build the file names
from its answer. The path is absolute so it means the same thing from any
working folder.
