---
status: active
---

The first `record` holds with `record_held` when the report finds gaps nobody acted on, and a second `record` on the same tree declares.

## Scenarios

- [AC0046.1] A report with no gaps declares at once.
- [AC0046.2] A change whose gaps nobody acted on is held, and the hold points back to verify.
- [AC0046.3] A second record on the same tree declares and keeps the accepted gaps.
- [AC0046.4] A test edit and a new pass after the gaps count as acting on them, so the first record declares.
- [AC0046.5] Unproved mutants alone hold the first record, with the same counts when accepted.
- [AC0046.6] A report with missing or unreadable required evidence stops every record, after a hold too.
- [AC0046.7] record on a declared or recorded tree adds no event and repeats the handoff.

## Why

This is the operator's rule from 2026-10-22. No gaps, or the agent acted on the
advice, means declare. Gaps nobody acted on mean hold, and the second `record`
is the operator accepting them knowingly.

A complete report is required, because only a complete report can tell the
operator which measured gaps they are accepting. Absence is never a zero.

Repeating the handoff without a new event fixes a 2026-11-04 incident: a second
`record` added another `declared` event and did not bring the report back.

The committed hold preserves the reason even if the local report is lost. A measured zero records a check that ran. An absent count means the check was unmeasured. The mutation count includes confirmed survivors and unproved mutants, including code reached only by slow tests. Ignored mutants, compile errors and crashes contribute nothing to that count.

Only the two latest successful verifications under the approval can show that tests changed after the advice. A failed run cannot establish that the revised tests passed. Repeating a hold while evidence is unreadable would let a second `record` accept gaps whose size nobody knows.
