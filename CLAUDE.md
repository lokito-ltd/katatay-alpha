# Katatay

This repository is the Katatay harness: the referee, its language and agent
adapters, and the package that ships them as `ktty`. The harness also guards
this repository's own changes.

## The workflow

Every change here goes through the workflow a referee enforces. Its
instructions are installed in `.claude/rules/workflow.md`, which Claude Code
loads at the start of each session, and in `AGENTS.md`, which Codex reads.
Read them first.

This file holds what is true only of this repository.

The sources of the installed files are here too, because this repository
develops the harness. `src/workflow/INSTRUCTIONS.md` and
`src/workflow/skills/` are the referee's text, in words any agent can follow.
The Claude adapter, in `src/agents/claude/install-files.mjs`, turns them into
`.claude/rules/workflow.md` and `.claude/skills/`, and the Codex adapter, in
`src/agents/codex/install-files.mjs`, into `AGENTS.md` and `.agents/skills/`.
For a source change, pass `installRequest()` from `src/workflow/install.mjs`
to each adapter’s `installFiles()` and refresh the installed text. Preserve the
project preamble in `AGENTS.md`, which directs Codex here. Ordinary `init`
keeps existing files and appends to shared files that lack its markers.

## Commands

The referee's commands are npm scripts here, aliases for
`node src/workflow/cli/workflow.mjs`. The referee runs from this checkout's
source, not from an installed `ktty`. Its messages name the commands as
`workflow <command>`, as its instructions do. Run the npm script this table
gives for each.

| Referee command | Here |
|---|---|
| `workflow version` | `npm run --silent workflow:version` |
| `workflow verify` | `npm run verify` |
| `workflow verify --rerun` | `npm run verify -- --rerun` |
| `workflow req lint` | `npm run req:lint` |
| `workflow req guard` | `npm run req:guard` |
| `workflow req trace` | `npm run req:trace` |
| `workflow req risk` | `npm run req:risk` |
| `workflow req renumber` | `npm run req:renumber` |
| `workflow triage` | `npm run triage` |
| `workflow replan` | `npm run replan`, or `npm run replan -- --resume` when the operator chooses the original plan |
| `workflow state show` | `npm run state:show` |
| `workflow state verify` | `npm run state:verify` |
| `workflow areas` | `npm run review:areas`; add `-- --staged` for the staged files, and `--silent` after `npm run` to keep npm's own lines out |
| `workflow areas --staged` | `npm run --silent review:areas -- --staged` |
| `workflow coverage` | `npm run coverage:check`; runs the coverage command and saves its analysis |
| `workflow checks-analysis <verification-seq>` | `npm run --silent checks-analysis -- <verification-seq>`; supply the analysis on stdin |
| `workflow report` | `npm run report` |
| `workflow mutate` | `npm run mutate` |
| `workflow defaults <command>` | `npm run agent:defaults`, for the Claude adapter |
| `workflow init` | `npm run workflow-init`, with both agent adapters; to set up another project from this source, run `npm --prefix <this checkout> run workflow-init` in that project, or pass `-- --project <dir>`; add `-- --probe` to run the rulebook's commands and write nothing |

And the ones that are this project's own:

```bash
npm test             # every test; writes the JUnit reports to reports/junit/ and the coverage report to coverage/
npm run test:fast    # every test outside the slow selection — for quick checks while working
npm run secrets      # gitleaks over the working tree; 0 clean, 2 findings
npm run pack:katatay # the release tarball, dist/katatay-<version>.tgz
```

## Test categories here

The rulebook's `tests.paths.all` selects the project's tests. Ordinary
tests exercise the code, and their failures count in the suite. Acceptance
files under `acceptance/` or named `*.acceptance.*` supply requirement
evidence. Most exercise a module's public contract in process.

