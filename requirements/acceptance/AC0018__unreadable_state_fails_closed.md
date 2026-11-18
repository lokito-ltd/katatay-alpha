---
status: active
---

When Katatay cannot read the state, it denies every write inside the repository except files directly in the plans folder and the follow-ups file, and it never blocks reading or the shell.

## Scenarios

- [AC0018.1] A broken logbook denies every write in the repository, but not shell commands.
- [AC0018.2] A file where the logbook folder should be reads as a broken logbook and denies edits.
- [AC0018.3] A folder where an event file should be denies every editing tool and names the file.
- [AC0018.4] A branch with no commit yet is open, says why, and cannot be approved into.
- [AC0018.5] Plan files and the follow-ups file stay writable in each of these cases.
- [AC0018.6] Reading a file is never blocked.
- [AC0018.7] A denial caused by unreadable state is a stop for the operator.

## Why

The gate used to allow a write whenever reading the state failed, so that a
crashed hook would not block ordinary work. Two ordinary states made the read
fail, an unborn branch and a logbook path that was a file, and each let an
unapproved edit through. An earlier version also crashed on `ENOTDIR`, and the
gate let the edit through. A state that cannot be read is not known to be
approved, and silence is never read as a pass.

Plan files and the follow-ups file stay writable so the agent is never stuck
with nothing it can write. Reading and the shell stay open, because that is how
anyone finds out what broke.
