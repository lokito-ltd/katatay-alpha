---
status: active
---

When the plan or the branch is wrong, approving the plan records nothing and says why.

## Scenarios

- [AC0013.1] A plan that opens with frontmatter is refused, saying its declarations go in a closing workflow block.
- [AC0013.2] A workflow block that is not last, a second workflow block, or one never closed is refused.
- [AC0013.3] A plan with no text besides its workflow block is refused.
- [AC0013.4] A plan approved on the target branch is refused, and no logbook folder is created.
- [AC0013.5] A second plan on a branch whose change is recorded is refused, the logbook is untouched, and the operator is told to merge or reset.
- [AC0013.6] A plan file that is missing, not Markdown, or not directly in the plans folder stops for the operator.
- [AC0013.7] A broken logbook, a branch with no commit, or no baseline to pin records nothing.

## Why

Frontmatter is refused rather than ignored, because reading it as "declares
nothing" would silently lose a `test-only` declaration.

A change made on the target has nothing to be measured from, and the target
never holds a live logbook, so nothing is appended there. A branch holds one
change until it merges or is reset. A fix to a recorded change needs no new
plan: an edit sends it back to `converging`.

The answer is `refused` when the plan or branch can be changed, and `stop` when
only the operator or the adapter's maintainer can fix it. No plan file means no
approval.

A presentation check cannot supply the bytes the operator approved. If the
adapter cannot hand them over in a readable plan file, the operator has to
resolve that handoff before the change can start.
