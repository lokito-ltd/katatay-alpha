# The workflow

Use the project's instructions to start `workflow`. Follow the agent-specific section below for plan approval and reporting.

## How a change runs

1. Inspect the change read-only. Present the plan and predictions for the operator's approval.
2. Read the snapshot named by `plan_approved`. In `implementing`, write the implementation while tests and support files stay frozen. For a test-only change, run triage first.
3. Run `workflow triage` in its own call before fixing failures. After `triaged`, edit tests. An implementation fix needs a revised plan.
4. End the turn for verification. Report the referee's result. After a pass, wait for the operator to type `record`.
5. On declaration, write the change file. At turn end the hook proves the baseline on the server, runs the guard and stages the recorded change. Present the commit message. Only the operator approves the commit and merges.

## Commands

`workflow` followed by the command. The project's instructions say how `workflow` is started there.

- `workflow version`: print the harness schema version, including outside a project.
- `workflow verify`: every check CI's verify jobs run: requirements, logbook, the compiler and test run, coverage, the rulebook's checks.
- `workflow verify --rerun`: verify now and record the result as the turn end would. Only in `converging`, never under `CI=true`.
- `workflow req lint`: catalogue structure.
- `workflow req guard`: nothing weakened without approval, and the change file tells the truth.
- `workflow req trace`: every active requirement has acceptance evidence.
- `workflow req risk`: how well the plan predicted what this change breaks, and whether to stop.
- `workflow req renumber`: renumber a requirement the target does not know yet.
- `workflow triage`: run the suite and classify what broke, before anything is fixed.
- `workflow replan`: request a revised plan. Use `--resume` when the operator chooses the original plan.
- `workflow state show`: the phase and what comes next. Injected every turn.
- `workflow state verify`: the logbook links up and matches git; every baseline is on the target or was proved there when its change was recorded; agent settings warnings.
- `workflow areas`: where review must look. `--staged` measures the staged files.
- `workflow coverage`: no folder below its minimum, no code file missing from the report.
- `workflow checks-analysis <seq>`: submit analysis on stdin.
- `workflow report`: the change summary recorded for this tree, or a preview.
- `workflow mutate`: mutation testing on the lines this change touched. No time limit by hand. `--base <sha>` measures from elsewhere, `--verbose` shows the tool's log.

The operator's two words, each recognised only as a whole prompt: `record` and `reset`.

## Concepts

### Operator

Only the operator approves a plan, types `record` or `reset`, edits the rulebook, registers hooks, approves a commit and merges. Decide implementation details within the approved scope. Pass on every message and warning addressed to the operator.

### Plan

A working document for the approval, written directly in the rulebook's plans folder. After approval, the approved plan is the local snapshot named by the approval and the state summary. Plans and snapshots are not committed: the change file is what survives.

<!-- PLAN_TEMPLATE -->

Rules:
- Every change gets a plan. No waivers.
- Read the approved plan from the snapshot named in the state summary. The working file has no force after approval, whether it is edited or removed.
- If the snapshot is unavailable locally, restore its exact approved bytes at the recorded path. Do not substitute a working file or a remembered plan.
- How names what you rejected when the choice was close.
- Test delta is a prediction. The triage settles which tests need writing, usually including some no plan foresaw.
- The plan may end with a fenced block labelled `workflow`, last in the file, holding YAML with only these keys:
  - `test-only: true`: a change made only of tests. Only in the block, never in prose. Omit otherwise.
  - `requirement-changes:`: each requirement the change adds, rewords or retires, exactly as it will read: `id`, `status`, `statement`, every scenario as a string such as `'[AC0004.1] The scenario as it will read.'`, and `renumberedFrom` with the old id when renumbered. Without it the guard refuses the change everywhere but CI. Adding a scenario needs no approval, but list it: until `record` the entry stands in for the change file.
  - `predicted-failures:`: one string per expected failure: a scenario id such as `AC0004.1` (every acceptance test tagged with it), a path from the repository root (every test in the file, as when it fails to load), or `path::test name` (one test, named as the test report gives it; leading group names may be left out; case and punctuation ignored). Quote an entry holding a colon and a space.