The slow globs select performance tests and four Node test directories.
The black-box conformance suite in `tests/acceptance/` runs the checkout's
`ktty` as a process. Set `KTTY_BIN` to the path of another `ktty` to check it.
Use `tests/machine/` for workflow state and transitions, `tests/hooks/` for
agent adapter contracts, and `tests/integration/` for other checks across
components or repository resources. Place tests that cannot run under mutation
in one of these directories. When a fast file mixes short and expensive cases,
split the cases by what they prove. The November 2026 move used a measured
one-second cutoff for individual cases.

A test that is not evidence, in Vitest's words: one under `.skip`, `.todo`,
`.skipIf` or `.runIf`, one under `.fails`, and one in a file no Vitest project
collects.

`npm test` runs every test category, so `verify` and the triage see everything. It is
the rulebook's test command, and it is two npm scripts in `package.json`, one
after the other:

- `test:run:fast`: the fast selection, with coverage.
- `test:run:slow`: the slow selection, without coverage.

Each passes the TypeScript adapter's reporter,
`src/adapters/typescript/vitest-junit-reporter.ts`, to Vitest, and names the
file it writes in `JUNIT_REPORT`: `reports/junit/fast.xml` and
`reports/junit/slow.xml`. The rulebook selects these JUnit files through `tests.run.reportPaths`. The test command loads the reporter.
The reporter prints one line per run on stderr, naming the TypeScript it
loaded, so `npm test` shows it twice.

Coverage is measured over the fast tests only. The slow tests start the hooks
and verify as separate programs, which coverage cannot see, so they add little,
and a second coverage run would empty the report folder and throw the first
one's report away.

Both always run, whatever the first one found, and `npm test` fails when
either did. A test file the report leaves out counts as failed to load, so a
slow run skipped because a fast test failed would read as broken files in
every triage. That logic is shell in the `test` script. No test checks it
or the scripts' text: fast with coverage first, slow second, two different
report files.

The slow tests run on at most 60% of the CPUs, the `slow` project's
`maxWorkers`. Each one starts the hooks and verify as programs, so one file
keeps more than one core busy. Vitest's default, one fewer than the CPU count,
timed tests out under load. On 2026-11-09, with 10 cores, the whole slow run
took 209 seconds at 9 workers and one test ran past its 30 seconds, a
different test from run to run. At 6 workers it took 193 seconds and nothing
failed; at 4, 273; at 2, 535; one at a time, 964. The two slowest tests, the
Codex journey and a triaging machine test, take about 19 seconds even alone.

## Predicting failures here

A plan lists the tests it expects to fail under `predicted-failures:`. The
tests that reach the code only through another process are the easiest to
forget. The workflow tests start the hooks as separate programs, such as
`src/agents/claude/hooks/pre-tool.mjs`, and the machine journeys in
`tests/machine/` drive the moments that way. A machine test is named by its
file and test name like any other. Vitest reports a test's name with its
`describe` groups in front, joined by ` > `; they may be left out.

Tests also break through their mocks, which a search for the changed text
does not find. Many unit tests here replace a module with `vi.mock` and a
factory that lists only the exports the code used when the test was written,
or a fake that returns less than the real function. When a change makes code
call a new export of a mocked module, or read a field the fake does not
return, every test in that file fails before reaching any assertion. Before
writing the predictions, list the test files that mock each module the change
touches, and check what their mocks provide. Once, two missing mocks in
`src/workflow/moments/recording.test.mjs` made 23 tests fail that no text
search predicted, and the first triage came back with 42 surprises.

When predicted tests are rewritten after the triage, run them once and copy
what they actually print before writing new assertions. Wrapping and fixture
details, such as the machine fixture's `tests: PARTIAL` result, are easy to
get wrong by guessing, and each wrong guess costs a slow machine-test run.

## Acceptance tests here

The acceptance tests in `tests/acceptance/` are a black-box conformance suite.
They check Katatay from outside, so the same tests can later check a Go
rewrite. Set `KTTY_BIN` to run them against another `ktty`. Follow these rules
when adding or editing one.

