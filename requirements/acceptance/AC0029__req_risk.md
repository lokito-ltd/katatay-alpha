---
status: active
---

`ktty req risk` runs the suite against the approved predictions, prints the same report as triage, appends no event, and exits 1 unless the level is LOW.

## Scenarios

- [AC0029.1] With a plan that predicted the one failing test, it reports it as predicted and exits 0.
- [AC0029.2] With no approved plan, every failure is a surprise and it exits 1.
- [AC0029.3] At MEDIUM or HIGH it exits 1 and says the operator needs to look.
- [AC0029.4] A broken logbook is refused before any test runs.
- [AC0029.5] Unreadable approved-plan evidence is refused before any test runs.
- [AC0029.6] It prints triage's report without the event link or the notes for the agent.

## Why

It measures against the approved plan's predictions the same way triage does,
so the two reports agree. A level above LOW needs the operator to look, and no
approval clears it.
