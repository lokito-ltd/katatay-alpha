---
status: active
---

The same "Must look" list appears when verification passes and in `ktty state show` after triage, and `ktty areas --staged` takes it from the staged content only.

## Scenarios

- [AC0065.1] The list appears when verification passes and again on the next verified turn.
- [AC0065.2] ktty state show shows the list once a triage is recorded, and not before.
- [AC0065.3] With --staged a file is listed only once it is staged.
- [AC0065.4] With --staged a comment that is only on disk and not staged is not listed.
- [AC0065.5] Every printed line fits a commit body of 72 columns.

## Why

The commit message carries the list under `Review:`, from `ktty areas
--staged`. A commit message must never name a file the commit does not hold, so
`--staged` reads the index. Without it, the list is measured against the
baseline.
