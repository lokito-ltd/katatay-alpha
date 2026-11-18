# The TypeScript adapter

The language adapter for TypeScript with Vitest and Stryker. It is two
programs a project names in its rulebook and its test command: a Vitest
reporter that writes the JUnit report, and a mutation wrapper around Stryker.
`../README.md` is the contract they keep. This file says what each one adds
and how a project wires it in.

The adapter ships in the `ktty` package. A project that uses the global
install names the files under `$(ktty path)/src/adapters/typescript/`, where
the TypeScript is compiled to `.js`. In this repository the test command and
the rulebook name the `.ts` sources.

Both programs load Stryker and TypeScript from the project they run in, not
from Katatay's own folder, so the project's own versions run: see
`project-modules.mjs`.

## The reporter

`vitest-junit-reporter.ts` is a Vitest reporter that writes the report itself.
It emits `inverted` as true or false on every case. Vitest's own JUnit reporter
writes the tests a failing `beforeAll` kept from running as passed, and a file
that fails to load as one failure with no tags. This one writes a test that
did not run as skipped, and leaves a file that failed outside every test out of
the report, so the referee fails the whole file with every tag in it.

The project's test command passes it to Vitest with `--reporter`, and names
the file it writes in the `JUNIT_REPORT` environment variable, once per run.
Here:

```bash
JUNIT_REPORT=reports/junit/fast.xml vitest run --project='fast*' --coverage \
  --reporter=default --reporter=./src/adapters/typescript/vitest-junit-reporter.ts
```

The rulebook's `tests.run.reportPaths` then selects the files it writes, such
as `reports/junit/*.xml`.

## The mutation wrapper

`stryker-mutate.ts` is the rulebook's mutation command. It reads the referee's
question on stdin, runs Stryker over Vitest on the lines it names, prints what
it found, and exits as "Mutation" in `../README.md` describes.

Its text gives the counts, the mutants skipped and why, and each survivor by
file and line. Its `--report-file <path>` option defaults to
`reports/mutation/mutation.json`. Configure the same path in the rulebook's
`checks.testQuality.mutation.output`. It enables Stryker's JSON reporter
alongside the progress journal. At the time limit it stops the workers, then
publishes completed journal results in the standard schema. A no-tests result
writes an empty report and exits 2.

`--vitest-config <path>` is required. It names the project's Vitest config for
mutation runs, because which tests a run uses is the project's call. List that
config in the rulebook's `highRisk` and in
`checks.testQuality.mutation.excludePaths`. Here:

```bash
npx tsx src/adapters/typescript/stryker-mutate.ts --vitest-config vitest.mutate.config.ts
```

`process-only.ts` helps a project's mutation config leave out tests that reach
the code only through processes they start. Stryker switches a mutant on
inside the test worker, so a separate process never sees it, and such a test
costs its whole time in Stryker's first pass for nothing. This repository's
`vitest.mutate.config.ts` uses it.

The other files are the wrapper's parts:

| File | What it does |
|---|---|
| `stryker.ts` | Runs Stryker on the named lines and turns the result into text and an exit code. |
| `stryker-process.ts`, `stryker-child.mjs` | Run Stryker as its own process tree, so the wrapper can stop it at the budget and wait for its workers before deleting its folder. |
| `stryker-report.ts` | Writes a run stopped at its budget in the standard report schema, from the progress journal. |
| `mutate-plugins.mjs`, `progress.mjs` | The Stryker plugins: the Vitest runner with its test filter fixed for Vitest 5, an ignorer for inline styles, and a reporter that writes each result as it lands. |
| `project-modules.mjs` | Loads Stryker and TypeScript from the project. |
