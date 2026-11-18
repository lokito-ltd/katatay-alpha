# Requirements

Two kinds of requirement live here, and one record of how they got here.

- **`acceptance/`**: acceptance criteria (`AC0001`). Behaviour a person using
  the product would recognise. Proved by tests.
- **`invariants/`**: invariants (`INV0001`). Properties of valid system state
  that must never be false, however the state was reached. Enforced all the
  time, like a database constraint, rather than sampled by a test.
- **`changes/`**: the permanent record of every change to the two above.

## Format

The folder gives the type. The file name gives identity. The first non-empty
line of the body **is** the requirement.

```
acceptance/AC0001__order_can_be_cancelled.md
```

```markdown
---
status: accepted
---

A customer can cancel an order until it ships.

## Scenarios

- [AC0001.1] A cancelled order is not shipped.
- [AC0001.2] An order that has shipped cannot be cancelled.

## Why

Prose: why this matters, worked examples, edge cases. This part is
explanation, not the requirement, and may be improved freely.
```

The statement and the scenarios are the requirement. The prose under `## Why`
is not fingerprinted, and rewording it never needs approval.

### Scenarios

A scenario is one case the AC promises, stated in one line, with an id of its
own: `AC0001.2`. Every `accepted` or `active` AC has at least one. Scenario ids
work like requirement ids: they are identity, never order. When a scenario is
removed, the others keep their numbers, and the id is never reused.

The scenarios are the list its tests are held to. Each is proved by tests
whose name is the scenario's text, word for word, tagged with its id (see
*Tagging tests* below). So a test file says what it proves without anyone
reading a test body, and the AC and its tests cannot drift apart without
`workflow req trace` saying so.

Each scenario is fingerprinted on its own, apart from the statement. On an
`active` AC:

- **Adding** a scenario adds obligation, so it needs no approval, like
  `accepted → active`.
- **Removing or rewording** one takes a promise away, so it needs approval,
  like rewording the statement.

Every scenario change is recorded in a change file either way.

Invariants may have scenarios but need none.

### Frontmatter

| Field | Required | Meaning |
|---|---|---|
| `status` | yes | see below |
| `supersededBy` | only when `superseded` | the requirement that replaced this one |
| `source` | no | a **durable external** reference only: a regulation, an incident number, a contract. Something that records *why this may not be weakened*. Not a link to an internal document, which can be deleted. |

### Status

| Status | Meaning |
|---|---|
| `accepted` | agreed, not yet built. No test evidence required. |
| `active` | built. Evidence is enforced; rewording needs approval. |
| `superseded` | replaced. Kept forever, with `supersededBy`. |
| `withdrawn` | no longer wanted. Kept forever. |

A requirement is **never deleted**. Moving to `superseded` or `withdrawn` is the
only exit, so an obsolete requirement stays visible along with the reasoning
that retired it.

### Transitions

| From → To | Approval? |
|---|---|
| `accepted` → `active` | no: the only transition that *adds* obligation |
| `active` → `accepted` | **yes**: un-builds an evidenced requirement |
| any → `superseded` / `withdrawn` | **yes**: retirement |
| `superseded` / `withdrawn` → any | **yes**: bringing it back |

**Retirement is the strongest way to weaken a requirement**, so it is gated as
tightly as rewording. It removes the obligation completely and leaves the
statement untouched, so nothing about the text looks suspicious. It can also
be reached indirectly: someone could write a weak new requirement and point
the strong one at it with `supersededBy`. Both halves of that route need a
person, so a new requirement needs approval as it reads, the same as a
rewording.

### Approving

The plan the operator approves carries the approval. The plan lists each
change in the `workflow` block that closes it, as the requirement will read
afterwards, in the same shape as a change file's entry:

```yaml
requirement-changes:
  - id: AC0004
    status: active
    statement: The statement as it will read.
    scenarios:
      - '[AC0004.1] Every scenario, as it will read.'
```

Approving the plan records the list in the workflow's logbook.
`workflow req guard` then accepts a change that needed approval when the
branch's requirement has exactly that status, statement and set of scenarios.
Edit the statement again and it needs approving again.

Until the operator types `record`, the same entry also accounts for the
change, standing in for its change file. That lets the change file be written
once the outcome is known. So list every requirement the change adds or
modifies, an added scenario included, even though an added scenario needs no
approval. The record step runs the guard with `--record`, and then only a
change file accounts for a change.

A branch that gathers several changes before they reach the target carries
their approvals too. Each change's logbook travels with the branch, so the
guard also reads the plan approval in every other logbook under
`.katatay/state/`. A carried-in approval approves a change and never accounts
for it. The change it came from must have its own change file, so a change
that was approved and never written up still fails.

A renumber of an id the target knows is approved the same way. The entry
states the requirement under its new id, scenarios included, and names the
old id as `renumberedFrom`:

```yaml
requirement-changes:
  - id: AC0021
    renumberedFrom: AC0009
    status: active
    statement: The statement as it will read.
    scenarios:
      - '[AC0021.1] Every scenario, under the new id.'
```

