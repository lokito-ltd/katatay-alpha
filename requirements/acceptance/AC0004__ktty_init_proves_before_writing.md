---
status: active
---

`ktty init` sets a project up only after every command in its drafted rulebook has passed, and otherwise writes nothing.

## Scenarios

- [AC0004.1] Init in a repository whose commands pass writes the rulebook, the requirements folder and both agents' files, and exits 0.
- [AC0004.2] A project init has set up, committed and pushed is in phase open, and the Claude adapter's check finds no workflow hook missing.
- [AC0004.3] A second init on a project it set up changes nothing.
- [AC0004.4] Init writes nothing when the test command leaves a test file out of its report.
- [AC0004.5] Init writes nothing when no test passed.
- [AC0004.6] Init writes nothing in a folder that is not a git repository, and says to run git init.
- [AC0004.7] Init writes nothing when a required question has no answer, and names each question.

## Why

`init` used to check only the shape of the answers and run nothing. A test
command that left half the test files out of its report was then found at the
first triage, after the project was guarded and its rulebook locked. So `init`
now runs every command the rulebook will hold, in verify's order, and reads
what they produce the way verify reads it. It stops at the first item that does
not pass, and then writes nothing and says why.

There is no "not proved" result and no way to skip the probe. A project with no
test, or with a red suite, gets a passing test before it is set up, so the
first change starts from commands known to work.

Writing the rulebook first and deleting it on a failure was rejected: a run
killed halfway would leave a rulebook nobody proved, and `init` never
overwrites one. An environment variable naming another rulebook was rejected
because any session could set it.

The probe needs a git repository because it tells the project's files from
ignored output by asking git.

Nothing is overwritten, so running `init` twice changes nothing.