- Predict every test that reaches the code you change, also through another process, such as a browser test against a real server or a test that starts a program.
- List what you expect and no more. An unlisted failure is a surprise; a listed test that passed is an over-prediction. Both raise the risk. A file entry over-predicts each passing test in it, so name tests one by one when only some fail. An entry matching no test is an over-prediction.
- When the plan changes materially, present the revision.
- In `implementing` or `converging`, run `workflow replan` before ending the turn to discuss a revision. One request covers the conversation and defers verification. Relay a refusal to the operator. A recorded change needs a merge or the operator's `reset` first.
- Further drafts keep the request pending. Approval of a changed plan closes it. If the operator declines the revision and chooses the original plan, run `workflow replan --resume` and continue from the current phase.
- Write a revision as a new plan file in the plans folder and present it for approval. Never edit the approved snapshot into a revision; `.katatay/` is locked.

Restrictions:
- A `workflow` block anywhere else, or `---` frontmatter at the top, is refused at approval. Label an example block `yaml`.
- The recorded predictions change only with a new approval.

### Approval

The operator's approval of a presented plan, given through the agent and recorded by a hook against the text they approved, edits included.

Rules:
- Present the plan the way the agent adapter's section says.
- Reapproving identical content changes no state.
- A revised plan replaces the earlier approval and sends the change back to `implementing`. Its new work must be triaged, and the tests are frozen again: revert any written since the baseline first.

Restrictions:
- A plan the operator does not approve records nothing.
- A plan approved on the target branch is refused and nothing is recorded.
- A second plan on a branch whose change is `recorded` is refused and nothing is recorded. Merge first, or `reset`.

### Branch, target and baseline

One change per branch, until it merges. The target is the rulebook's `targetBranch`, the remote branch changes merge into, such as `origin/main`. The baseline is the commit a change is measured from.

Outcomes:
- The freeze, triage and review areas use the baseline. The rulebook’s high-risk list directs review. `workflow req guard` compares the whole branch with the target.

Rules:
- The approval pins the baseline: where `HEAD` meets the target, asked of the server when it answers, else from the remote-tracking ref. It moves only forward, when the target is merged into the branch (`baseline_moved`).
- A push is a checkpoint. A red CI after it is an edit, back to `converging` under the same plan.
- A change reaches `recorded` only once every baseline in its logbook is proved on the server's target (`git ls-remote`). While the server does not answer, it stays `declared` and says so.
- In CI, `workflow state verify` checks every baseline no `recorded` event vouched for against a fresh fetch. A recorded baseline is trusted, so a batch branch can merge.

Restrictions:
- Project commands require `targetBranch`. The rulebook’s `version` must match `workflow version`.
- A branch cut from another unmerged branch is not supported. The approval warns when the tree already changes files the target lacks, committed, uncommitted or untracked: that work counts as this change's.

### Logbook and phases

An append-only logbook per branch under `.katatay/state/<branch>/`, one committed file per event. The phase is folded from it.

Phases:
- `open`: no plan approved, or no commit yet, or a state the gate cannot read. Every write in the repository is denied, except files directly in the plans folder and the follow-ups file.
- `implementing`: edits allowed, tests frozen, nothing verified. A red suite is normal.
- `converging`: triage recorded, tests editable, implementation frozen.
- `verified`: verify passed on this tree, under the current rulebook and baseline. A change to any of the three goes back to `converging`. Nothing moves without the operator: tell them. A change file written now advances nothing.
- `declared`: the operator typed `record` on this tree. Write the change file.
- `recorded`: every baseline proved, and the guard passed on the change files as they stand. Editing a change file goes back to `declared`, any other edit to `converging`. The machine ends here.
- `broken`: the logbook does not link up. Everything stops. Tell the operator.

Use `workflow state show` to check whether events are committed. Deleting uncommitted events can erase their history.

### Change epochs, merge and reset

- Only the operator can reset. A reset starts a new epoch at `open`. Its abandoned events and change files remain committable.
- After merge, start a new plan even when reusing the branch name. Before merge, one more fix at `recorded` goes back to `converging`. A reset cannot stack changes on an unmerged branch.
- Restore any missing change file named by a live `recorded` event, or ask the operator to reset.

