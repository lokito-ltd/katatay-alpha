---
# The requirements this change leaves behind, each stated in full: id, resulting
# status, and the resulting statement. Not a description of the edit — an entry
# you can only understand by finding the previous version is not a record.
#
# The guard derives the transition (accepted → active), because it already holds
# both the target and the branch. It derives the fingerprint from the statement below,
# so the fingerprint cannot go stale.
#
# Omit this key entirely when the change touches no requirement.
#
# List every scenario the requirement has, in single quotes. YAML reads a line
# starting with `[` as a list, and inside double quotes it would turn `\r\n`
# into real line-break characters. Leave `scenarios` out when it has none.
requirements:
  - id: AC0009
    status: accepted
    statement: A customer can cancel an order until it ships.
    scenarios:
      - '[AC0009.1] A cancelled order is not shipped.'
  - id: INV0002
    status: withdrawn
    statement: An order's total never changes after it is paid.
---

# <short title>

## Report

```text
The summary lines of the change report, exactly as the record context gave
them. The record step checks them against what the operator declared on.
```

## Why

The problem or need. What prompted this, and what the intended outcome is.

## What

The behaviour this change leaves behind, and what was deliberately left out of
scope. The requirement record itself is the frontmatter above. This section is
for the part a person needs in prose.

## Departures

How the outcome differed from the plan the operator approved. The plan is never
committed, so this is the only place a reviewer can learn that something was
done differently from what was agreed. Write `None.` when nothing departed —
that is the expected answer, and `req:guard` refuses a change file that leaves
this section out or empty.

It checks that you were asked, not that you answered fully. Nothing can verify a
departure list against a plan that is not in the repository.

## How

Design and architecture decisions worth remembering: what was chosen, what was
rejected, and why. Be concise and pick only a handful of the most important
decisions. This is not an implementation diary — the diff already records what
was typed.

**One short paragraph per decision.** A subsection that needs three paragraphs
is almost always describing the code rather than the reasoning behind it.
Rejected alternatives and honest limits earn their space. Restating what a
function does never does. If nothing was weighed, it does not need recording at
all.
