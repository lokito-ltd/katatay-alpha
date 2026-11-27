# <img src="docs/katatay-header.png" alt="Katatay" width="100%">

> **Alpha.** This is an alpha release, built to test the concept. Expect rough
> edges and breaking changes between releases. Read
> [Known limits](#known-limits) before you rely on it.

Katatay holds a coding agent to the way a careful engineer works: a plan you
approve first, tests that prove the change, and a record you can review.

Katatay allows you to focus on "What" with a high confidence that "How" will
be delivered with a quality level of your choosing.

Coding agents such as Claude Code, Codex and Cursor write code fast. They also skip
steps when nobody is watching. They edit a test until it passes, call a change
done while the suite is red, drop a requirement that got in the way, or say
"I ran the tests" when they did not. Asking them to behave in a prompt works
until it does not.

Katatay puts a **referee** between the agent and your repository. Hooks in the
agent ask it before every file write and shell command, and at the end of every
turn. The referee answers from the state of the change and the results of
the checks it ran. Nothing the agent writes in the chat changes the answer.

See [What you get](#what-you-get) for what this gives you,
[How a change runs](#how-a-change-runs) for the steps every change goes
through, and [Features](#features) for how each part works.

## 3 easy steps to get you running with Katatay

1. **Install Katatay.** In a terminal:

   ```sh
   url="https://github.com/lokito-ltd/katatay-alpha/releases/latest/download/katatay.tgz"
   npm install -g --foreground-scripts --allow-scripts="$url" "$url"
   ktty version
   ```

   See [Install](#install) for what this does and what you need.

2. **Set up your project.** Open a new Claude Code or Codex session in your
   project and ask:

   > Use the ktty-init skill to set up Katatay in this project.

   See [Set up a project](#set-up-a-project).

3. **Start adding requirements.** On a new Git branch, tell the agent what
   your product should do:

   > Add a requirement: a customer can cancel an order until it ships.

   See [Your first requirement](#your-first-requirement).

## What you get

- **You approve the plan before any code is written.** The agent says what it
  will change and which tests it expects to break. Your approval is recorded
  against the exact text you read.
- **The agent cannot bend the tests to fit its code.** Tests are frozen while
  the implementation is written. They open only after a triage of what broke.
- **"Done" means verified.** At the end of the turn the referee runs your
  compiler, tests, coverage and checks itself. A passing claim in the chat
  counts for nothing.
- **Tests that test something.** Coverage and mutation testing run on the
  lines this change touched, so you see which new code no test runs, and which
  planted bugs no test catches.
- **Requirements that cannot quietly shrink.** Each requirement is proved by a
  test that names it. Weakening or deleting one needs your approval.
- **Behaviour driven incremental changes.** Each change is delivered in a 
  separate branch, and goes through the same rigourous process. Part of the 
  rigour is also focus on delivering smaller and easier to comprehend changes.
- **A review that starts in the right place.** Each change ends with a report,
  a change file and a list of the files you must read yourself.
- **Any language, two agents.** The referee reads JUnit, LCOV and the Stryker
  mutation report format, which most test tools can write. Claude Code and
  Codex are supported today.

## Install

You need Node.js 22.12 or later, and Git. Katatay is tested on Node.js 24 and
later. The command is `ktty`.

Install from a GitHub Release:

```sh
url="https://github.com/lokito-ltd/katatay-alpha/releases/latest/download/katatay.tgz"
npm install -g --foreground-scripts --allow-scripts="$url" "$url"
ktty version
```

What each line does:

- The first line names the latest release's tarball on GitHub.
- The second installs it as a global npm package, which gives you the `ktty`
  command. `--allow-scripts` lets this one package run its install script,
  and `--foreground-scripts` shows you what that script prints.
- `ktty version` checks it worked. It prints the Katatay release and the
  rulebook schema version.

The install script copies the setup skill, **ktty-init**, into the Claude Code
and Codex user skill folders, so both agents can find it. It respects
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`. If a different `ktty-init` skill is
already there, the installer says where and keeps that file.

Two things to check:

- **Your user owns npm's global folder.** `npm prefix -g` prints it. If
  installing needs `sudo`, point npm at a folder in your home directory
  first, for example with `npm config set prefix ~/.npm-global`.
- **`ktty` is on `PATH` for your shell and for both agents.** The agents'
  hooks call `ktty`, so the agents must find it too. The command lives in the
  `bin` folder inside the npm prefix.

### Installing from a file

To install a tarball you built or downloaded, give npm its **absolute** path.
npm 11 reads a relative path such as `dist/katatay-0.2.0.tgz` as a Git
repository and fails. Replace `<version>` with the version in the file's name:

```sh
archive="$PWD/dist/katatay-<version>.tgz"
npm install -g --foreground-scripts --allow-scripts="file:$archive" "$archive"
```

### Checking a download

Every release tarball is signed by the GitHub workflow that built it, so you
can check that a file came from this repository's build and was not changed
since. With the GitHub CLI:

```sh
curl -sSfLO https://github.com/lokito-ltd/katatay-alpha/releases/latest/download/katatay.tgz
gh attestation verify katatay.tgz --repo lokito-ltd/katatay-alpha
```

It prints the commit and the workflow that built the file, and fails for a file
built anywhere else. Then install the file as above. Each change merged into
`main` is built and signed the same way; its tarball is on the build
workflow's run. Release 0.1.0 was built by hand and has no signature.

### Finding the installed files

`ktty path` prints the absolute folder the package is installed in, on one
line with no trailing slash, so a project can name the files it ships, such as
`"$(ktty path)/src/adapters/typescript/vitest-junit-reporter.js"`.

### Another checkout or machine

To use a set-up project in a new checkout or on another machine, install the
same release there and put `ktty` on the agents' `PATH`.

## Set up a project

Open a **new** Claude Code or Codex session in your project's Git folder. It
must be a new session, because agents load skills when a session starts. Then
ask it to use the **ktty-init** skill. The skill does the setup with you:

1. It reads your project and asks about your tools: the language, how you
   compile, run tests, measure coverage and run any other checks.
2. It proves each check works, with a passing and a failing example, so a
   check that can never fail is caught now.
3. It runs `ktty init`, which writes the **rulebook**
   (`.katatay/rulebook.json`, the file holding your commands and limits), the
   requirements folder, and the agent's hooks and instructions.
4. It shows you the steps only you can do, including trusting the hooks.

When it finishes, run `ktty verify` in the project. It runs every check the
way the referee will, so you start from a clean result.

From then on the project is guarded: the agent cannot write files until you
approve a plan.

To set up by hand, run `ktty init` in a terminal, or `ktty init --questions`
to see the settings.

### TypeScript projects

The TypeScript adapter ships in the package, and runs from the install with
the project's own tools:

- The JUnit reporter needs the TypeScript compiler API, version 6 or earlier,
  installed as `typescript-api` or `typescript`. TypeScript 7 alone is not
  enough: `npm install --save-dev typescript-api@npm:typescript@^6`.
- Mutation testing needs the project's own Stryker 10 packages
  (`@stryker-mutator/core`, `api` and `vitest-runner`). The command is
  `node "$(ktty path)/src/adapters/typescript/stryker-mutate.js" --vitest-config <config>`.

## Your first requirement

A **requirement** is one sentence about how your product behaves, such as
"A customer can cancel an order until it ships". Under it sit
**scenarios**: single cases, each proved by a test that has the scenario's
text as its name. The referee checks that every requirement has its tests, and
that none is weakened without your approval.

Each change runs on its own Git branch, and a plan on the target branch is
refused. So make a branch first:

```sh
git switch -c order-cancellation
```

Then tell the agent what you want, in plain words:

> Add a requirement: a customer can cancel an order until it ships.

The agent writes the requirement and a plan for building it. You read the plan
and approve it, or send it back. From there the referee takes the change
through the steps in [How a change runs](#how-a-change-runs). The requirement
lands in `requirements/acceptance/`, and looks like this:

```markdown
---
status: accepted
---

A customer can cancel an order until it ships.

## Scenarios

- [AC0001.1] A cancelled order is not shipped.
- [AC0001.2] An order that has shipped cannot be cancelled.
```

See [Requirements as living documentation](#requirements-as-living-documentation)
for how requirements and their tests stay in step.

## How a change runs

Every change goes through the same five steps, in order. The referee tracks
which step a change is in, called its **phase**, and allows only what that
phase allows.

1. **Plan.** The agent reads the code and writes a plan: why, what, how, the
   requirements it touches, the tests it expects to fail, and the tests it
   will add. You approve it, or send it back.
2. **Implement.** The agent writes the code. Every test and test helper stays
   exactly as it was at the start of the change.
3. **Triage.** The referee runs the whole suite and sorts each failure into
   predicted or surprise. Then the tests open for editing, and the
   implementation freezes instead.
4. **Verify.** At the end of the agent's turn, the referee runs every check
   and records the result. A failure goes back to the agent with the output.
5. **Record.** You type `record`. The agent writes the change file, the
   referee checks it, and the change is staged with a commit message for you
   to approve.

You are the **operator**: the only one who approves a plan, types `record` or
`reset`, edits the rulebook, commits and merges. The agent decides the
implementation details inside the scope you approved.

## Features

### A plan you approve, word for word

The plan uses six fixed sections, so every plan answers the same questions.
It ends with a small YAML block holding the parts the referee checks: the
exact text of each requirement the change adds, rewords or retires, and the
list of tests expected to fail.

Your approval in the agent's plan dialog is recorded against the text you
approved, edits included. If the plan changes later, the agent must ask for a
revision and you approve it again. A plan you reject records nothing.

### Frozen tests

While the implementation is written, every test and support file must match
its contents at the start of the change. Triage and the end of the turn both
check this. So the agent cannot make a red test green by changing the test.

After triage the freeze flips: tests open, and the implementation is pinned
to a fingerprint. A fix to the code at that point needs a revised plan. This
keeps "fix the code" and "fix the tests" as two separate, visible decisions.

### Triage that measures the plan

`ktty triage` runs the suite before anything is fixed and compares the
failures with the plan's predictions:

- A **surprise** is a test that broke but was not predicted. It means the
  change reaches further than the agent thought.
- An **over-prediction** is a predicted test that passed. Either the change
  did not do what the agent thought, or the test does not test what it says.

Both raise the change's **risk level**, which tells you how well the agent
understood its own change, and when to stop it.

### Verification the agent cannot fake

At the end of every turn in the converging phase, the turn-end hook runs
`ktty verify` itself:

- the requirements catalogue and its traces
- the logbook, linked and matching git
- the compiler, with each error tied to a file and line
- the whole test suite, read from its JUnit report
- coverage, read from LCOV
- the rulebook's own checks, such as lint, a security scan or a build

A pass records `verified`; a failure records `verify_failed` and hands the
agent the tail of the output. The result lives in the logbook. A sentence in
the chat saying "all tests pass" proves nothing, and the workflow tells the
agent never to claim it.

### Coverage and mutation on the lines you changed

Coverage has per-folder minimums for lines and branches in the rulebook.
Excluding a file in the test runner's config fails the check. A new coverage
ignore comment puts the file on the reviewer's list. Each pass also lists the
touched lines that no test runs.

Mutation testing plants small bugs, called **mutants**, in the lines this
change touched, and runs the fast tests against each one. A mutant that no
test catches **survived**: some behaviour of the new code is not checked by
any assertion. Only touched lines are mutated, so a run stays short and every
survivor belongs to this change. A passing run is reused
until the plan, rulebook or baseline changes.

### Requirements as living documentation

The requirements folder holds acceptance criteria and invariants. Each
criterion lists scenarios, each with an id, and each scenario is proved by a
test titled with its text and id:

```js
it('A rejected proposal is not in the catalogue. [AC0001.1]', () => { ... });
```

`ktty req trace` fails when a requirement has no test, or a title and its
scenario disagree. `ktty req guard` fails when a requirement is weakened,
deleted or added without your approval. A requirement leaves only as
`superseded` or `withdrawn`, with a change file saying why. A skipped test, a
todo test or a test expected to fail does not count as evidence.

### A record you can review

When you type `record`, the referee writes a report: what changed, the
uncovered lines, the surviving mutants, and the review areas. The agent then
writes a **change file** that opens with that report word for word, says how
the outcome differed from the plan, and states each requirement the change
leaves behind. Change files are committed and append-only, so the history of
every requirement stays readable.

The review areas, called "Must look", list the files you should read whatever
the tests say: the rulebook, every requirement the change edits, every file
on the rulebook's high-risk list with its reason, and every file that gained a
comment silencing a check, such as `eslint-disable`.

### An append-only logbook in git

Each change has a logbook under `.katatay/state/<branch>/`: one committed
file per event, each linked to the one before. A missing or edited event
breaks the chain, and everything stops until you look. The phase is computed
from the logbook, so it survives a restart, a new session or another
machine. In CI, `ktty state verify` checks the chain and that every baseline
is on the target branch.

### Locks on what does the watching

The hooks refuse writes to the rulebook, the logbook, the agent's own
settings and hooks, and `.git/`. When a change needs one of those files, the
agent prepares a patch for you to apply. The rulebook is the one file that
sets the target branch, the coverage minimums, the high-risk files and the
checks, and no session can edit it.

The agent adapter also warns, every turn, about settings it cannot lock: a
hook registered elsewhere that could answer the plan dialog for you,
`disableAllHooks`, or an `env` entry such as `CI`.

### Your tools, any language

The referee never runs or names a language tool. It runs the commands the
rulebook gives and reads the files they write:

- **JUnit XML** for test results
- **LCOV** for coverage
- the **Stryker mutation report** format for mutation results
- exit codes, mapped in the rulebook to clean, findings or broken, for every
  other check

Most test tools can already write these formats. A check whose exit code is
not in the map, or that crashes or runs past its time limit, counts as broken
and fails verify. It never reads as clean.

### Three agents, one referee

Claude Code, Codex and Cursor each have an adapter that turns the referee's answers
into the agent's hook replies, and installs the workflow's instructions and
skills where that agent reads them. The skills help the agent plan a change,
write acceptance criteria and write the commit message.

## Known limits

This alpha tests whether the workflow can hold a coding agent to a plan the
operator approved. It does not yet protect everything a finished product
would.

- **A session can edit the installed referee.** `ktty` installs into the
  operator's own global npm folder, and the agent runs as the same user. A
  session could rewrite the referee, record evidence it never earned, and put
  the files back. Only a reviewer reading the diff, and CI, stand in the way.
  The planned fix is an install owned by root.
- **Three agents.** Claude Code, Codex and Cursor. Each needs its hooks
  registered and trusted. An agent without the hooks is not held at all.
  Cursor's adapter relies on two things Cursor does not document: the prompt
  hook's context reaching the agent, and the wording of the prompt Build
  sends. Both were captured under Cursor 3.32.10.
- **One language adapter.** TypeScript, with Vitest, Stryker and the
  TypeScript 6 compiler API. Another language needs its own commands that
  write JUnit, LCOV and a standard mutation report, and none has been tried
  yet.
- **Mutation needs a tool that can target lines.** The referee asks for
  mutants only in the lines a change touched. Stryker can do that. Most other
  tools mutate whole functions or files, and their extra findings would read
  as the change's.
- **Coverage misses code that tests start as a separate process.** Hooks and
  command-line scripts that tests run as programs score near 0%, however well
  they are tested.
- **Verify must fit in the agent's hook time limit.** Verify runs inside the
  turn-end hook. If the agent kills the hook, no result is recorded and no
  message is shown, and the next turn starts the same work again.
- **Platforms.** Tested on macOS and Linux with Node.js 24. Node.js 22.12 is
  declared but not tested, and Windows is not tested.

## Develop Katatay

This repository is the harness's source, and it is guarded by the harness
itself. `CLAUDE.md` holds what is true only of this repository; read it before
changing anything. `src/VISION.md` explains the design.

You need:

- Node.js 24 or later, and Git. CI runs on Node.js 24 (`node-version` in
  `.github/workflows/verify.yml`). The package still declares 22.12, but
  nothing tests it there.
- **gitleaks 8.30.1**, for the secret scan. It is a single binary, not an npm
  package: `brew install gitleaks`, or the release binary from
  <https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1>. CI pins the same
  version in `.github/workflows/verify.yml`; keep the two the same.

Then:

```sh
npm ci
npm test             # every test; writes reports/junit/ and coverage/
npm run test:fast    # the fast tests only, for quick checks while working
npm run typecheck
npm run boundaries   # module boundaries (dependency-cruiser)
npm run secrets      # gitleaks over the working tree: 0 clean, 2 findings
npm run verify       # everything CI's verify jobs run
npm run pack:katatay # builds dist/katatay-<version>.tgz
```

Without gitleaks, `npm run secrets` exits 127, and `verify` fails until it is
installed.

## Licence

Apache 2.0. See `LICENSE`.