### Freeze

In `implementing`, keep every test and support file at its baseline contents, including fixtures and helpers. Triage and turn end check the freeze. After triage, keep the implementation at its recorded fingerprint. Restore drift or present a revised plan, restore baseline tests and triage again.

### Triage and predictions

`workflow triage` runs the suite and sorts each failure into predicted or surprise. It lists predicted tests that passed (over-predictions) and predicted files that never ran.

Outcomes: the plan is measured, the risk level set, `triaged` recorded with its implementation fingerprint, and tests become editable.

Rules:
- Run it in its own tool call when the implementation is complete, before fixing anything.
- Read the surprises first: they exist only until fixing starts.
- Post its report verbatim, through the `Details:` line. The rest is for you.
- For each over-prediction: either the change did not do what you thought, or the test does not test what it says.
- A predicted failure is still a failure. Fix it.

A recorded `triage_refused` gives the reason and the action to take:

- `implementation_changed` — restore the triaged implementation or present a revision.
- `tests_modified` — restore the listed frozen files to their baseline contents.
- `typecheck_failed` — finish compiling the implementation. Compile errors in tests count as failed tests.
- `invalid_test_run` — read the diagnostic and correct the cause of the unusable run.
- `measurement_changed` — the tree or approval changed during the run. Triage again.
- `snapshot_failed` — resolve the reported problem saving the triage evidence and retry.
- `suite_not_green` — the baseline suite failed on a test-only change. Fix those failures as their own change.

Without an approved plan or readable logbook, follow the refusal before retrying. When the adapter requests a continuation after triage (`convergence_requested`), resume the approved work.

### Test-only change

Declare `test-only: true` in the plan's closing block. Run triage on the unchanged baseline tests before writing any tests. After a green triage, edit tests and proceed to verification. The triaged implementation stays frozen.

### Verification

In `converging`, the turn-end hook runs `workflow verify` itself and records the result unless a revision is pending.

Outcomes:
- A pass records `verified`, a failure `verify_failed`. Each gives the operator a summary: failures, findings, reused results, warnings, review areas, skipped and passed checks, and the event's link.
- A failure also gives you a note with the output's tail. On an unchanged tree, rulebook and baseline it is not rerun: the failure stands. If its cause lay outside the tree and is fixed, run `workflow verify --rerun`. Tell the operator a pass came from it.

Rules:
- After a failure, check the tests. Present a revised plan if the implementation needs a fix.
- Act on the summary's findings: write the missing test, or say why none can reach the line or kill the mutant.
- When asked to post a verification summary, passed or failed, post it verbatim, through the `Details:` line.
- When `checks.requireAnalysis` is on (default), use the requested headings for test scenarios and assertions, code repairs and their checks, and limitations. Submit the analysis for the verification sequence. After `checks_analysis` is recorded, post the printed summary verbatim after the report.

Restrictions:
- Never report that you verified something. A transcript line proves nothing.
- A plain `workflow verify` writes no logbook event.
- A refused stop is one-shot. Stopping past it only stalls the machine.

### Record and change file

Outcomes:
- On `record`, both implementation and tests must match the latest successful verify. Test edits require a fresh verify. Report implementation drift to the operator.
- On `record`, submit and present any requested missing analysis and wait for another `record`. Otherwise the prompt hook runs `workflow report`, keeps the full report in a snapshot the event names, and gives you the change summary.
- The change is declared at once, unless the report found gaps (uncovered touched lines, surviving mutants or unproved mutants) and the latest successful verify shows no test edit since the preceding successful verify under this approval. Then `record_held` is written and a second `record` on the same tree declares. A `record` on a declared or recorded tree appends nothing and repeats the handoff: post the summary it gives, then do what follows it. Both events keep measured gap counts in `gaps`. Zero means measured with no gaps. An absent count means unmeasured. Restore missing or invalid required evidence before retrying `record`. For missing test identities, restore the exact snapshot or preserve test edits, restore baseline tests, run triage, reapply edits and verify again.

