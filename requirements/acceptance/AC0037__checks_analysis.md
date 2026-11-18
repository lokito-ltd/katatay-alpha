---
status: active
---

`ktty checks-analysis <seq>` records the agent's analysis of the current verification, and `record` waits for it while `checks.requireAnalysis` is on.

## Scenarios

- [AC0037.1] A missing, zero or non-numeric sequence, or an extra argument, exits 2, prints the correct invocation and help hint on stderr, and records nothing.
- [AC0037.2] An accepted analysis prints only its summary on stdout, and a rejection goes to stderr with exit 1.
- [AC0037.3] An analysis is refused, and nothing is written, for a receipt that is not current, outside verified, while the switch is off, or on a broken logbook.
- [AC0037.4] Evidence the verification names that is missing or invalid is named both at checks-analysis and at record.
- [AC0037.5] checks.requireAnalysis false turns off the snapshot, the request and the record prerequisite together.

## Why

The analysis makes the agent read the verification's findings before the
operator is asked to record: what the tests assert, which code they repaired,
and what remains unproved. A new receipt needs a new analysis.

The logbook is committed and read on every turn, so the `checks_analysis` event
keeps a summary cut to 2,000 code points, plus a digest-checked snapshot of the
full text with the evidence list the referee appended. The analysis does not
feed the change report, so a lost analysis snapshot does not stop `record`.