- Name each test with its scenario's text word for word and tag it with its
  id, as `requirements/README.md` describes.
- State behaviour only at the process boundary: `ktty` commands (arguments,
  exit codes, output), hook moments (JSON in and out, per
  `src/agents/contract.json`), the files Katatay reads and writes (rulebook,
  logbook events, snapshots, change files), and its git calls. A test imports
  nothing from `src/`. Keep `KTTY_BIN` working.
- Keep the fast in-process unit tests. Stryker switches a mutant on inside the
  test worker, and a process the test starts never sees it, so process tests
  cannot be mutation-tested. The conformance suite proves the contract; the
  unit tests keep mutation working. Do not delete a unit test because a
  conformance test now covers its scenario.
- Many scenarios are shown today only by in-process unit tests, which a Go
  port cannot reuse. Those need a new process-level test, not a rename.
- Write each test body in Given, When, Then order, so the operator can read it
  without opening helpers. Build fixtures in Given steps. Steps take arguments
  and return values. Pass context, inputs, returned results and earlier
  observations through parameters and local variables. Keep the expected
  values in the test body. Repeat When and Then for successive actions:

  ```js
  it('ktty version with an argument exits 2 and prints the correct invocation and help hint on stderr. [AC0001.3]', () => {
    const folder = givenAnEmptyFolder();

    const run = whenKttyRuns(['version', 'extra'], { in: folder });

    thenItExits(run, 2);
    thenItPrintsError(run, [
      "The 'version' command takes no arguments. Run 'ktty version'.",
      "Run 'ktty help' for usage.",
    ]);
  });
  ```

- Keep `whenX` and `thenX` as separate functions even when they share an
  operation: one performs the action, the other checks an observable effect.
  Reading a file can supply input to a later step, or check its contents
  against a value given in the test body.
- Keep the set of Then steps small and generic: exit code, printed lines,
  nothing printed, hook replies, file unchanged, nothing written, event
  appended. Each is reviewed once and reused everywhere.
- Keep assertions about exact values, order, absence and unchanged state when
  rewriting a test.

Steps with no arguments, such as `thenKatatayVersionIsPrinted()`, were
rejected, for four reasons. The name is a claim, not evidence: the check behind
it can weaken while the body reads the same. The expected values, such as exit
2 and the correction to print, disappear into the helper, so a reviewer has to
open it anyway. Steps that pass nothing between them share hidden state, and
order bugs follow; the machine harness's `ctx` comment describes that trap.
And one helper per phrase becomes hundreds of one-use functions across about
450 scenarios, each a third wording of the scenario that can drift on its own.
Nothing checks these conventions mechanically. They hold only while people
and agents follow them.

When a batch of acceptance tests lands, look for machine and other process
tests the new tests could retire. Name each candidate in the plan, with the
scenarios that cover its setup and assertions, and retire it once those tests
pass. Keep any case that also checks a distinct outcome, such as how an agent
adapter translates the referee's answer.

## Coverage and mutation here

`npm test` measures coverage over `src/`. The minimums
are in `checks.testQuality.coverage.minimum` in `.katatay/rulebook.json`.
The configured test command is `rm -f coverage/lcov.info && npm test`, so
cleanup must succeed before the tests start. The coverage command is
`cat coverage/lcov.info`. The referee saves its completed analysis to
`reports/checks/coverage.json`, a working copy. Inside verify it also keeps the
raw LCOV and the analysis as snapshots under `.katatay/local/<branch>/coverage/`,
named on the verification's event. The verified message and `record` read the
analysis from those snapshots, without rerunning coverage, reading LCOV or
opening the working copy.

The hooks in `src/agents/claude/hooks/` score near 0%, because tests run them
in a separate process, where coverage cannot see. They are measured anyway,
with their real figure. Only files that are not code are left out: tests, JSON,
CSS, SQL and Markdown. An exclusion is an edit to `vitest.config.ts`, and the
check fails on it.

