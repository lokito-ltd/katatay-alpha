# Follow-ups

Work spotted in passing and parked, so the current change stays one thing. This
is not a plan and not a promise — each item still goes through plan mode when
someone picks it up. Remove an item once a change file records it.

## Workflow

- **Allow an agent to defer turn-end verification when post-triage work shows
  that a revised plan is required.** The agent should be able to present the
  revision for operator approval without starting a full verification run for
  the superseded implementation. Deferring verification must not count as a
  pass or permit recording. Raised by the operator on 2026-11-13.

- **`req:guard` reads only the change files of the change epoch.** Today
  `loadNewChangeFiles` in `src/requirements/guard.ts` reads every change
  file the target lacks, and every requirement any of them records counts as
  accounted for. So a change file from before a `reset`, whose change the
  operator abandoned, can still account for a requirement change in the next
  change epoch. Only `recordFidelity` on the newest record of each
  requirement holds it. The phase and the `recorded` event already leave
  those files out (the `reset` event lists them). Open question: CI does not
  trust the logbook, so it cannot tell which change files a reset abandoned,
  and would still read them all. Decide what CI does before the local guard
  narrows, or the local guard passes where CI fails. Raised by the operator
  2026-11-09.

- **Distinguish an unreadable Codex configuration from its default document
  limit.** When `codex app-server` fails, the adapter substitutes empty
  settings and reports the 32,768-byte default as the actual
  `project_doc_max_bytes`. On 2026-11-04 this warned that a 33,328-byte
  AGENTS.md was truncated even though the user configuration sets 65,536.
  Report the effective limit as unknown when configuration cannot be read;
  apply the default only after a successful read with the setting absent.
  Update the test that currently expects the misleading warning. Preserve
  useful app-server failure diagnostics to investigate the exit; stderr is
  currently discarded. The cause of that exit remains unknown.

- **Show one report per change.** Show triage once. Add the first verification
  result to that report. On each repeat verify, show only what changed since
  the preceding verification, including any new action the operator needs to
  take. Show each warning when it first occurs and include it in the change
  report. Keep the complete output from every hook run available on demand.
  Lead each displayed report with the outcome, any blocker or decision, and
  the next action. Cap it at 4 kB (4,000 UTF-8 bytes), including a short
  pointer to the full output when details are truncated. This limit applies
  to the displayed report; retain the full output even when it exceeds 4 kB.
  Raised by the operator 2026-11-03.

- **Plan verify's time against the hook deadline as a whole.** Deferred
  until a project's verify comes near its hook's time limit: a slower suite,
  a lower hook timeout or another agent's Stop limit. Verify runs
  inside the turn-end hook, and the agent kills a hook that overruns. A hook
  killed inside verify writes no `verified` event and gives no message, and
  the next turn starts the same work again. Today only mutation looks at the
  deadline, and it reserves its own limit plus 20 seconds. That reserve dates
  from when mutation ran last, after verify. Since step 28 the code chain runs
  after it (`boundaries` and `build` here, each allowed 300 seconds by
  default), and nothing counts them. Nor does any other check look at the
  deadline. Before a check starts, verify should know that its limit, the
  limits of every check after it, and the reserve for the message all still
  fit, and say clearly which check it deferred and why. With 900 seconds and
  tests near 80 this does not bite here yet. Where it does bite, the operator
  gets no message, and each turn end retries the same verify without end.

- **Stop a mutation run when the hook that started it is killed.** Since
  step 28, `runMutate` in `src/workflow/adapter.mjs` starts the mutation
  command in its own process group, so its backstop can kill Stryker and
  every worker under it. The cost is that the group no longer dies with its
  parent. If the agent kills the turn-end hook mid-run, Stryker keeps running
  unseen and can write `reports/mutation/mutation.json` after the next run
  cleared it. Kill the group when verify itself is stopped, and add a test
  that a child's own children are gone after the backstop fires.

- **Catch a missed promotion from `accepted` to `active`.** In the
  `hello-plan` trial, the greeting worked and its acceptance test passed,
  but AC0001 stayed `accepted`. Removing the test still let
  `req:trace` pass. Surface this omission before a change is recorded while
  allowing agreed, unbuilt requirements to stay `accepted` without tests.

