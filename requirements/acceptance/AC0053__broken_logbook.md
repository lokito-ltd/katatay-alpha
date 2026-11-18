---
status: active
---

A logbook that does not link up, or that git shows was changed, puts the change in phase `broken`, and nothing new can be recorded until it is restored.

## Scenarios

- [AC0053.1] An event rewritten without updating the event after it makes the phase broken.
- [AC0053.2] An event removed from the middle of the logbook makes the phase broken.
- [AC0053.3] A committed last event edited in the working tree makes the phase broken, even though the chain still links.
- [AC0053.4] An event file with the wrong sequence, truncated JSON, a missing required field or a name that does not match its type makes both state commands exit 1 and name the file.
- [AC0053.5] An event with a missing or unsupported version breaks the logbook, and its bytes are left as they were.
- [AC0053.6] No approval, record or reset is recorded into a broken logbook.

## Why

The logbook is the only record of what the operator approved and what was
verified, so a forged event could grant work nobody approved.

The hash chain catches a rewrite that was not carried forward. It cannot catch
an edit to the last event or a recomputed chain, because the hash is not a
secret. Git is the second witness for those, which is why the logbook is
committed.

Restoring the files from git is preferred over rebuilding them. Rebuilt files
only give a logbook that agrees with itself.

The writer rejects unknown fields to catch typos. A reader ignores unknown fields so that retiring a field does not invalidate committed history. The hash covers the original bytes, including fields the current reader ignores.