Rules:
- Post the change summary verbatim, first in the reply, through its `Details:` line. Keep the change-file section out of chat.
- On a hold, reproduce the saved analysis's summary if missing from this chat.
- If asked for explanations, give your reasons for each uncovered line and confirmed survivor. Explain unproved mutants by the counts in the full report: reached by no test, pending, or no completed tests.
- Write the change file in the requirements folder's `changes/` as `<UTC timestamp>__slug.md`, following `TEMPLATE.md` there.
- It opens with `## Report`, the report's summary lines word for word as the record context gives them. The `declared` event keeps the same lines.
- It has `## Departures`: how the outcome differed from the plan, usually `None.`.
- Its frontmatter states each requirement the change leaves behind: id, resulting status, resulting statement.
- Change files sit outside the tree fingerprint, so writing one leaves the receipt and declaration standing.
- After `recorded`, write the commit message. Commit only with the operator's yes.

Restrictions:
- Write the change file only after `record`. Its existing is never the declaration.
- Any edit outside change files voids the declaration.
- The record step refuses a `## Report` that differs. The guard refuses a file without `## Departures`.
- Mutation is not run again after you act on it. `workflow mutate` is the operator's call.

### Requirements and scenarios

The requirements folder (`requirements` unless the rulebook names another) holds acceptance criteria (AC) and invariants (INV). Its README gives the format.

Outcomes: tests are the requirements' living documentation. `workflow req trace` fails when scenarios and test titles disagree.

Rules:
- Each AC lists scenarios, one line each with its own id. Each acceptance test proves one, titled with the scenario's text word for word and its id: `- [AC0001.1] A rejected proposal is not in the catalogue.` is proved by `it('A rejected proposal is not in the catalogue. [AC0001.1]', ...)`.
- Ids are identity, never order.
- Adding a requirement, or changing a protected one, takes a change file, which you write, and the operator's approval: locally, the plan's `requirement-changes:` entry. Outside CI the guard accepts the change while the catalogue matches the entry exactly.
- Until `record` the entry stands in for the change file. The record step runs the guard with `--record`, and then only the change file counts.
- A branch gathering several unmerged changes carries their approvals in their logbooks, and the guard accepts those. They never stand in for a change file.
- In CI the guard ignores the plan route, prints a new, reworded or retired requirement for the reviewer, and fails only on what no approval could permit, such as a deleted requirement or a missing change file.

Restrictions:
- Never weaken a requirement to make a test pass. If verification exposes an implementation defect, present a revised plan.
- The folder is writable, never deletable. A requirement leaves only as `superseded` or `withdrawn`. Change files are append-only.
- Deleting a tagged test requires its requirement to be modified or retired in the same change.
- Not evidence: a skipped or todo test, one skipped on a condition, one expected to fail, one in a file the runner never collects. `workflow req trace` still checks their titles and tags.

### Test categories

Rules:
- Use `tests.paths.all` for test files, `tests.paths.acceptance` for requirement evidence and `tests.paths.slow` for the runner’s slow selection. The freeze also covers `tests.paths.support`. For tags above a test, `tests.run.tagComment` matches the comment lines.
- `all` and `acceptance` need a glob each. An empty or omitted `slow` makes every test fast.
- A helper matched only by a subcategory is still a helper.
- Verify and the triage run every test. Any failure counts.
- Only acceptance files supply tags, also when a file fails to load.
- Fast acceptance tests for domain rules. A slow one only when the promise needs the real system.

### Coverage

The share of code lines and branches some test runs.

Outcomes:
- `workflow coverage` fails when a folder is below its minimum, or a code file in a measured folder is missing from the report.
- Each verified pass lists, by file and line, the code lines this change touched that no test runs. It reports and never blocks.

Rules:
- When a change lowers a folder's figure, write the test.
- For each uncovered touched line, write the test or say why none can reach it, such as code running only in a separate process.
- Configure both `checks.testQuality.coverage` and `checks.testQuality.mutation`. Either can be `"none"`. Enabled coverage runs `always` and must `block` on failure. Its `minimum` needs at least one folder ending in / with both `lines` and `branches`. Compare measurements rounded down to one decimal.
- The check runs the configured command, reads LCOV from stdout, and saves its analysis to `output`, tied to tree, baseline and rulebook. A missing or stale analysis reads as unavailable. The test command must clear old source coverage first.

