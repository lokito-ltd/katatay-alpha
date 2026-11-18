---
status: active
---

In `converging`, the turn-end hook runs verify itself and records the result as a `verified` or `verify_failed` event unless a plan revision is pending.

## Scenarios

- [AC0030.1] Nothing is verified while the implementation is still being written.
- [AC0030.2] A failing verify blocks the turn and records verify_failed.
- [AC0030.3] The hook writes the receipt itself, and the agent saying it verified counts for nothing.
- [AC0030.4] The next edit outside change files and the follow-ups file voids the receipt.
- [AC0030.5] A pass is not recorded when the tests change while verify runs.
- [AC0030.6] A rulebook edit during verify records a failure under the starting rulebook, and the next turn verifies again.
- [AC0030.7] verify_failed keeps the last 20 lines of verify's output, and the agent is shown the last 40.
- [AC0030.8] One revision request defers turn-end verification throughout the planning conversation.
- [AC0030.9] When the operator rejects the revision and chooses the original plan, work resumes from its existing phase.
- [AC0030.10] Approving a changed plan ends the revision request and returns the change to implementing.
- [AC0030.11] A revision request after recording tells the agent and operator to merge or reset first, even after an edit returns the change to converging.

## Why

A transcript line proves nothing, so the agent never reports that it verified
something. The receipt has to come from a hook the session cannot fake, so the
hook runs verify and writes the event.

The receipt is tied to the tree, the rulebook bytes and the baseline. A change
to any of the three sends the change back to `converging`, and so does a
rulebook edit that only acknowledges a hook.

The summary is built from the stored event and its snapshots, not from what
verify printed, so it always matches what its `Details:` link opens.
