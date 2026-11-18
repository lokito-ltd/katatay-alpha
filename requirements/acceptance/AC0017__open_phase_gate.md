---
status: active
---

In `open`, a write inside the repository is denied unless it is a Markdown file directly in the plans folder or the follow-ups file.

## Scenarios

- [AC0017.1] Editing a source file before approval is denied as needing a plan, and the reason gives the plan format.
- [AC0017.2] A Markdown file directly in the plans folder, and the follow-ups file, may be written before approval.
- [AC0017.3] A file in a subfolder of the plans folder, or a non-Markdown file there, is denied.
- [AC0017.4] The denial names the follow-ups file the rulebook keeps.
- [AC0017.5] A file outside the repository that no lock covers may be written before approval.
- [AC0017.6] A shell command is never held for a plan, and an unapproved change made through it is reported at turn end.
- [AC0017.7] Writing a plan or a follow-up keeps a verified receipt standing.

## Why

Plan mode writes the plan before it asks for approval. Blocking that write once
left the approval dialog empty on every open branch.

Memory notes and other agents' scratch space live outside the repository, so
they stay writable. Shell commands are not gated by phase, because that would
need a second reading of the shell. An unapproved shell edit is caught at turn
end instead.

Plan files and the follow-ups file are left out of the tree fingerprint,
because revising a plan or parking a follow-up is not an edit to the change.

A file outside the repository needs no plan because writing it changes no code
in the repository and grants no permission. Denying it cost Claude's memory
notes every time the phase was `open`, which is most of the time a note is
worth taking. Those notes come back as context in a later session, so they
matter, but they are not a way around the gate. The files outside the
repository that could be, such as an agent's user settings where a hook could
answer the plan dialog, are what `agent.lockedPaths` is for.

The plans folder and the follow-ups file are named in the rulebook, and the
referee owns their exemption, not the agent adapter. A plans folder the agent
could set, as Claude Code's `plansDirectory` once was, can be pointed at the
repository root and make every file there writable before approval. The
rulebook is the operator's, and it refuses a plans folder at the root or under
a lock. Only files directly in the plans folder are exempt, so a plans folder
above the repository exempts nothing inside it.