Mutation is Stryker over Vitest, through the TypeScript adapter's wrapper
`src/adapters/typescript/stryker-mutate.ts`, capped at 240 seconds. The
wrapper exits 0 when no mutant survived by Stryker's account, 1 when mutants
survived, and 2 when the run proves nothing. It writes the standard mutation
report to `reports/mutation/mutation.json`, named in `checks.testQuality.mutation.output`.
The referee reads its counts and survivors and passes the wrapper's text on.
A missing or invalid report fails the run. Verification preserves the raw
report and derived findings as snapshots under `.katatay/local/<branch>/mutation/`.
Turn end validates them before recording their references and whether the run
was partial, in the mutation entry of `verified.payload.results`.
Later passes under the same approval, rulebook and baseline record a reused result that points at
that receipt, whose tree is the measured one, without rerunning mutation.
There is no separate mutation event. Missing or corrupt snapshots fail verification; restoring the
exact bytes allows reuse again. Mutation is skipped under `CI=true`
(`skipInCi`).

Which tests it runs is this project's call, in
`vitest.mutate.config.ts` at the root, which the rulebook's command passes as
`--vitest-config`. It runs the `fast` project only. It also leaves out every test,
in any folder, that reaches the code only through processes it starts, such as
the machine tests and the Codex journey: Stryker switches a mutant on inside
the test worker, so those processes never see one, and they took most of
Stryker's first pass. A test file counts as one when it imports nothing but
Vitest, Node and test support (the machine harness and its helpers, and
`fixtures/` folders). A file that mixes in-process and process cases is split,
with process cases in the appropriate slow directory so the fast suite stays eligible for mutation. `vitest.mutate.config.ts` names those support paths, and
`src/adapters/typescript/process-only.ts` applies the rule.

The fast deciding tests call the moments in process. They give the turn end a fake verify because the real verify starts dozens of processes. Before the split this cut the deciding file from about 90 seconds to 60. The longer cases in `tests/machine/deciding.test.mjs` exercise decisions with the fixture repository, including the real verify where the case needs it. The machine tests start the real verify. The rulebook's
`tests.paths.support` freezes the machine harness and the workflow, Claude and
Codex fixtures until triage. Mutation skips frozen files automatically.
`checks.testQuality.mutation.excludePaths` holds the runner configs such as
`vitest.config.ts`. Static mutants are skipped because
on the change that measured it they did 80% of the test runs. See
`src/evidence/mutants.ts`, and `src/adapters/typescript/stryker.ts` for the
Stryker side.

## Secret scanning here

The repository is public, so a leaked token is exposed the moment it is
pushed. gitleaks scans in three places, with the same pinned version (8.30.1)
and the same `.gitleaks.toml`:

- Inside `verify`, as the rulebook's `checks.codeQuality.secrets`:
  `npm run secrets` scans the working tree. It exits 2 on findings and blocks.
  gitleaks' own errors exit 1, and a missing binary 127; both are unlisted
  codes, so the check counts as broken and verify fails. It never reads as
  clean. `--redact` keeps secret values out of the output and the logbook.
- In CI, the `secrets` job runs the same scan, and then `gitleaks git` over
  the full history, which also catches a secret committed and deleted in the
  same pull request.
- On GitHub, secret scanning and push protection.

`.gitleaks.toml` allows only folders git ignores. A test fixture that holds a
fake token on purpose is added there one path at a time, with a comment
saying why. An inline `gitleaks:allow` comment puts its file under "Must look".
The README and `.github/workflows/verify.yml` both name the gitleaks version;
change them together.

## The harness in this repository

