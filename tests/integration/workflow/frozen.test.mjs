import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedIgnoreHints, branchChanges } from '../../../src/workflow/frozen.mjs';
import { configureTarget, markTarget } from '../../fixtures/workflow/target.mjs';
import { repositoryRulebook, writeConfig } from '../../fixtures/workflow/adapter.mjs';

/**
 * What the freeze actually reads.
 *
 * `isTest` above says what a test is. This says which of them this branch
 * has touched, and it is the half that decides whether a turn is blocked and
 * whether `workflow triage` will run. The machine cases cover the freeze end to
 * end, but every one of them touches a test the same way — by writing a new
 * file — so a `frozenChanges` blind to deletions or to commits on the branch
 * would pass all of them.
 *
 * Against a real repository rather than a stubbed git, because the whole
 * function is four git invocations and what is being checked is that they
 * answer together.
 */
describe('which frozen files this branch has touched', () => {
  let repo;
  let cwd;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (file, body) => writeFileSync(join(repo, file), body);

  /** A repository holding one test and one source file, committed, and by
   *  default on the target. `frozenChanges` with no baseline compares against
   *  the target's remote-tracking ref, which `markTarget` points here. */
  const start = ({ onTarget = true } = {}) => {
    repo = mkdtempSync(join(tmpdir(), 'workflow-frozen-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch', 'work'], { cwd: repo });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(repo);
    writeConfig(repo, { fields: { checks: { testQuality: { mutation: 'none', coverage: repositoryRulebook().checks.testQuality.coverage } } } });
    write('kept.test.mjs', 'it("kept", () => {});\n');
    write('impl.mjs', 'export const x = 1;\n');
    git('add', 'kept.test.mjs', 'impl.mjs');
    git('commit', '--quiet', '-m', 'base');
    if (onTarget) markTarget(repo);
    process.chdir(repo);
  };

  beforeEach(() => {
    cwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * A coverage ignore comment takes code out of the coverage figure, so a
   * folder can stay above its minimum with less of it tested. The review areas
   * name the files that gain one, and this is where they are found.
   */
  describe('files that gain a coverage ignore comment', () => {
    const hinted = (hint = '/* v8 ignore next */') => `export const x = 1;\n${hint}\nexport const y = () => 2;\n`;
    const found = (options = {}) => addedIgnoreHints({ ...branchChanges(), ...options });

    // The provider honours all four, so a list that named one spelling would
    // be passed by using another.
    it('finds every spelling the coverage provider honours', () => {
      const hints = [
        '/* v8 ignore next */', '/* v8 ignore start */', '// v8 ignore next 3', '/* v8 ignore file */',
        '/* c8 ignore next */', '/* istanbul ignore if */', '/* istanbul ignore else */', '/* node:coverage ignore next */',
      ];
      for (const hint of hints) {
        start();
        write('impl.mjs', hinted(hint));
        expect(found(), hint).toEqual(['impl.mjs']);
        process.chdir(cwd);
        rmSync(repo, { recursive: true, force: true });
      }
      start();
    });
  });
});
