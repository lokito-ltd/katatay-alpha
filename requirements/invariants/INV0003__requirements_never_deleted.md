---
status: active
---

A requirement is never deleted; it leaves the catalogue only as `superseded` or `withdrawn`.

## Scenarios

- [INV0003.1] Deleting a file under the requirements folder, or the folder itself, is denied, while writing there is allowed.
- [INV0003.2] A shell rm, rmdir, mv, git rm or git mv under the requirements folder is denied.
- [INV0003.3] A Codex patch that moves a requirement away is denied.
- [INV0003.4] The guard fails a deleted requirement in CI too, and no plan accounts for it.
- [INV0003.5] Renaming only the slug is not a deletion.

## Why

An obsolete requirement stays visible together with the reasoning that retired
it. Deletion is the one change no approval can permit.

Writing requirements is the honest path, and blocking it once made approved
changes impossible to apply. Deleting them is never right.
