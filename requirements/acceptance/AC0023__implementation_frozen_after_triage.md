---
status: active
---

After triage, the implementation must stay at the fingerprint the `triaged` event recorded, until a revised plan is approved.

## Scenarios

- [AC0023.1] After triage, editing an implementation file is denied as frozen, and the agent is told to present a revised plan.
- [AC0023.2] After triage, tests, change files and git-ignored files may be written.
- [AC0023.3] An implementation changed by other means makes ktty state show say to restore it, and the turn end and record refuse.
- [AC0023.4] ktty triage on a changed implementation refuses with implementation_changed, without running the suite.
- [AC0023.5] Restoring the triaged bytes lets the change verify again.
- [AC0023.6] A revised plan lifts the implementation freeze, and its triage records a new fingerprint.
- [AC0023.7] A test-only change's implementation is frozen at its triage too.

## Why

A triage belongs to the plan it follows. If the implementation changed
afterwards, the triage would report on code nobody measured. An implementation
fix therefore needs a revised plan, which sends the change back to
`implementing` so the new work is triaged.
