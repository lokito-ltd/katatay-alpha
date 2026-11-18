---
status: active
---

`ktty req guard` fails a new requirement, or any change to a requirement the target holds, unless it is both approved and accounted for.

## Scenarios

- [AC0059.1] A new requirement fails without approval, and passes when the approved plan's requirement-changes states it exactly.
- [AC0059.2] Deleting a requirement fails, in CI too.
- [AC0059.3] Rewording, retiring, moving the status backwards, or removing or rewording a scenario of an active requirement fails without approval.
- [AC0059.4] A rewording that the approved plan's requirement-changes states exactly passes outside CI.
- [AC0059.5] A wording different from what the plan approved fails.
- [AC0059.6] An approval carried in another logbook on the branch approves a change but never accounts for it.
- [AC0059.7] A promotion to active, or an added scenario, passes only once a change file records it.

## Why

Retirement is the strongest way to weaken a requirement. It leaves the text
untouched, so it is gated as tightly as rewording. Superseding a strong
requirement with a weak new one is a two-step route around the gate, and both
steps need a person. So a new requirement is approved as it reads, and the
operator sees the wording that will replace the old one.

Adding obligation, such as accepted to active or a new scenario, needs no
approval but is still recorded. Approval is a fingerprint match, so editing the
statement again needs approving again.
