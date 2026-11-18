/**
 * The Stryker plugins the mutation command (`stryker-mutate.ts`) loads: Stryker's Vitest
 * runner with its test filter fixed for Vitest 5, an ignorer that skips inline
 * styles, and a reporter that writes each result as it lands.
 *
 * `.mjs` because Stryker loads a plugin with a plain `import`, which cannot
 * read TypeScript.
 *
 * ## The runner
 *
 * For each mutant, Stryker runs only the tests that reach it, by setting
 * Vitest's `testNamePattern` to their names. It builds a name by joining the
 * `describe` titles and the test title with a space. Vitest 5 matches the
 * pattern against the names joined with ` > `. So no test inside a `describe`
 * matches, every one of them is skipped, none fails, and Stryker reports the
 * mutant as survived. Measured on 2026-10-17 with Stryker 10.0.0 and Vitest
 * 5.0.3: 59 of 62 mutants "survived" with zero tests run. With this fix, 37
 * of the same 62 were caught.
 *
 * The fix widens the pattern so each space in it may also be ` > `. A space in
 * the pattern can only have come from a space in a name, because Stryker
 * escapes every other character that means something in a regular expression,
 * and leaves spaces alone. Widening can only add tests to a run, never remove
 * one, so at worst a mutant is checked by a test or two more than it needed.
 *
 * Everything else is Stryker's own runner, unchanged. Delete this file when a
 * Stryker release matches Vitest 5's names, and point `testRunner` in
 * `stryker.ts` back at `vitest`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { importFromProject } from './project-modules.mjs';
import { PROGRESS } from './progress.mjs';

// The project's own Stryker packages, not ones beside this file: see
// `project-modules.mjs`. Stryker's workers run in a sandbox inside the
// project, and the lookup from there reaches the project's packages too.
const { declareClassPlugin, declareFactoryPlugin, PluginKind } = await importFromProject('@stryker-mutator/api/plugin');
const { strykerPlugins: upstream, strykerValidationSchema } = await importFromProject('@stryker-mutator/vitest-runner');

/** Lets a space in `pattern` also match Vitest 5's ` > ` between names. */
export function widen(pattern) {
  return pattern instanceof RegExp ? new RegExp(pattern.source.replaceAll(' ', '(?: | > )'), pattern.flags) : pattern;
}

/**
 * Makes every pattern Stryker sets on `config.testNamePattern` the widened one.
 * The runner sets it afresh before each mutant's run, so the setter is the one
 * place that sees each pattern on its way in.
 */
export function widenNameFilter(config) {
  let pattern = widen(config.testNamePattern);
  Object.defineProperty(config, 'testNamePattern', {
    configurable: true,
    enumerable: true,
    get: () => pattern,
    set: (value) => { pattern = widen(value); },
  });
}

/**
 * Puts a project back in Vitest's default pool, where each test file runs in
 * a child process. Stryker's runner switches to worker threads, and Node does
 * not allow `process.chdir()` in a worker thread, which some tests here call:
 * a change those tests reach failed Stryker's first pass outright, before a
 * single mutant was tried. Mutants are switched on through values Vitest sends
 * to each worker, which reach a child process as well as a thread.
 */
export function inForks(config) {
  config.pool = 'forks';
}

const vitest = upstream.find((plugin) => plugin.name === 'vitest');

/** Stryker's factory, with the filter fixed once Vitest is up. */
export function createRunner(injector) {
  const runner = vitest.factory(injector);
  const init = runner.init.bind(runner);
  runner.init = async () => {
    await init();
    for (const project of runner.ctx.projects) {
      widenNameFilter(project.config);
      inForks(project.config);
    }
  };
  return runner;
}
createRunner.inject = vitest.factory.inject;

/**
 * ## The ignorer
 *
 * Skips everything inside a JSX `style` attribute. Emptying a CSS value or a
 * style object changes how a page looks, and no test of behaviour should
 * notice, so each such mutant survives and says nothing. On the change that
 * added the paid orders' list, 19 of the 21 survivors in `Buy.tsx` were these,
 * and they buried the two worth reading. Ignored mutants are left out of the
 * report altogether.
 */
export class InlineStyles {
  shouldIgnore(path) {
    return path.isJSXAttribute() && path.node.name.name === 'style'
      ? 'An inline style changes how a page looks, which no behaviour test checks.'
      : undefined;
  }
}

/**
 * ## The progress reporter
 *
 * Where each result is written: `PROGRESS`, in `progress.mjs`.
 */
export { PROGRESS };

/**
 * Writes one JSON line when the plan is ready, with the number of mutants that
 * will be reported on, and one per mutant as it is tested. `stryker.ts` reads
 * the file when a run reaches its time limit, so a run cut off there still says
 * what it found among the mutants it got to.
 *
 * A file, and not a variable `stryker-mutate.ts` could read, because Stryker loads this
 * module itself, and a file assumes nothing about whether the two loads share a
 * module. Appended synchronously, so a line is on disk before the next one
 * starts, and a run killed at its limit leaves only whole lines.
 *
 * Skipped mutants, static ones and inline styles alike, are left out of the
 * planned count, as `summarise` leaves them out of its total.
 */
export class ProgressFile {
  constructor(path = PROGRESS) {
    this.path = path;
  }

  #write(entry) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  onMutationTestingPlanReady({ mutantPlans }) {
    const planned = mutantPlans.filter((p) => !(p.plan === 'EarlyResult' && p.mutant.status === 'Ignored')).length;
    this.#write({ planned });
  }

  onMutantTested(result) {
    this.#write({ result });
  }
}

export const strykerPlugins = [
  declareFactoryPlugin(PluginKind.TestRunner, 'vitest-describe', createRunner),
  declareClassPlugin(PluginKind.Ignore, 'inline-styles', InlineStyles),
  declareClassPlugin(PluginKind.Reporter, 'progress-file', ProgressFile),
];

// The `vitest` options are validated against the upstream runner's schema, as
// they would be if Stryker had loaded that runner itself.
export { strykerValidationSchema };
