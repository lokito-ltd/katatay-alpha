---
status: active
---

The operator's `record` is accepted only on a verified tree whose tree, implementation and test fingerprints match the latest successful verify.

## Scenarios

- [AC0045.1] record before verification is refused, and the agent is told why.
- [AC0045.2] record on a broken logbook is refused, and nothing is recorded.
- [AC0045.3] Implementation drift from the latest verified receipt is named.
- [AC0045.4] A newer receipt that supersedes the one the report was built from requires another record.
- [AC0045.5] No declaration is made if the tests change while the report runs.
- [AC0045.6] With the analysis switch on, record before the analysis is submitted asks for it, and neither declares nor holds.

## Why

`record` declares that the measured work is the work. Test edits require
verification again, and returning to an older verified tree needs a fresh pass.
Only the operator types `record`, as the whole message, because only they may
say a change is finished.

The report takes time to build. A newer receipt can replace the one it used even when the tree matches. Checking the receipt again before declaration ties the operator’s decision to the verification they saw.
