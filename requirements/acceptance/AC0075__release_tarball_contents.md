---
status: active
---

The release tarball holds what a project runs from the install, and nothing of Katatay's own development.

## Scenarios

- [AC0075.1] The tarball holds the programs, the agent instructions, the skills, the schemas and the TypeScript adapter.
- [AC0075.2] The tarball holds no tests, fixtures or machine harness.
- [AC0075.3] The tarball bundles neither TypeScript nor Stryker.
- [AC0075.4] The TypeScript adapter's JUnit reporter runs from the install with the project's own TypeScript.
- [AC0075.5] The TypeScript adapter's mutation program runs from the install with the project's own Stryker.

## Why

A project runs Katatay's programs, installs its agent instructions and skills,
and checks its rulebook against the schemas, all from the installed package.
Each of them missing from the tarball breaks a project only once it is
installed, which no test inside the checkout sees.

Katatay's own tests, fixtures and machine harness are for developing Katatay.
Shipped, they would only make the package larger and give a project files
that look like part of the harness and are not.

The TypeScript adapter drives the TypeScript compiler and Stryker, but the
versions are the project's choice. Bundling them would run a project's tests
with tools it never chose, and fix their versions to Katatay's release. So the
adapter ships without them and loads the project's own, from the folder the
project runs in.
