---
status: active
---

`ktty init --questions` prints the setup questions as JSON, so an agent can fill in what it can and ask the operator for the rest.

## Scenarios

- [AC0006.1] Init with --questions prints each question with its id, and its default where it has one, and exits 0.
- [AC0006.2] Init with --questions writes nothing.
- [AC0006.3] Answers sent as one JSON object on stdin are used, and a question with a default may be left out.

## Why

An agent setting a project up can read most answers from the project itself.
It asks the operator only for the rest. A question already answered is not
asked again, and an answers file written before a later question existed still
reads, because the questions added later have defaults.

With no terminal, a required question left unanswered stops `init`, which
names each one and writes nothing.