- **Install the machinery where a session cannot edit it, and from more
  package managers.** The `katatay` npm package now installs the referee
  outside the project, as the `ktty` command, and writes the `ktty-init`
  skill for Claude Code and Codex. Two things the operator wants are still
  open.

  The first is protection. While the machinery lives where a session can
  write, the session can rewrite it. The rewritten version can record
  evidence nobody earned, such as a verify that never ran, and the session
  can then put the original files back and leave a clean diff. No check the
  session can write can catch this, because the same session can edit the
  check too. A global npm install sits in a folder the operator's own user
  owns, so a session running as that user can still edit it. The fix is an
  install owned by root, with its hooks registered by absolute path. A lock
  inside the repository, lifted by the operator for machinery changes, was
  considered and rejected. Until then, only a reviewer reading the diff
  stands in the way. Named 2026-09-21; direction chosen 2026-09-23.

  The second is reach: install it with a package manager such as Homebrew,
  and run it on projects that are not TypeScript. The direction and the
  order of the work are in `src/VISION.md`. The notes below are what that
  document leaves out.

  - **Why the second adapter matters.** Until a real change goes through the
    whole loop on Python or Go, the split is untested, and assumptions such
    as "tests sit next to the code" stay hidden.
  - **Packaging.** The command-line program exists (`ktty`). Still to do: a
    Claude Code plugin for the hooks and the skills. A plugin is installed outside the repository, so a session cannot
    edit the hooks, which is what the protection above asks for. Publish
    through a Homebrew
    tap, which is a repository of our own holding the install recipe. The
    main Homebrew repository only takes well-known projects.
  - **Rewrite the referee only if Node turns out to be a barrier.** A rewrite is
    not needed for either outcome. The remaining work and the packaging can be done
    in TypeScript, shipped as a single executable that bundles its own
    runtime. The reason
    to rewrite would be users who will not install Node, such as a Python
    team. The cost is porting about 13,000 lines, half of them tests that
    record edge cases found the hard way, and the risk of losing the
    reasoning in the comments. The TypeScript adapter stays in TypeScript
    whatever happens, because the TypeScript compiler's API exists only
    there.

  If it is rewritten, the choice is Go over Rust. Both run on Linux, macOS and
  Windows. Go is less work to ship to all three: it builds a Windows or macOS
  binary from a Linux machine with one command and no extra toolchain, its
  binaries need no system libraries, and GoReleaser publishes to Homebrew,
  Scoop, winget and Linux packages in one step. Rust needs a linker per target,
  and building for macOS from Linux needs Apple's SDK. Rust's enums would suit
  the state machine better, since the compiler checks every phase is handled.
  Its speed gains nothing here, because the tool spends its time waiting on git
  and the test runner.

  Three things need care on Windows in any language. Git can change line
  endings, so the tree fingerprint and the requirement checksums must hash the
  same bytes on every system, or a verified tree looks edited. Paths use `\`,
  and every comparison against `git diff` output must normalise them, as
  `compileErrorsIn` in `src/workflow/adapter.mjs` already does. And the machinery should keep calling the real
  `git` program rather than a library, so that it sees the operator's own
  configuration and credentials for `git ls-remote`.

  Raised by the operator 2026-10-08. Direction settled 2026-10-21.

- **Run the harness under other coding agents, not only Claude Code.** The
  operator wants the same workflow under Cortex, Cursor, Copilot and Google's
  agent. Codex is done. The contract every
  agent adapter keeps is in `src/agents/README.md`, agreed 2026-10-23. This
  item keeps only what that document leaves out.

  - **The agents after Codex.** Check each one's hook support before
    designing anything; it changes quickly. Each will offer a different subset
    of what the contract asks: a veto before a write, an operator-only
    approval with the plan, a turn end that can be refused, a prompt hook. An
    adapter reports what it cannot guarantee as a `check` warning.
  - **The floor, for an agent with no hooks.** Git and CI work whatever wrote
    the code: a pre-commit hook that refuses a commit the phase does not
    allow, and the CI jobs that already run.

  Raised by the operator 2026-10-20.

- **Move `init`'s process-only logic where tests can reach it.** Coverage
  and mutation see no code that tests only start as a separate process. On
  `step-33-init` that left 37 touched lines uncovered, and those lines are
  part of the 118 mutants no fast test reached. Move what those lines decide
  into exported functions, and keep only the program's entry and its exit
  codes in the scripts:
  - `src/agents/claude/install.mjs` and `src/agents/codex/install.mjs`
    read the project's registration file and merge into it, in the
    `try` block that calls `mergedSettings`. Put that in an exported
    `registrationFor(root, { plansFolder })` in each adapter's
    `registration.mjs`. It returns `{ path, text }`, or throws the merge's
    own error. `install.mjs` turns the throw into exit 1.
  - `terminal()` in `src/workflow/cli/init.mjs` builds each prompt: the
    question once per question, then its default as `[a, b]` for a list or
    as JSON for an object. Put the text in an exported
    `promptFor(question, previous)` and test it. The `readline` wiring stays
    untested.
  - The entry blocks in `cli/init.mjs` and `src/agents/init.mjs` stay
    process-only. The slow `tests/integration/workflow/init.process.test.mjs`
    covers them.
  Done when the change report lists only those entry blocks as uncovered.
  Raised 2026-11-07.

- **Acknowledge machine-specific extra hooks outside the rulebook.** The
  rulebook is committed, and here it is public, but the extra hooks an
  operator runs, such as a terminal status script, belong to one machine.
  Today the only place to acknowledge them is
  `agent.adapters.<name>.extraHooks.acknowledged`, so every operator's own
  hooks end up in the shared rulebook, with their paths. A machine-local list,
  outside the repository and outside every session's reach, would keep them
  private. It must stay as hard for a session to write as the rulebook is,
  or an agent could acknowledge a hook of its own. Until then, register such
  hooks with `~` paths, not absolute ones. Named 2026-11-12, during the move.

## Logbook cleanup

- **Review what happens when Stop runs twice or arrives late.** Codex can
  send the same Stop notification again after the agent has started fixing
  the failures. `convergence_requested` already identifies the triage reply.
  Check the other Stop actions, including verification, recording check
  results, and prompting for a commit. A repeated notification should do
  each action at most once, and a later completion should still run the
  checks its own tree needs. Revisit the 2026-09-25 question about repeated
  `verify_failed` events here. Preserve the history of distinct failed runs.

- **Sync snapshots to disk before the event that names them.** Nothing
  under `src/` calls `fsync`. A power loss between writing a snapshot under
  `.katatay/local/` and appending the event that names it could keep the
  event and lose the snapshot. Reading it would then report the file as
  missing or altered. Sync the snapshot (and its folder) before the event is
  written. Left open by the change that made the checks report read only the
  receipt; found again 2026-11-12, checking the old roadmap's leftovers.

## Evidence tools

- **Make mutation work with tools that cannot target exact lines.**
  Deferred until a second language adapter needs a mutation tool other than
  Stryker. The referee sends the mutation command a list of files and line ranges, and
  trusts the tool to mutate those and nothing else. Stryker can, because
  its `mutate` option takes `file:start-end`. Most other tools narrow a run
  by a git ref or a diff file, and often by a whole function, method or
  class, so they mutate more than they were asked to. Checked on
  2026-11-02:

  | Language | Tool | How it narrows a run | Precision |
  |---|---|---|---|
  | Rust | cargo-mutants | `--in-diff <file>`, a unified diff | mutants that overlap a changed region |
  | Ruby | mutant | `--since <git ref>` | whole method |
  | Go | gremlins | `unleash -D <branch or commit>` | changed lines; pre-1.0 |
  | Java | PIT | class globs; the `+GIT` plugin needs a license file | class |
  | Python | cosmic-ray | `cr-filter-git`, run after `cosmic-ray init` | lines |
  | Python | mutmut | not confirmed for mutmut 3 | unknown |

  So the referee filters the tool's report against the targets it sent:
  every mutant outside them is dropped from the counts and the survivors,
  by file and line. A wrapper then only has to cover the targets, not match
  them exactly. Without it, a wider tool reports survivors in code this
  change never touched, and the operator reads them as this change's. Then
  document in `src/adapters/README.md` the three ways a wrapper can
  translate the targets: a diff built from the ranges, the baseline sha
  as a git ref, or a wider run that the referee filters. A git ref sees only
  what git diffs, so it misses files git has not been told about, which the
  referee counts whole. Say that there too. Mutant needs a paid license
  for commercial use and PIT's Git plugin is licensed; that is from
  memory and not checked, so confirm it before the README names it.

- **Make coverage's and mutation's settings configurable, not fixed.** The
  rulebook accepts `runs`, `onFailure` and `skipInCi` on coverage, and `runs`
  and `onFailure` on mutation, and refuses every value but one for each
  (`parseCheck` in `src/workflow/rulebook.mjs`). Let them take any value an
  ordinary check's key takes, with today's values as the defaults:

  | Key | Default | Also allowed |
  |---|---|---|
  | coverage `runs` | `always` | `oncePerPlan` |
  | coverage `onFailure` | `block` | `report` |
  | coverage `skipInCi` | `false` | `true` |
  | mutation `runs` | `oncePerPlan` | `always` |
  | mutation `onFailure` | `report` | `block` |

  Decide first what an inconclusive mutation run does under `block`. The
  operator's condition, from 2026-11-10: a run that proved nothing must not
  block. Either it counts as ok, or an inconclusive run is never allowed to
  block. Today verify records such a run as findings (`mutationCheck` in
  `src/workflow/referee-verify.ts`), and with `block` findings fail verify.
  Only fast tests run against mutants, so code that only slow tests reach
  always gives an inconclusive run. Here that is the hooks, and a
  change touching them could never pass. A mutant that changes nothing
  observable has the same problem: no test can kill it, so the only way past
  it would be a comment that switches the tool off there.

  What the other new values take:

  - Coverage with `onFailure: report`. Three places assume that coverage
    which did not fail is at or above every minimum, and refuse otherwise:
    `validateResult` and `validateCoverageMeasurement` in
    `src/workflow/result-format.mjs`, and `coverageAnalysis` in
    `src/workflow/coverage.mjs`, which reads a saved analysis only when its
    outcome is clean. All three have to accept findings that were only
    reported, or the touched-line figures cannot be read on such a pass.
  - Coverage with `runs: oncePerPlan`. Coverage is measured on the first pass
    and reused, so tests written afterwards do not move it, and the
    uncovered touched lines shown at `record` are the first pass's.
  - Coverage with `skipInCi: true`. CI no longer holds the folder minimums.
    Only the local hooks do.
  - Mutation with `runs: always`. It runs on every verify, for its whole
    time limit each time.

  The instructions say "Coverage cannot skip CI", and the README's Checks
  table gives `always` and `block` as every check's defaults without saying
  mutation's differ. Reword both when this lands. Named 2026-11-10, in the
  review of the logbook and the rulebook before v1.

- **Coverage misses code that tests start as a separate process.** Coverage
  is the share of the code's lines and branches that some test runs. Code
  that tests reach only through another process, such as hooks and
  command-line scripts started as programs, or an app reached over HTTP,
  scores near 0% however well it is tested. So its minimum says little, and
  a fall in its real coverage would not show. Mutation testing has the same
  blind spot: most of step 5's mutants, 378 of 467, were "reached by no fast
  test" for this reason.
  - **Follow child processes.** Not tried: set `NODE_V8_COVERAGE` for the
    processes the tests start and merge what they write into the report. It
    belongs to the language adapter, which writes the report.
  - **Vitest's own way gave figures that do not add up.**
    `coverage.autoAttachSubprocess`, tried on 2026-10-11, lifted
    `src/workflow/` from 61.4% to 88.0% of lines. It also lowered
    `src/requirements/` from 87.1% to 72.2% of branches in a run where
    nothing else changed. A setting that takes coverage away from a folder
    cannot be the basis of a minimum until that is understood.
  - **The cost to `verify`.** Coverage added about two seconds to a 42-second
    suite on 2026-10-11. Measure again if child processes are followed.

- **A coverage minimum does not rise by itself.** When coverage goes up, the
  check prints the new figure beside the old minimum and passes. Raising the
  minimum is the operator's hand edit to the rulebook, which no session may
  write, so the gain can be lost again without anything failing. A ratchet
  would fail when a figure is above its minimum, and ask the operator to
  raise it. A covered line only ran; nothing says anything was asserted about
  it, so a ratchet guards against untested code, and mutation testing guards
  against weak tests. Raised by the operator 2026-10-10.

- **Check a new test fails on the old code.** Run each test written in
  `converging` against the baseline code. A new test that passes on the old
  code proves nothing about the change. This needs no mutation tool, only the
  baseline the logbook already pins. One weakness: a test can fail there
  because an import is missing, which says little.

- **Report two Stryker 10 bugs upstream.** Both have workarounds in
  `src/adapters/typescript/stryker.ts`. Its tsconfig step needs
  TypeScript's JavaScript API, which TypeScript 7 lacks. Its Vitest runner
  skipped every test inside a `describe` under Vitest 5 and called the mutant
  a survivor. Neither is reported upstream yet.

## Toolchain

- **Move the evidence tools off TypeScript 6.**
  `src/adapters/typescript/vitest-junit-reporter.ts` parses test files with
  TypeScript's JavaScript API. TypeScript 7 no longer exports it, so it imports
  TypeScript 6.0.3 under the name `typescript-api` while `tsc` uses 7.
  TypeScript 7's own API is published only as `typescript/unstable/*`. Once it
  is stable, move the reporter to it and drop the alias. Until then, a TypeScript 7 syntax feature
  that 6 cannot parse would be misread by the triage. Named 2026-10-01.

- **Restore TypeScript dependency analysis in the boundaries check.**
  During step 27, `npm run boundaries` passed with a
  `missing-typescript-transpiler` warning: dependency-cruiser supports
  TypeScript below 7 and may miss this project's TypeScript dependencies.
  Check whether its compiler integration can use the existing `typescript-api`
  alias, or update it when TypeScript 7 is supported. Keep the boundary rules
  and their tests intact. Raised 2026-11-02.

- **Make the release tarball reproducible across machines.** Two builds of one
  commit on one machine give the same bytes, because npm pins every file's
  date and mode. Across machines, a different npm or zlib can compress the
  same files differently, so nobody can rebuild a release from source and
  match its hash. Pin Node and npm in `.github/workflows/build.yml`, and have
  the job build twice and fail when the hashes differ. Raised 2026-11-27.

## Open questions

Questions to settle before anything is built. Each becomes a task above once
it is decided.

- **Does Codex need a separate file for each stage of plan approval?**
  The adapter saves the presented plan for the format check and writes a new
  working file when the operator approves. From step 32b onward, the referee
  also saves the approved bytes for triage and risk. When the text is unchanged,
  all three files can contain the same plan. Could we keep fewer copies while
  still capturing approval edits, warning about later edits to the working file,
  and preserving the exact bytes of each approval? Raised 2026-11-03.

- **Should any check report a confidence, not only a verdict?** Every check
  today answers yes or no: a test was predicted or not, a failure is in one
  bucket or another, the risk is HIGH or not. Some of those answers are
  estimates. The plan's list of tests it expects to reach is a guess, and the
  triage's buckets rest on a dependency graph that can miss a link. The 3a
  triage, which reported 0 failures while one file could not load, gave a
  confident answer that was wrong, and nothing in its output said how sure it
  was. The question is whether a probability or a confidence level would help,
  for example "these 12 tests are reached, and the graph may be incomplete for
  these 2 files". It must not become a way to soften a failing check: a
  red test stays red whatever its confidence. Decide first which checks are
  estimates and which are facts, because only estimates can carry a confidence.
  Raised by the operator 2026-09-24.
- **Should the triage allow a second run after fixing test compile errors?**
  In a static language such as Java, Rust or C#, a compile error in one test
  file can stop that file from running, or the whole suite. The triage then
  reports every test in it as failed, which says little about what the change
  really broke. The idea: when the only errors are in test files, the agent
  fixes just those errors and runs the triage once more, and the second report
  is the one the buckets come from. Questions to settle: how the referee checks
  that the fix touched nothing but the compile errors, whether the first report
  is kept beside the second, and whether this weakens the freeze, which exists
  so that no test is edited before anyone has seen what broke. Until then the
  default stands: a test that does not compile is a failed test, and a run that
  never started fails every test file. Raised by the operator 2026-10-31.
- **Snapshot the output of every verify step.** The referee's own steps
  (`req:lint`, `req:guard`, `state:verify`, `req:trace`) print their errors
  to the console, and a `verify_failed` event keeps only a shared 20-line
  `tail` of them. Configured checks already save their output as a raw
  snapshot the event links. Do the same for every step, so a failure's
  details can always be read from the event: the "still fails" repeat at turn
  end rebuilds the summary from the event alone. Until then the verification
  summary shows those steps' details from the tail. Raised by the operator
  2026-11-06, planning 32i.3.
