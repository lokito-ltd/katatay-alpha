import { afterEach, beforeEach } from 'vitest';
import { failOnCaught, watchStderr } from './git-stderr';

/**
 * Runs in every test file of the `fast` project: a test that writes git's
 * `fatal:` line to stderr fails. See `git-stderr.ts` for why.
 *
 * Around each test, so the failure lands on the test that caused it rather
 * than on the file. The `afterEach` here is registered before any of the test
 * file's own, and Vitest runs `afterEach` hooks last-registered first, so a
 * leak in a test file's own cleanup is caught too. A leak in `beforeAll`,
 * `afterAll` or while a file is loaded is not watched.
 */
let watch: { stop: () => string[] } | undefined;

beforeEach(() => {
  watch = watchStderr();
});

afterEach(() => {
  const caught = watch?.stop() ?? [];
  watch = undefined;
  failOnCaught(caught);
});
