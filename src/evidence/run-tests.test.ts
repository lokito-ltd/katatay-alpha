import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessChange, runTests } from './risk.js';
import { bareIdsIn, idsIn, scenariosIn } from './tags.js';
import type { TestCase, TestRun } from './test-run.js';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';

/** A test case as the run reads it from a report. */
const testCase = (file: string, name: string, more: Partial<TestCase> = {}): TestCase => ({
  file, name, status: 'passed', message: null, ids: idsIn(name), scenarios: scenariosIn(name), bare: bareIdsIn(name), inverted: false, ...more,
});

/**
 * A test that no longer compiles is a failed test, whatever the language. The
 * referee holds to that by two routes, and these cases walk both through
 * `runTests`, given the run as the reports would give it. See "A test that no
 * longer compiles" in `src/adapters/README.md`.
 */
describe('a test that no longer compiles, through runTests', () => {
  const run = (cases: TestCase[], leftOut: TestRun['leftOut'] = []): TestRun => ({ cases, leftOut, exit: 0 });

  // The lucky pass: comparing two promises where the test used to compare two
  // projects runs green. The compile error is the only signal.
  it('fails a test that ran green while its file does not compile, and only that test', () => {
    const given = run([
      testCase('a.test.ts', 'promises a project [AC0001.1]', { line: 1, endLine: 3 }),
      testCase('a.test.ts', 'lists projects [AC0001.2]', { line: 5, endLine: 7 }),
    ]);
    const tests = runTests([{ file: 'a.test.ts', line: 2, message: "TS2339: Property 'id' does not exist on type 'Promise<Project>'." }], given);
    expect(tests.map((t) => [t.title, t.failed, t.reason, t.ids])).toEqual([
      ['promises a project [AC0001.1]', true, 'does not compile', ['AC0001']],
      ['lists projects [AC0001.2]', false, undefined, ['AC0001']],
    ]);
  });

  it('fails every test in the file when the report gave no line ranges', () => {
    const given = run([testCase('a.test.ts', 'promises a project [AC0001.1]'), testCase('a.test.ts', 'lists projects [AC0001.2]')]);
    const tests = runTests([{ file: 'a.test.ts', line: 2, message: 'TS2339: x' }], given);
    expect(tests.map((t) => t.failed)).toEqual([true, true]);
  });

  it('leaves an error in implementation code out, for the triage to refuse on', () => {
    const given = run([testCase('a.test.ts', 'promises a project [AC0001.1]', { line: 1, endLine: 3 })]);
    expect(runTests([{ file: 'modules/projects/store.ts', line: 4, message: 'TS2322: x' }], given).every((t) => !t.failed)).toBe(true);
  });

  // A language with no static check: a test file its runner cannot load still
  // fails, with the file's tags, so it lands where its tests would have.
  it('fails a file the report left out when the adapter has no compile step', () => {
    const given = run([], [{ file: 'b.test.py', ids: ['AC0007'], scenarios: ['AC0007.1'], bare: [] }]);
    expect(runTests(null, given)).toEqual([{
      file: 'b.test.py',
      title: '(the whole file)',
      ids: ['AC0007'],
      scenarios: ['AC0007.1'],
      failed: true,
      wholeFile: true,
      reason: 'the test report leaves it out: it failed to load, or the run never reached it',
      didNotRun: true,
    }]);
  });
});

it('warns about unchecked compilation only when the compile step was absent', () => {
  const run: TestRun = { cases: [testCase('a.test.ts', 'works')], leftOut: [], exit: 0 };
  expect(assessChange(null, [], run).unchecked).toEqual([
    'not checked: compile (the adapter says "none" in .katatay/rulebook.json): a test that runs green while it would not compile counts as passing',
  ]);
  expect(assessChange([], [], run).unchecked).toEqual([]);
});

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

  // The level measures the plan's missed predictions and test regressions. A
  // change in a high-risk area is review's to read, under "Must look", and
  // raises nothing here.
  it('does not raise the level for a change in a high-risk area', () => {
    writeConfig(root, {
      adapter: { run: TEST_RUN, compile: 'none' },
      fields: { highRisk: [{ paths: ['guarded/**'], why: 'Guarded.' }] },
    });
    mkdirSync(join(root, 'guarded'), { recursive: true });
    writeFileSync(join(root, 'guarded/a.txt'), 'a\n');

    const report = assessChange(null, ['src/a.test.ts']);
    expect(report.level).toBe('LOW');
    expect(report.reasons).toEqual([]);
  });
});
