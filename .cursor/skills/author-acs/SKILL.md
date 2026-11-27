---
name: author-acs
description: Write or revise acceptance criteria and invariants in the requirements folder. Use when a change adds, modifies, supersedes or withdraws a requirement, or when deciding whether something belongs in the catalogue at all.
---

# Authoring requirements

## Which is it?

- **Acceptance criterion** (`AC`) — behaviour a human operator would recognise.
  Verified by tests.
- **Invariant** (`INV`) — a property of valid state that must never be false,
  however that state was reached. Enforced continuously, like a database
  constraint. Several ACs may exist to protect one invariant.

## Does it belong here?

> Would we care about preserving this after a substantial internal refactor?

Yes → candidate. No → it is an implementation detail, and a test is enough.

Good: *"A user can reject an AI proposal without it entering canonical data."*
Bad: *"The reject button calls `rejectProposal()`."* That survives no refactor,
and it documents nothing an operator cares about.

State behaviour, not mechanism. Use domain language, not internals. The
project's own instructions may say more about what a requirement must not
name.

## Writing one

The filename carries the identity. The first non-empty line of the body carries
the requirement. The scenarios under it say which cases it promises. The prose
under `## Why` is explanation and can be improved freely, because only the
statement and the scenarios are fingerprinted.

```markdown
---
status: accepted
---

A user can reject an AI proposal without it entering canonical data.

## Scenarios

- [AC0001.1] A rejected proposal is not in the catalogue.
- [AC0001.2] A rejected proposal does not come back as unresolved on a later pass.

## Why

Rejection is a first-class outcome, not merely the absence of acceptance.
```

## Writing scenarios

Every AC that is `accepted` or `active` has at least one scenario. Each one
becomes the title of the tests that prove it, word for word, so write them as
the list a reader should see when they open the test file:

- **One case per line.** If a scenario needs "and" to join two outcomes that
  could fail separately, it is two scenarios.
- **Say what is observed, in domain words.** "A source one character over the
  limit is refused, and nothing is kept." Not "`addText` returns undefined".
- **Name the edge cases the prose argues for.** If the `## Why` section says
  "Kraków" counts as 6, a scenario should promise it, or nothing tests it.
- **Every behaviour the tests prove is a scenario.** A test with no scenario
  proves something nobody agreed to. Either the AC is missing a scenario, or
  the test does not belong to it.
- **Ids are identity.** Number new scenarios after the highest id the AC has
  ever used. Never renumber, and never reuse a removed id.

Adding a scenario to an active AC is free. Removing or rewording one needs the
operator's approval, the same as rewording the statement.

Write the statement so it can be *falsified*. "The system is reliable" cannot be
tested. "A rejected proposal does not reappear as unresolved on a later pass"
can.

## Lifecycle

`accepted` → agreed, unbuilt, no evidence required.
`active` → built; evidence enforced, and rewording needs operator approval.
`superseded` → replaced; set `supersededBy`.
`withdrawn` → no longer wanted.

**Never delete a requirement.** Superseding and withdrawing keep the reasoning
visible. Deleting erases the fact that anyone ever cared.

An AC reaches `active` only when every scenario has at least one covering test
in a file selected by `tests.paths.acceptance`.

## Preferring silence to invention

When evidence is weak, the catalogue should say so rather than assert something
convenient. Prefer verified over a high-confidence proposal, that over stated
uncertainty, and that over leaving it out. All of them beat fabricated
certainty.
