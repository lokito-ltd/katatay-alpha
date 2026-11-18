import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { readAdapter } from './src/workflow/adapter.mjs';
import { processOnlyTests, type Layout } from './src/adapters/typescript/process-only';

/**
 * The Vitest config this project's mutation runs use: the `fast` project of
 * `vitest.config.ts`, alone, less the tests a mutant cannot reach. The
 * rulebook's mutation command names it as `--vitest-config`, so which tests a
 * run uses is this project's call, kept in this project, and not the
 * TypeScript adapter's.
 *
 * Fast only, as the rulebook's test categories define it: `vitest.config.ts`
 * builds the `fast` project from the files the rulebook's `slow` globs leave
 * out. The end-to-end tests need a real browser and a real server for every
 * mutant, and reach `app/` over HTTP, where Stryker cannot tell which test
 * reached which line.
 *
 * Built from the base config rather than copied, so the two cannot drift: a
 * test file added to `fast` is one Stryker can run too.
 */
const fast = base.test?.projects?.find(
  (project): project is { test: { name: string } } =>
    typeof project === 'object' && project !== null && 'test' in project && project.test?.name === 'fast',
);
if (fast === undefined) throw new Error('vitest.config.ts has no project named fast, so there is nothing for Stryker to run.');

/**
 * Left out of mutation runs, and only of them: tests that need this
 * repository's own git, which Stryker's sandbox cannot give them. It copies
 * the code into the ignored `.stryker-tmp/` and never copies `.git`, so git
 * finds the repository but lists no file in that folder. Run in a copy laid out
 * like a sandbox on 2026-10-18, this was the one file of the fast project that
 * failed. It checks what the coverage config measures across the whole
 * repository, which no single change's mutants could tell it, and one failing
 * test in Stryker's first pass stops the whole run. `npm test` still runs it.
 */
export const NEEDS_THE_REPOSITORY = ['tests/integration/vitest.config.test.ts'];

/**
 * Where this project's tests and their support are, for the process-only rule
 * in `src/adapters/typescript/process-only.ts`: the tests the rulebook
 * names, and as support the machine suite's harness and helpers beside its
 * tests, and anything in a `fixtures/` folder.
 *
 * The journeys in `tests/machine/` drive the workflow through
 * each hook, each moment and `state:show`, as processes, so no mutant can
 * reach them. On 2026-10-22 they took Stryker's first pass past 240 seconds on
 * a change to `src/workflow/`. Leaving them out was the first fix, but it
 * looked only in `machine/`. On 2026-10-30 the run for step 17 still stopped
 * at its limit after 39 of 141 mutants, with the Codex journey and other
 * process tests in other folders still running. So every test file in the
 * repository is sorted the same way now.
 *
 * What is given up: the harness appends events and reads the hook
 * registration in process, so a mutant in `chain.mjs` or `registration.mjs`
 * could break a fixture and be caught by a machine test. Both have tests of
 * their own, which stay in.
 */
export const LAYOUT: Layout = {
  tests: readAdapter().tests.all,
  support: ['tests/support/machine/*', 'tests/support/workflow/**', '**/fixtures/**'],
};

export default defineConfig({
  test: {
    ...base.test,
    projects: undefined,
    ...fast.test,
    name: undefined,
    exclude: [...(fast.test as { exclude?: string[] }).exclude ?? [], ...NEEDS_THE_REPOSITORY, ...processOnlyTests(LAYOUT)],
  },
});
