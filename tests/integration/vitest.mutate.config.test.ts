/**
 * The Vitest config this project's mutation runs use, `vitest.mutate.config.ts`.
 * The rulebook's mutation command passes it to the Stryker wrapper.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import base from '../../vitest.config';
import mutated, { LAYOUT, NEEDS_THE_REPOSITORY } from '../../vitest.mutate.config';
import { processOnlyTests } from '../../src/adapters/typescript/process-only';
import { matchesSlow, readAdapter } from '../../src/workflow/adapter.mjs';

describe('the Vitest config mutation runs use', () => {
  // Built from `vitest.config.ts`, so a test file added to `fast` is one
  // Stryker runs too, and the e2e journey, which needs a browser and a server
  // for every mutant, is never one of them.
  it('is the fast project of vitest.config.ts, alone', () => {
    const fast = (base.test?.projects as { test: { name: string; include: string[]; setupFiles: string[] } }[])
      .find((project) => project.test.name === 'fast');
    expect(mutated.test?.projects).toBeUndefined();
    expect(mutated.test?.include).toEqual(fast?.test.include);
    expect(mutated.test?.setupFiles).toEqual(fast?.test.setupFiles);
    expect(mutated.test?.include?.some((glob) => glob.startsWith('tests/e2e'))).toBe(false);
  });

  // A hook a test starts never sees a mutant, so those tests only cost time.
  it('leaves out the tests that reach the code only through processes, in any folder, and keeps the rest', () => {
    const left = processOnlyTests(LAYOUT);
    expect(left).toEqual(expect.arrayContaining([
      'tests/hooks/codex/journey.test.mjs',
      'tests/machine/recording.test.mjs',
      'tests/integration/workflow/workflow.process.test.mjs',
    ]));
    expect(mutated.test?.exclude).toEqual(expect.arrayContaining(left));
    expect([...left, ...NEEDS_THE_REPOSITORY].filter((file) => !matchesSlow(file))).toEqual([]);
    expect(mutated.test?.exclude).not.toContain('src/workflow/moments/deciding.test.mjs');
  });

  it('reads the tests from the rulebook, and names this project\'s support', () => {
    expect(LAYOUT.tests).toEqual(readAdapter().tests.all);
    expect(LAYOUT.support).toEqual(['tests/support/machine/*', 'tests/support/workflow/**', '**/fixtures/**']);
  });

  // A test that needs this repository's git fails in Stryker's sandbox, and
  // one failing test in the first pass stops the whole run. A path left
  // stale when such a test moves would let it back in unnoticed.
  it('leaves out the tests that need the repository\'s git, by paths that exist', () => {
    expect(NEEDS_THE_REPOSITORY).toEqual(['tests/integration/vitest.config.test.ts']);
    expect(NEEDS_THE_REPOSITORY.filter((file) => !existsSync(file))).toEqual([]);
    expect(mutated.test?.exclude).toEqual(expect.arrayContaining(NEEDS_THE_REPOSITORY));
  });
});