Restrictions:
- A covered line ran. Nothing says anything was asserted.
- No session may write the rulebook, so minimums cannot be lowered or raised from one.
- An exclusion in the test runner's config fails the check. A file gaining a coverage ignore comment (spellings in `checks.testQuality.coverage.suppressions`) is listed under "Must look".
- Coverage cannot skip CI.

### Mutation testing

Mutants, small planted bugs, go into the lines touched since the baseline. A mutant no test fails against survived.

Outcomes:
- It runs inside `workflow verify`. The referee picks the lines, reads the tool's exit code and standard report, and shows counts and survivors.
- Later verifies reuse a passing run’s findings under the same approval, rulebook and baseline.

Rules:
- `checks.testQuality.mutation` requires `command`, the standard report path in `output`, and exclusion globs in `excludePaths`. It runs `oncePerPlan` and must `report` findings. The default time limit is 300 seconds.
- Survivors and a valid inconclusive run are reported. Some mutants change nothing observable: the operator decides how to act on a survivor.
- An automatic run gets `checks.testQuality.mutation.timeLimitSeconds`, and starts only when the limit plus 20 seconds remain in verify. Otherwise the deferral is reported. A tool stopping within its budget may report partial results.
- `workflow mutate` is an explicit rerun, also in CI.
- `checks.testQuality.mutation.skipInCi: true` keeps it out of a verify with `CI=true`. The skip is not the plan's run.

Restrictions:
- Only fast tests run against mutants. Code only slow tests reach is "reached by no fast test".
- Only touched code is mutated, as `code.paths` defines it. Never tests, frozen files, or `checks.testQuality.mutation.excludePaths`. Static mutants, in code run when a file loads, are skipped and counted.
- A mutant tests reach but the tool ran none against shows nothing. It is not a survivor.
- A tool that crashes, overruns its backstop or gives invalid evidence fails verify. A failed verify consumes no run.

### Checks

The project's other checks, such as a lint, a security scan or the build, in the rulebook's `checks`, chains `testQuality` and `codeQuality`. Verify runs each after its own steps.

Rules:
- Each lists the exit codes for clean, findings and broken.
- With `onFailure: block`, findings fail verify. Otherwise the verified message carries them: fix them or say why not.
- A `oncePerPlan` check reuses a verified result under the same approval, rulebook bytes and baseline. Otherwise it runs again.
- `skipInCi: true` skips the check when `CI=true`, and verify says so. Only `CI=true` counts as CI.

Restrictions:
- A broken check fails verify whatever `onFailure` says: an unlisted exit code, a crash, a run past its time limit, or a setup failure.
- A comment silencing a check in one spot, such as `eslint-disable` or `# nosec`, lists the file under "Must look" by the rulebook's patterns. Add one only when the finding is wrong, and say why where the reviewer reads it.

### Locks and protection

A hook asks the referee before every file write and shell command. Locked: the files in the rulebook's `agent.lockedPaths` (the agent's settings and hooks), anything under `.git/`, and `.katatay/` (the logbook, and the rulebook with the target, minimums and acknowledged hooks).

Outcomes:
- `workflow areas` lists "Must look": each `highRisk` file with its reason, the rulebook always, and every existing requirement a change edits. The verified message, `state show` and the commit message carry the same list.

Rules:
- When a change needs a locked file, prepare a patch outside the repository for the operator.
- The requirements folder is writable, never deletable. `workflow req guard` watches it inside `workflow verify` and in CI.

- Outside the repository the rulebook's path locks still apply. Pass every agent settings warning from `workflow state show`, `workflow state verify` or the verified message to the operator.

### Follow-ups

Park out-of-scope work in `followUpsFile`. It and plan files directly in the configured plans folder are writable in every phase.

### Done

Outcomes: done means the behaviour exists, the touched requirements are satisfied, invariants hold, tests pass, and you can show it.

Rules:
- Report what happened: failing tests with their output, and any skipped step by name.

Restrictions:
- Passing tests that do not demonstrate the agreed behaviour are not completion.