An entry with only the new id does not cover a renumber, because it has not
said what it moves. Once the plan is approved, `workflow req renumber AC0009
AC0021` does the work. A renumber also needs a change file recording the
requirement under its new id.

CI does not read the logbook, because a branch can write to it. In CI the
guard prints each change that needed approval for the reviewer and does not
fail on it. A deletion, a change no change file accounts for, or a change file
that misdescribes the catalogue still fails CI, because no approval could
permit them.

## Recording a change

Every change to a requirement the target already holds, whether to its
statement, its scenarios **or** its status, must be recorded in the
frontmatter of a change file on the branch:

```yaml
---
requirements:
  - id: AC0001
    status: active
    statement: A customer can cancel an order until it ships.
    scenarios:
      - '[AC0001.1] A cancelled order is not shipped.'
      - '[AC0001.2] An order that has shipped cannot be cancelled.'
---
```

Each entry states the requirement **as it now stands**, in full, every
scenario included. Put each scenario in single quotes. YAML reads a line
starting with `[` as a list, and inside double quotes it would turn `\r\n`
into real line-break characters. Do not write "promoted" or "reworded for
clarity": neither can be understood without finding the previous version.
The guard derives the transition, because it holds both the target and the
branch. It derives the fingerprint from the statement, so the fingerprint
cannot go stale.

The guard checks two things. First, that every changed requirement is recorded
somewhere: a retirement changes no checksum, so without this check it would
leave no trace. Second, that the record matches the branch. A change file
claiming a status or a statement the catalogue does not carry is
**forbidden**, with no approval available, because a record that misdescribes
its own change reads as evidence while being false.

When more than one change file on the branch records the same requirement,
only the newest must match the catalogue. Newest means latest by file name,
which is latest in time (see *Naming a change file*).

Prose is never read. A cross-reference in a paragraph, such as "protects
AC0001", records nothing.

### Departures from the plan

Every change file has a `## Departures` section, and the guard refuses one
that leaves it out or leaves it empty. `None.` is a valid answer and the usual
one.

The plan is never committed, so after the merge the change file is the only
place a reviewer can learn that something was done differently from what was
approved. The check is presence, not truth: nothing can check a departure list
against a plan that is not in the repository. What it buys is that a reviewer
reading `None.` knows the question was asked.

### The report at the top

A change file opens with a `## Report` section, straight after its title and
before `## Why`. It holds the summary lines of the change report the operator
read when they typed `record`, in a text block, word for word. The `declared`
event keeps those lines, and the record step refuses the newest change file
when its section is missing, not first, or differs from them. The agent writes
the file and the harness measured the lines, so they are compared rather than
trusted.

### Naming a change file

```
changes/20260908T161131.089Z__order_cancellation.md
```

A UTC timestamp to the millisecond, then the slug. Not a sequence number. A
number chosen when a branch starts predicts the merge order, and it is wrong
exactly when two branches are open at once. Two branches choosing `0003__a.md`
and `0003__b.md` also merge cleanly and leave a silent duplicate. Git already
knows the real order.

`changes/TEMPLATE.md` is the shape to copy.

## Identity

Ids are identity, never order. `AC0003` is not applied after `AC0002`. Order
exists only in `changes/`, where it is real.

Requirements are committed on a branch when a plan is approved, so two branches
can choose the same id. Renumbering an id that never reached the target
moves nothing agreed (`workflow req renumber AC0009 AC0021`), but the
requirement is still new, so the plan's entry for it has to name the new id.
That takes a revised plan. Renumbering one that the target
already knows changes the identity of something agreed, and needs approval
(see *Approving* above).

## Tagging tests

A test names the scenario it proves. Its name is the scenario's text, word for
word, followed by the scenario's id, for example:

```
A cancelled order is not shipped. [AC0001.1]
```

Where a test's name cannot hold that text, the tag goes in a comment directly
above the test, in the form the rulebook's tag comment pattern gives.

`workflow req trace` holds the two lists together:

- every scenario of an `active` AC has a covering acceptance test;
- only a test that runs and can fail counts. A skipped test, one skipped on a
  condition, one expected to fail and one in a file the test runner never
  collects are not evidence, though their names and tags are still checked;
- every scenario tag in an acceptance file names a scenario that exists;
- a test's name, with its tag taken out, is its scenario's text, compared by
  words: case, whitespace and punctuation are ignored;
- a test names one scenario, because one name cannot match two texts;
- an AC is never tagged bare, as `[AC0001]`. Tag the scenario, so it is clear
  what the test proves. Invariants may still be tagged bare.

Several acceptance tests may prove the same scenario. Tags in files that are
not acceptance files are ignored.

## Commands

```
workflow req lint                     # structure, ids, statuses, supersession trails
workflow req guard                    # nothing protected changed without approval
workflow req trace                    # every active scenario has acceptance evidence
workflow req renumber AC0009 AC0021   # settle an id collision on a branch
```
