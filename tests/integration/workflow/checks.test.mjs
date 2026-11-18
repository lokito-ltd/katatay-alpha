/**
 * Running one check: its placeholders, its time limit, and what its exit code
 * means. Verify runs every check through this; `referee-verify.process.test.mjs`
 * covers that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../../../src/workflow/checks.mjs';

const node = (code) => `node -e ${JSON.stringify(code)}`;
/** A check as `parseChecks` gives one, with `over` laid over it. */
const check = (command, over = {}) => ({
  name: 'lint', chain: 'codeQuality', command, exitCodes: { 0: 'clean', 1: 'findings' },
  runs: 'always', onFailure: 'block', timeLimitSeconds: 10, suppressions: [], ...over,
});
/** A baseline nobody should have to ask for. */
const unasked = () => { throw new Error('the baseline was asked for'); };

describe('running a check', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'checks-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (command, over, options = {}) => runCheck(check(command, over), { root, baseline: unasked, ...options });

  it('stops a run at its time limit, and reads it as broken', () => {
    const result = run(node('setTimeout(() => {}, 10000)'), { timeLimitSeconds: 1 });
    expect(result).toMatchObject({ outcome: 'broken', reason: 'broke: still running after 1 seconds, so it was stopped' });
  });
});
