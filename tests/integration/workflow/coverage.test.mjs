import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SETTINGS_FILE, coverageCheck } from '../../../src/workflow/coverage.mjs';
import { bareSections, repositoryRulebook } from '../../fixtures/workflow/adapter.mjs';

/** One file of the parsed coverage report. The check reads `covered` and
 *  `total` and nothing else; `uncoveredLines` here is only as long as the
 *  counts say it must be. */
const entry = (file, lines, branches = [0, 0]) => ({
  file,
  lines: { covered: lines[0], total: lines[1] },
  branches: { covered: branches[0], total: branches[1] },
  uncoveredLines: Array.from({ length: lines[1] - lines[0] }, (_, i) => i + 1),
});

/** The answer's files from `{ 'path/from/root': [lines, branches] }`. */
const answerOf = (files) => ({ files: Object.entries(files).map(([file, [lines, branches]]) => entry(file, lines, branches)) });

/** Where this repository's rulebook says the lcov report is. */
const REPORT = 'coverage/lcov.info';

/**
 * An answer written back as an lcov report, so a case states the figures it
 * wants and the check reads them through the real parser: lines 1 to `total`,
 * run once except the uncovered ones, and one branch way per counted branch,
 * the first `covered` of them taken.
 */
const lcovOf = (answer) => answer.files.map(({ file, lines, branches, uncoveredLines }) => [
  `SF:${file}`,
  ...Array.from({ length: lines.total }, (_, i) => `DA:${i + 1},${uncoveredLines.includes(i + 1) ? 0 : 1}`),
  `LF:${lines.total}`,
  `LH:${lines.covered}`,
  ...Array.from({ length: branches.total }, (_, i) => `BRDA:1,0,${i},${i < branches.covered ? 1 : '-'}`),
  `BRF:${branches.total}`,
  `BRH:${branches.covered}`,
  'end_of_record',
].join('\n')).join('\n') + '\n';

/** Writes an lcov report under `root`, where the rulebook says it is. */
const writeReport = (root, text) => {
  mkdirSync(dirname(join(root, REPORT)), { recursive: true });
  writeFileSync(join(root, REPORT), text);
};

/**
 * The check as the command runs it, against files on disk. The command itself
 * is spawned for the exit code, which is the only thing `workflow verify` and
 * the CI job read.
 */
describe('workflow coverage', () => {
  const COMMAND = resolve('src/workflow/cli/coverage.mjs');
  let root;

  const writeChecks = (checks) => {
    mkdirSync(dirname(join(root, SETTINGS_FILE)), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'coverage/\nreports/\n');
    writeFileSync(join(root, SETTINGS_FILE), JSON.stringify({ ...bareSections(), tests: repositoryRulebook().tests, code: repositoryRulebook().code, checks }));
  };
  const settings = (minimum) => writeChecks({ testQuality: { mutation: 'none', coverage: { ...repositoryRulebook().checks.testQuality.coverage, minimum } } });
  /** What the coverage report will hold. */
  const report = (files) => writeReport(root, lcovOf(answerOf(files)));
  const run = () => spawnSync('node', [COMMAND], { cwd: root, encoding: 'utf8' });

  beforeEach(() => {
    // The real path, because the command takes its root from `process.cwd()`,
    // and on macOS the temporary folder is reached through a symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-coverage-')));
    // A repository, because the check asks git which code files are on disk.
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', join(root, '.no-such-remote')], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails and exits 1 on a report below the minimum, saying which folder and by how much', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    report({ 'modules/a.ts': [[899, 1000], [8, 10]] });
    expect(coverageCheck(root).ok).toBe(false);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('FAILED — modules/: line coverage is 89.9%, below the minimum of 90.0%');
  });

  // No report when the test command did not run, or ran without measuring
  // coverage. A check that passed with nothing to read would pass for ever
  // after the flag went.
  it('fails and exits 1 when there is no coverage report, which is a refusal and not a result', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    const { ok, lines } = coverageCheck(root);
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('coverage command exited 1');
    expect(run().status).toBe(1);
  });
});
