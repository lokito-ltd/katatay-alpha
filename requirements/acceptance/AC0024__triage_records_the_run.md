---
status: active
---

`ktty triage` runs the whole suite once, sorts what broke, appends a `triaged` event and exits 0, whatever the risk level.

## Scenarios

- [AC0024.1] A successful triage appends triaged with the tree and implementation fingerprints, the level, its reasons, the counts and the snapshot evidence.
- [AC0024.2] A triage that finds HIGH risk still exits 0.
- [AC0024.3] The output starts with what the level measures, then the level, the counts, the named lists and the event link, then notes for the agent.
- [AC0024.4] A triage of a tree with no implementation records that and says so in its title.
- [AC0024.5] After triage the phase is converging and tests may be edited.
- [AC0024.6] The next turn end puts the triage report in front of the operator, ending at its Details link.
- [AC0024.7] ktty state show shows the risk level and its reasons.
- [AC0024.8] The report names each failing invariant test and each predicted test file that never ran, each in a list of its own.

## Why

The workflow is built around this step. A suite run only at the end, after it
has been driven green, reports on a suite that was fixed before anyone looked
at it. The surprises exist only until fixing starts.

Triage is recorded even when the tree has no implementation. That is normal for
a test-only change and a warning sign for any other.

Triage is a shell command the agent runs, like `state show`, `report` and the
requirement checks, not a hook moment. The agent decides when the
implementation is complete; the command checks that the change can be measured
and refuses when it cannot.