The **referee** is everything under `src/` except `src/adapters/` and
`src/agents/`. `src/adapters/README.md` is the language adapter contract,
and `src/adapters/typescript/` is this repository's adapter.
`src/agents/README.md` is the agent adapter contract, and
`src/agents/claude/` and `src/agents/codex/` hold the two adapters.
`src/katatay/` is the `ktty` command, and `packaging/` builds the release
tarball.

The referee never imports a language tool. The `referee-is-language-free` rule in
`.dependency-cruiser.cjs` enforces it, with no exceptions.

Where the split is going, and what each part will own, is in
`src/VISION.md`. The code is behind the vision until each step lands. Each
configured agent has its own setup check and extra-hook acknowledgements under
`agent.adapters`. The referee runs every check and names the source of every
warning. Locks and the plans folder remain shared.
`src/workflow/README.md` describes the rulebook's sections, and
`src/workflow/record.mjs` the record step.

The locks are in `src/workflow/locks.mjs`, and the lock code is as editable as
the rest of `src/`.

## What is protected here

The rulebook's `highRisk` list here holds two areas, each with its own
reason:

- `.github/`, `.claude/` and `.githooks/` change what is doing the
  watching. A diff there deserves attention however innocuous it looks,
  because the guardrails are enforced by the configuration it edits.
- The package manifests and the configs of the checks: `package.json`,
  `package-lock.json`, `tsconfig.json`, `vitest.config.ts`,
  `tests/integration/vitest.config.test.ts`, `vitest.mutate.config.ts`,
  `.dependency-cruiser.cjs`, `tests/integration/dependency-cruiser.test.ts` and
  `.gitleaks.toml`. The manifests carry install-time lifecycle scripts. A
  red-team pass once added a failing test to `exclude` in `vitest.config.ts`,
  and took the tests out of `tsconfig.json`'s `include`, which hid 51 type
  errors, and every check still passed. `tests/integration/vitest.config.test.ts`
  pins what the config measures, and `.dependency-cruiser.cjs` holds the module
  boundary rules, where narrowing a rule's path lets a deep import through and
  reads as a one-line tidy-up. `tests/integration/dependency-cruiser.test.ts` is what fails when
  the rules stop firing. An allowlist entry in `.gitleaks.toml` hides secrets
  the way a coverage exclusion hides code.

`src/` is off the high-risk list, because nearly every change edits it. So
`src/` is not under "Must look", and an edit to the approval hook's proof
that a baseline is on the server, which CI no longer catches for a recorded
baseline, is seen only by a reviewer reading the diff under `src/`.
`req:risk` scores no file at all: its level measures the plan's missed
predictions and test regressions.

`.github/workflows/verify.yml` has no power on its own: a branch can edit or
delete any job in it. What holds the line here is GitHub's branch protection
on `main` (no direct pushes, pull requests need the CI checks), auto-merge
being off, and the operator reviewing and merging by hand.

## How to write here

Write in plain words. Lead with the answer or the rule, then give the reason.
Short sentences, plain verbs, ordinary vocabulary. Avoid aphorisms, "not X but
Y" constructions, and reasoning that builds up to its own conclusion.

Keep every reason. Plain does not mean shorter: the reasoning in these files and
in the comments under `src/` is the most valuable thing in them, and a rewrite
that drops it to save words has made the repository worse.

The exception is the text written for agents: `src/workflow/INSTRUCTIONS.md`
and the agent sections in `src/agents/*/install-files.mjs`. Agents are their
only readers, so they hold rules, triggers and actions, and keep a reason only
where an agent needs it to act right. History and narrative belong in change
files, code comments and `src/workflow/README.md`. Codex reads only the first
32 KiB of the repository's `AGENTS.md` files together, so keep the
shared instruction source at or below 26,000 bytes and the installed
`AGENTS.md` at or below 32,768 bytes. The Codex adapter warns when they no longer fit.

This is the one rule here that no hook, test or guard enforces — prose style
cannot be checked mechanically. It holds only as long as people and agents
follow it on purpose.
