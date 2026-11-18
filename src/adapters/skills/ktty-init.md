---
name: ktty-init
description: Set a project up for Katatay, new or existing, in any language. Use when the operator asks to initialise, install or set up the harness in a project. Interviews the operator about the language and tools, builds the commands the harness will run, proves each one passes and fails as it should, then runs init.
---

# Setting a project up for Katatay

The harness checks every change with commands the project names: a compile
step, a test run, coverage, mutation testing and any other checks. It knows no
language. Your job is to find those commands with the operator, prove they
work, and hand them to `ktty init`, which writes them into the rulebook.

Do everything in the order below. **Once `init` has written the rulebook, the
project is guarded: no file can be written until a plan is approved, and the
rulebook can never be written by a session.** So every file the setup needs
is written before `init`, and every command is proved before `init`.

The operator decides. Ask them, propose defaults from what you find in the
project, and show them every probe result as it is printed.

## 1. Read the project and interview the operator

Read what is there first: the language, the build files, the test folders,
the CI configuration, the scripts people already run. Then ask the operator,
proposing what you found:

- Which language, and which compiler or type checker, if any.
- Which test runner, and where test files live.
- Which tests are acceptance tests, the ones that prove requirements, and
  which are slow.
- Whether coverage is measured, with which tool, and the minimum for each
  folder.
- Whether mutation testing is run, and with which tool.
- Which other checks verify should run, such as a lint, a security scan or
  the build.
- Which branch changes merge into, and which files are high-risk.

Run `ktty init --questions` to see every question `init` asks, as JSON,
with each answer's shape and default. Your interview has to end in an answer
for each required one.

## 2. Make sure there is a repository and something to test

- If the folder is not a git repository, ask the operator, then run
  `git init`. The probe asks git which files are the project's.
- **In an empty project**, write a hello-world program with one passing test,
  in the layout the operator chose. The harness cannot be set up on a project
  with no test, because an unproved test command is the commonest way a setup
  goes wrong. This program stays: it is the project's first code.
- **In an existing project**, the suite must be green before you start. If it
  is not, stop and tell the operator. Then add one small scratch module and
  its test for the break-it steps in section 5. Keep them through the final
  setup probe, including the probe a fresh install runs.
  Never plant a break in the project's real code.

Make sure git ignores every file the commands write: test reports, coverage
output, mutation reports. Add their folders to `.gitignore`.

## 3. Build the commands

Each answer is a command the harness runs from the repository root, through
the shell. What each must do:

**The test run** (`testRun.command`, `testRun.reports`, `testRun.tagComment`).
One command runs every test and writes JUnit XML. Most runners can write it:
`pytest --junitxml=…`, `gotestsum --junitfile …`, `cargo nextest` with a
JUnit profile, Maven Surefire, `dotnet test --logger junit`. The reports must
satisfy this:

- Every file the `tests.all` globs match appears in a report. A file left out
  counts as failed to load. If the runner never collects a file, narrow the
  glob.
- At least one reported test must pass. A suite with only skipped tests
  fails the probe. A passing suite with skips reports both counts.
- Each test case's file must be findable: a `file` attribute on the test case
  or its suite, or a `file` property, as a path from the repository root.
- Optional properties on a test case: `line` and `endLine` (both or neither,
  1-based), `scenario` (a requirement id such as `AC0001.1`, when the test's
  name cannot hold a tag), `inverted` (`true` for a test that passes only
  when its body fails).
- `testRun.tagComment` is a regular expression for a comment line in a test
  file, such as `^\s*//` or `^\s*#`.
- When coverage is on, the test command first deletes the old coverage
  output, so a stale report is never read.

**Compile** (`compile.command`, `compile.pattern`, `compile.exitCodes`). The
compiler or type checker, run over code and tests, or `none`. The pattern is
a regular expression that reads one error from the output, with named groups
`file` and `message`, and `line` where there is one. The exit codes say which
mean `clean`, `errors` and `broken`. A code that means `errors` with no line
the pattern matches is treated as the compiler breaking, and so is `clean`
with a matching line.

**Coverage** (`coverage.command`, `coverage.minimum`). A command that prints
LCOV on stdout, such as `cat coverage/lcov.info`. Every code file under a
measured folder must be in it, at zero if no test loads it: most tools leave
such a file out unless told to include it. Each measured folder gets a
minimum for lines and for branches.

