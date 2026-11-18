import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessChange } from '../../../src/evidence/risk.js';
import { writeConfig } from '../../fixtures/workflow/adapter.mjs';
import { configureTarget, markTarget } from '../../fixtures/workflow/target.mjs';

/**
 * The triage's report, from the rulebook's test command to the buckets, for a
 * language with no static check. The plan's predictions decide the buckets,
 * and the report says what it could not look at.
 */
describe('the triage of a change, through assessChange', () => {
  const cwd = process.cwd();
  let root: string;

  /** A test command that writes one failing test case for `src/a.test.ts`. */
  const TEST_RUN = {
    command: `node -e "require('fs').mkdirSync('reports', { recursive: true }); require('fs').writeFileSync('reports/run.xml', '<testsuites><testcase name=\\"works\\" file=\\"src/a.test.ts\\"><failure/></testcase></testsuites>'); process.exit(1)"`,
    reportPaths: ['reports/*.xml'],
    tagComment: '^\\s*//',
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'assess-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.test.ts'), "it('works', () => {});\n");
    writeFileSync(join(root, '.gitignore'), 'reports/\n');
    writeConfig(root, {
      adapter: {
        run: TEST_RUN,
        compile: 'none',
      },
    });
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    markTarget(root);
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('files a failure the plan predicted as predicted, and one it did not as a surprise', () => {
    const predicted = assessChange(null, ['src/a.test.ts']);
    expect([predicted.predicted.failed, predicted.surprise.failed, predicted.overPredicted.count]).toEqual([1, 0, 0]);

    const unpredicted = assessChange(null);
    expect([unpredicted.predicted.failed, unpredicted.surprise.failed, unpredicted.overPredicted.count]).toEqual([0, 1, 0]);
    expect(unpredicted.level).toBe('HIGH');
  });

  it('says what it could not check, and only that', () => {
    expect(assessChange(null).unchecked).toEqual([
      expect.stringMatching(/^not checked: compile .*: a test that runs green while it would not compile counts as passing$/),
    ]);
    expect(assessChange([]).unchecked).toEqual([]);
  });
});
