import { availableParallelism } from 'node:os';
import { escapePath, globSync } from 'tinyglobby';
import { matchesTests, matchesSlow } from './src/workflow/adapter.mjs';
import { defineConfig } from 'vitest/config';

/**
 * `includeTaskLocation` makes every test report the line it starts on. The
 * triage needs it to tell which test a type error sits inside: a test file
 * that no longer compiles is a failing test, and `src/evidence/typecheck.ts`
 * maps each error to the test it belongs to by position.
 *
 * The rulebook selects the files for the fast and slow runs.
 *
 * Coverage is the share of the code's lines and branches that some test runs.
 * It is measured over `src/`, and written to `coverage/lcov.info` as an lcov
 * report, the file the rulebook's `language.coverage.report` names. The
 * referee reads it and `npm run coverage:check` compares it with the minimums
 * in `.katatay/rulebook.json`. lcov and not a summary, because only the full
 * report says which lines no test ran.
 *
 * `include` names every file in that folder, so a file no test loads is
 * counted at 0% instead of being left out of the figure.
 *
 * `exclude` holds only what is not code: tests, and the JSON, CSS, SQL and
 * Markdown that can sit beside the code. The Markdown also fails to parse.
 * Nothing is excluded for scoring low. The hooks in
 * `src/agents/claude/hooks/` score near 0%, because tests run them in a separate
 * process, where coverage cannot see. They stay in with their real figure. An
 * entry added here takes code out of the figure, which is a way to keep it
 * high by measuring less, so this file is a guardrail path and
 * `tests/integration/vitest.config.test.ts` fails when a code file stops being measured.
 *
 * It is not switched on here. `npm test`, the rulebook's test command, passes
 * `--coverage` to the run of the fast tests (`test:run:fast` in
 * `package.json`) and not to the slow run after it (`test:run:slow`). `test:fast` runs one
 * project, and either would otherwise overwrite the report with the figures
 * of a different run. Vitest empties `coverage/` when a coverage run starts and writes no
 * report when a test fails, so the report the check reads is always the last
 * full run's.
 */
const ignored = ['**/node_modules/**', '**/.git/**', '.stryker-tmp/**', 'coverage/**', 'reports/**', 'dist/**'];
// Feed Vitest literal paths so its glob dialect cannot reinterpret the
// rulebook. Escaping matters for paths with brackets, such as routes/[id].
const files = globSync('**/*', { dot: true, followSymbolicLinks: false, ignore: ignored })
  .filter((file) => matchesTests(file));
const projects = { fast: [] as string[], slow: [] as string[] };
for (const file of files) projects[matchesSlow(file) ? 'slow' : 'fast'].push(escapePath(file));

export default defineConfig({
  test: {
    includeTaskLocation: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['**/*.test.*', '**/*.json', '**/*.css', '**/*.sql', '**/*.md'],
      reporter: ['lcovonly'],
      reportsDirectory: 'coverage',
    },
    projects: (['fast', 'slow'] as const).map((name) => ({
      test: {
        name,
        include: projects[name],
        // The slow process tests run on at most 60% of the CPUs. Each one
        // starts the hooks and verify as programs, and each of those runs
        // git many times, so a file keeps more than one core busy. Vitest's
        // default, one file fewer than the CPU count, oversubscribed the
        // machine: on 2026-11-09, with 10 cores, the whole slow run took
        // 209s at 9 workers and timed out a test past its 30 seconds, a
        // different test from run to run. At 6 it took 193s and nothing
        // failed; at 4, 273s; at 2, 535s; one at a time, 964s. The two
        // slowest tests take about 19 seconds even alone. A computed number
        // rather than '60%', so nothing depends on how Vitest resolves a
        // percentage in a project. Vitest needs a different `groupOrder` for
        // projects whose `maxWorkers` differ, which `fast` and `slow` do.
        // Files within each project still run in parallel.
        ...(name === 'slow'
          ? { sequence: { groupOrder: 1 }, maxWorkers: Math.max(1, Math.floor(availableParallelism() * 0.6)) }
          : {}),
        // Runs every test as if outside CI, whatever the runner sets, and
        // fails any test that writes git's `fatal:` line to stderr. See
        // each file for why.
        setupFiles: ['tests/support/outside-ci.ts', 'tests/support/fail-on-git-stderr.ts'],
        testTimeout: 30_000,
        // Patience for setup on a busy machine: with the suite's workers all
        // starting at once, a `beforeAll` ran past Vitest's default of 10
        // seconds, and verify failed on tests that pass alone (2026-10-16 and
        // 2026-10-20). A setup that hangs still fails, 20 seconds later.
        hookTimeout: 30_000,
      },
    })),
  },
});
