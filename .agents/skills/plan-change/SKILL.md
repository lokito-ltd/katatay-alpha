---
name: plan-change
description: Produce a bounded change plan and present it for operator approval before implementing anything. Every change needs one — there are no waivers.
---

# Planning a change

The plan is a **working document for the approval conversation**. It is never
committed. What survives is the change file, written at the end.

The operator approves *behaviour and scope*. You decide implementation details
inside the approved scope without asking again.

## Presenting it

Do a cheap read-only reconnaissance pass first, so the plan predicts files from
what is in the repository rather than from the prompt.

Then write the plan to a file directly in the rulebook's plans folder and
present it to the operator. They approve it through the agent, and a hook
records the approval against the plan they approved, edits included. There is
nothing to type, and nothing you can record yourself. If they ask for changes,
revise and present again.

Plans change mid-change. When one changes materially, present the revision.
Approving it replaces the earlier approval. Reapproving identical content keeps the current phase and its evidence.

Work you spot in passing that is outside the plan goes into the follow-ups file
(the rulebook's `followUpsFile`), not into the change. That file can be written
in any phase.

## A change made only of tests

Decide this from the prompt, before you plan. A change that adds or reworks
tests and changes no implementation is a different shape, and the plan is where
you say so — in the `workflow` block that closes the plan file:

````markdown
```workflow
test-only: true
```
````

In that block and nowhere else, because a plan that *discusses* test-only changes
must not declare itself one. The operator approves that text, so the declaration
is theirs. The approval hook records it in the logbook, and the triage, the
turn-end hook and `workflow state show` read it from there.

Then the order changes, and only the order:

1. Run `workflow triage` **first**, before writing a line. The tree still
   matches the baseline, so the freeze has nothing to refuse.
2. It has to find the suite green. If a test fails, it records `triage_refused` with
   reason `suite_not_green`. Those failures belong to some other change, and once new
   tests land on top of them nobody can tell which failures the new tests found.
   Fix them as their own change.
3. Write the tests, converge, verify — all of it as usual.

The freeze does not move. A test written before the triage is blocked exactly as
it is for any other change, and step 1 is why a test-only change never needs it
lifted: at that point there is nothing to freeze.

Declare it only when it is true. Once triage records the implementation, only
tests may change. Restore implementation drift or present a revised plan and
triage its implementation with tests back at the baseline.

## The plan

Use these six sections once each, in this order and at heading level two. Replace every placeholder with content. Requirements and Predicted failures may say None. Exclusions are optional. At turn end, agent adapters should send `planFile` for a presented plan. This courtesy helps the operator see problems before approving; approval does not depend on it. Its messages never replace the freeze check, verification, mutation or recording. The rulebook's `plans.validateFormat` defaults to true. False skips template checks, but YAML and declaration checks still apply.

````markdown
## Why

<!-- The problem or need, and what prompted it. -->
{{WHY}}

## What

<!-- The new behaviour. Exclusions are optional, as prose or an Out of scope subsection. -->
{{WHAT}}

## How

<!-- The design and implementation approach. -->
{{HOW}}

## Requirements

<!-- Requirements to add, modify or retire, or None. -->
{{REQUIREMENTS}}

## Predicted failures

<!-- Which existing tests will fail and why, or None. Put predictions in the closing workflow block. -->
{{PREDICTED_FAILURES}}

## Test delta

<!-- The tests to add. -->
{{TEST_DELTA}}
````

### Why
The problem or need. What prompted this.

### What
The new behaviour that will exist. Exclusions are optional, as prose or an
**Out of scope** subsection; they help keep a change bounded.

### How
Design and architecture. What you considered and rejected, if the choice was
close.

### Requirements
Requirements you intend to **add, modify or remove**. Keep it small. This is
what the operator approves, and on approval it commits to the requirements as
`accepted`.

A change that adds a requirement, or modifies an existing one in any way,
also lists the result in the closing `workflow` block, so the operator's
approval reaches the guard:

```yaml
requirement-changes:
  - id: AC0004
    status: active
    statement: The statement exactly as it will read.
    scenarios:
      - '[AC0004.1] Every scenario exactly as it will read, in single quotes.'
```

Removing or rewording a scenario of an active AC needs the same approval as
rewording its statement. Adding one does not, but list it anyway: until the
operator types `record`, the entry also stands in for the change file, so
verify can pass before the change file exists. A change the plan does not list
needs its change file first. When the requirement has scenarios, the entry
lists all of them.

Renumbering an id the target already knows takes an entry under the new id,
with the old one as `renumberedFrom: AC0004`. See the requirements folder's
README.

Without it, the guard refuses the change everywhere but CI, so the change can
be neither verified nor committed. Write the statement exactly: the guard
compares it with the catalogue, and a different wording is not approved.

### Predicted failures
The existing tests you expect this change to **make fail**, in the closing
`workflow` block. Every test you leave out is expected to pass.

```yaml
predicted-failures:
  - AC0004.1                              # every acceptance test tagged with this scenario
  - tests/flows/checkout.test.ts          # every test in this file, as when it fails to load
  - tests/flows/checkout.test.ts::refuses an empty basket   # one test, by its name
```

A path is from the repository root. The name after `::` is the test's name as
the test report gives it; group names in front may be left out, and case and
punctuation are ignored. Quote an entry whose name holds a colon and a space,
such as `'tests/a.test.ts::runs nothing: not even once'`, or YAML reads it as a
key and a value and the approval refuses the plan. In the plan's text, say why
each one will fail.

### The closing block

Every declaration above goes in one block labelled `workflow`, the last thing
in the plan file, after the prose:

````markdown
## Test delta

The tests you intend to add.

```workflow
predicted-failures:
  - AC0004.1
```
````

The operator reads the plan to approve it, and the reasons come first. Only
that closing block declares anything. A `workflow` block anywhere else, or
`---` frontmatter at the top, is refused. When the plan shows an example of a
declaration, label it `yaml`, as above.

Think about every test that reaches the code you will change: the ones that
import it, and the ones that reach it only through another process, such as a
browser test talking to a server over HTTP, or a test that starts a hook as a
program of its own. The triage checks the list against the run:

- a failure you did not list is a **surprise**: you missed an effect;
- a test you listed that passed is an **over-prediction**: the change did not
  do what you thought. An entry that matches no test counts as one too.

Both raise the risk level, measured against how many tests you predicted. A
file entry predicts every test in the file, so when only some will fail, name
them one by one. List what you expect and no more: padding the list to hide
surprises shows as over-prediction.

The approval records the list. It cannot change afterwards without presenting
the plan again.

### Test delta
Tests you intend to **add**. The modified set is derived, not invented.

This is a prediction, not a commitment. The tests are frozen while the
implementation is written, and the triage that follows settles which tests
actually need writing. That usually includes tests no plan foresaw, which is the
reason the step exists. If a plan matched the triage exactly every time, the
triage would be telling you nothing.

## Rules that hold during implementation

- **The tests are frozen until the triage has run.** Write the implementation
  only. A turn that ends with any test file, or any test support file,
  differing from the baseline is blocked, and `workflow triage` refuses while
  one does. Fixtures and support code count, because they decide what a test
  proves as much as the test does. A test written next to the code it
  covers, before anyone has seen what broke, makes a green suite evidence of
  nothing.
- **Run `workflow triage` when the implementation is complete**, before fixing
  anything — or first of all, if the plan declared the change test-only. It runs
  the suite and sorts every failure into two buckets, the ones the plan
  predicted and the surprises, and lists the predicted tests that passed. Read
  the surprises first. They exist only until someone starts fixing, which is
  why the order is not negotiable.
- **Report the triage as it measured the plan.** Surprises first, then
  over-predictions. Look at each over-predicted test: either the change did not
  do what you thought, or the test does not test what it says. A predicted
  failure is still a failure, and gets fixed like any other.
- **Never weaken a requirement to make a test pass.** If a failure needs an
  implementation fix, present a revised plan for approval.
- **Deleting a tagged test requires its requirement to be modified or removed in
  the same delta.** If nobody agreed to change the requirement, nobody deletes
  its evidence.
- The requirements folder is yours to write, but never to delete from. A
  requirement leaves only by becoming `superseded` or `withdrawn`, and change
  files are append-only history.

## Finishing

Once the change is `verified`, tell the operator and report the evidence rather
than the intention. The risk numbers worth reporting are the triage's, recorded
while the failures still existed. `workflow req risk` re-runs the scoring by hand
if you want it, but by then the suite is green and it has little left to say.

The change is finished when the operator types `record`, not before. Then write
the change file in the requirements folder's `changes/`, named
`<UTC timestamp>__slug.md` — see `TEMPLATE.md` there. It opens with the
`## Report` section the record step gives you, word for word, and has a
`## Departures` section saying how the outcome differed from the plan, `None.`
when it did not. Its frontmatter records each requirement the change leaves
behind, stated in full: id, resulting status, resulting statement. Not the edit
that produced it, and no hand-copied checksum, because both are derived. Then
Why, What and How in prose. The turn-end hook runs `workflow req guard` on it
and records the change.

A change that adds or modifies a requirement needs no change file earlier,
as long as the plan lists the requirement under `requirement-changes:` as it
now reads. `workflow verify` runs the guard, and until `record` the guard takes
that entry in place of the change file. The record step runs the guard with
`--record`, and from then on only the change file accounts for the change.

## In Codex

Before asking the operator to switch to Plan mode, if the current checkout is not on a working branch based on the configured baseline, create and switch to a new branch from that baseline.

Presenting a plan:
- Codex has no plan tool the agent can call. The operator switches Codex into Plan mode (Shift+Tab in the CLI). If a change needs a plan and Codex is not in Plan mode, ask the operator to switch, and make no edits until then.
- In Plan mode, present the whole plan as one `<proposed_plan>` block with the plan's sections inside. Codex asks the operator "Implement this plan?": "Yes, implement this plan" sends `Implement the plan.`; "Yes, clear context and implement" starts a new thread with the plan in its first prompt; "No, stay in Plan mode" sends nothing, so revise and present again.
- At Stop, the adapter saves the completed Plan item from the current turn to its own file in the rulebook's plans folder and sends the path to the referee as a courtesy check, which may ask once for corrections. Capture problems and an unreadable or misplaced plan file are warnings; the referee still does the turn end's other work. A valid plan grants no approval, and approval does not depend on the check. An ordinary turn never checks an older plan. When the final message is exactly null and no Plan item is found, capture waits up to 1.5 seconds for it to reach disk, then warns that a plan may have gone unchecked.
- Short approval prompts select the latest completed Plan item in this chat, even after intervening discussion: `Implement the plan`, `Implement this plan`, `Approve the plan`, `Approve this plan`, `Yes, implement this plan`, `Yes`, `Approved`, `Go ahead`, `Proceed`, as the whole prompt. Case and surrounding punctuation or Markdown markers are ignored; internal punctuation and spacing are exact. Stop capture still selects only the current turn.
- A desktop approval message may start with the exact prefix `PLEASE IMPLEMENT THIS PLAN:`. The text after it is the approved plan, takes precedence over the transcript, and needs no turn ID. When it is absent or blank, the latest completed Plan item in this chat is the fallback. A newer empty or malformed Plan never selects an older one. The clear-context handoff uses the plan in its first prompt.
- Reapproving identical content preserves the current phase and its evidence: the referee reports the plan is already approved. Only changed content starts a revision and freezes the tests again.
- The prompt hook saves the approved text and asks the referee to record it. Approval parses the declarations without rerunning template validation or needing a validation receipt. A plan the operator does not approve records nothing. You cannot approve a plan yourself: only a prompt from the operator does.
