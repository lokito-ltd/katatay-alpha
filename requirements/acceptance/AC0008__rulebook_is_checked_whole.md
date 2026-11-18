---
status: active
---

Katatay checks the whole of `.katatay/rulebook.json` every time it reads it, and refuses to act on an invalid one, naming what is wrong.

## Scenarios

- [AC0008.1] A missing rulebook is refused, and the refusal shows the file it starts as.
- [AC0008.2] A rulebook that is not JSON, or not a JSON object, is refused.
- [AC0008.3] An unknown key is refused, naming its full path and the keys allowed there.
- [AC0008.4] One invalid section refuses every command, not only the one that reads that section.
- [AC0008.5] A plans folder at the repository root, or overlapping .katatay/, .git/, an agent lock or the requirements folder, is refused.
- [AC0008.6] While the rulebook is refused, ktty state show exits 1, the turn end blocks, and no approval is recorded.
- [AC0008.7] While the rulebook is refused, every write is denied except the default follow-ups file, including writes outside the repository.

## Why

The rulebook is the one file the operator writes to say how the project is held
to account. It sits under `.katatay/`, so no session can lower a floor,
shorten a list, or point a command at a stub that always passes.

The whole file is checked before any setting is used. A malformed `highRisk`
entry therefore also stops the test command, and every entry point gives the
same answer.

Four keys decide what may be written without a plan: `plans.dir`,
`followUpsFile`, `requirementsDir` and `agent.lockedPaths`. They are checked on
every read, because one wrong value would remove the write gate everywhere at
once. A plans folder above the repository is fine, because only the files
directly in it are exempt.

When the rulebook is refused, its locks are unknown too. A write outside the
repository is then denied as well, because it might be a file the rulebook
would have locked, such as the agent's user settings.

A plans folder at the repository root would exempt manifests and CI files from
the write gate and tree fingerprint. A plans folder or follow-ups file inside
the requirements folder would exempt catalogue edits. A lock takes priority
over an exemption, so an overlapping lock would make the exempt file
unwritable. Refusing these locations on read gives the operator the reason
before a plan or follow-up needs writing.