**Mutation** (`mutation.command`, `mutation.report`,
`mutation.timeLimitSeconds`). The command reads a question on stdin as JSON,
`{ "targets": [{ "file", "lines": [start, end] } | { "file" }], "budget", "verbose" }`,
where `budget` is seconds or `null`. It must:

- mutate only the targets, and stop itself at the budget;
- print what it found on stdout, always;
- write the standard mutation testing report (schema version 1 or 2) to the
  report file;
- exit 0 when no mutant survived, 1 when some did, 2 when the run proves
  nothing, such as no test reaching the lines.

Stryker writes the report format itself. Other tools, such as mutmut,
go-mutesting, cargo-mutants or PIT, need a wrapper that turns the question
into the tool's arguments and the tool's results into the report.

**Other checks** (`checks.codeQuality`). An object of check name to
`{ "command", "exitCodes" }`, where the exit codes map each code or range to
`clean`, `findings` or `broken`. Add `"onFailure": "report"` for a check whose
findings should be shown and not fail verify.

**Globs** (`tests.all`, `tests.acceptance`, `tests.slow`, `testSupport`,
`code`). `**` is any number of path segments, `*` anything within one.

## 4. Write wrappers where a tool does not fit

When a tool's output does not meet section 3, write a small wrapper: a
reporter plugin that adds `file` and `line` to each test case, a script that
converts a coverage format to LCOV, a mutation wrapper. Name a wrapper after
the tool it wraps. Keep what is true of the tool in the wrapper, and what is
true of this project in the project's own configuration.

**All glue goes in the project's own repository.** Every wrapper, shim,
plugin, converter script and tool config file is written inside the project,
in a folder the operator agrees to, and is committed with it. Write nothing
into the harness, the operator's home folder or anywhere else on the machine,
and install nothing globally that a command then depends on: add the tool to
the project's own dependencies instead. The project must work the same on
every machine that clones it, and the operator must be able to read every
line that decides what a check reports.

List every wrapper's path, from the project's root, in the `wrappers` answer.
`init` marks them high-risk, because a wrapper decides what the harness sees.
Use regular files. The path must be relative, stay inside the project and
contain no symbolic link below the project root, including in a directory
leading to the wrapper.

## 5. Prove the commands

Write the answers to a JSON file, keyed by question id, and keep it outside
what git tracks or delete it afterwards.

**First, everything passes.** Run `ktty init --probe --answers <file>`.
When mutation is enabled, append `--scratch-module <file>` to this and
every probe command below. Give the project-relative path of the scratch
module (the hello-world source in a new project). It must be a regular file
Git tracks or would track, match the project's code paths, and be eligible
for mutation. The probe sends just that file with the configured budget.
It runs every command and writes nothing. Fix the commands until every item
says `passed`. Show the operator the result.

**Then, each thing can fail.** A command that always exits 0 passes the probe
above and checks nothing. So break one thing at a time, run the probe with
the state that names the break, and put it back. The probe passes only when
it sees exactly that break.

| Break | Run |
|---|---|
| A compile error in the program | `ktty init --probe --expect compile-error-in-code --answers <file>` |
| A compile error in the test | `ktty init --probe --expect compile-error-in-test --answers <file>` |
| An assertion that is false | `ktty init --probe --expect failing-test --answers <file>` |
| A test weakened so a folder falls below its coverage minimum | `ktty init --probe --expect below-minimum --answers <file>` |
| An assertion weakened so a mutant survives | `ktty init --probe --expect survivors --answers <file>` |

Skip a state whose item is off: the two compile states when there is no
compile step, `below-minimum` without coverage, `survivors` without mutation.
The probe refuses those with exit 2. The other checks have no break to
plant: they run in the all-pass probe only.

Show the operator each result. If a state does not pass, the command is
hiding failures: fix the command, not the break.

**Last, everything passes again.** Undo every break. Run the passing probe
once more with the same module and show the result.

## 6. Run init

Run `ktty init --answers <file>`. It runs the probe itself, and writes
the rulebook, the requirements folder and each agent's instructions and hooks
only when every item passes.
For a fresh install with mutation enabled, append the same
`--scratch-module <file>`. After the last probe, have the operator remove
the temporary module and test from an existing project before the setup
commit. Keep a new project's hello-world source and test.

It prints the steps only the operator can take: review the rulebook, add the
remote, trust the hooks, start a new session, commit and push. Pass them on
word for word. Remove the answers file.

From here on the project is guarded, and every change starts with a plan.
