---
status: active
---

The phase is worked out from the live events in `.katatay/state/<branch>/` and the current tree, never from what the session says.

## Scenarios

- [AC0016.1] With no live plan approval, the phase is open.
- [AC0016.2] An approval with no triage after it is implementing.
- [AC0016.3] A triage with no passing verification of this exact tree is converging.
- [AC0016.4] A verified event for this tree, rulebook and baseline is verified, and a change file alone is not.
- [AC0016.5] A declared event stays declared until the guard passes on the exact change files, which makes it recorded.
- [AC0016.6] Any edit outside the change files after verification returns the phase to converging.
- [AC0016.7] Typed words other than record and reset grant nothing.

## Why

Every transition is made by the operator or by a hook running something
itself. None of it is the session saying it did.

A receipt counts only for the exact tree it describes, so no receipt outlives
the code it measured. A change file written before the operator's `record`
does not skip that step, because the agent does not get to declare its own
work done. Git wins: a `recorded` event cannot stand in for a change file git
does not have.
