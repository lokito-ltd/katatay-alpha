import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import {
  SETTINGS_FILE, checkCoverage, codeFiles, configuredCoverage, coverageAnalysis, coverageCheck, lineRanges, percent, renderFolders, renderUntested,
  runCoverageCheck, tenths, touchedCoverage, untestedTouched,
} from './coverage.mjs';
import { inRoot } from './check-output.mjs';
import { bareSections, repositoryRulebook } from '../../tests/fixtures/workflow/adapter.mjs';

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

/** The same, keyed by path, as the check takes it. */
const reportOf = (files) => Object.fromEntries(answerOf(files).files.map((file) => [file.file, file]));

const check = (files, minimum) => checkCoverage({ report: reportOf(files), minimum });

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

describe('validation of preserved coverage analysis', () => {
  const saved = () => ({ version: HARNESS_SCHEMA_VERSION, name: 'coverage', result: { outcome: 'clean', exitCode: 0, reason: 'Clean.', text: '' },
    measurement: { folders: [{ folder: 'modules/', files: 1,
      lines: { covered: 2, total: 3, measured: 666, minimum: 600 },
      branches: { covered: 1, total: 1, measured: 1000, minimum: 1000 } }],
    failures: [], touched: { covered: 1, total: 1, uncovered: [] } } });

  it.each([17, '', false, {}, undefined])('rejects invalid baseline %j even from the caller', baseline => {
    const document = saved();
    expect(() => coverageAnalysis(document, baseline)).toThrow('the producing baseline is required');
  });

  it.each(['approved-baseline', null])('accepts a valid baseline %j with its corresponding touched measurement', baseline => {
    const document = saved();
    if (baseline === null) document.measurement.touched = null;
    expect(coverageAnalysis(document, baseline)).toEqual(document.measurement);
  });

  it('requires a successful result by default and reads failed figures when explicitly requested', () => {
    const document = saved();
    document.result = { outcome: 'findings', exitCode: 1, text: '', reason: 'below a minimum' };
    document.measurement.folders[0].lines.minimum = 700;
    document.measurement.failures.push('modules/ lines below 70.0%');

    expect(() => coverageAnalysis(document, 'approved-baseline'))
      .toThrow('coverage: saved analysis is not successful (below a minimum)');
    expect(coverageAnalysis(document, 'approved-baseline', false)).toEqual(document.measurement);
  });

  it('names the document and missing field when the caller supplies no diagnostic label', () => {
    const document = saved();
    delete document.result.exitCode;

    expect(() => coverageAnalysis(document, 'approved-baseline'))
      .toThrow('coverage: saved analysis has an invalid shape: coverage analysis.result.exitCode is missing');
  });

  it('wraps invalid detailed arithmetic with the saved-analysis diagnostic', () => {
    const document = saved(); document.measurement.folders[0].lines.measured = 667;
    expect(() => coverageAnalysis(document, 'approved-baseline'))
      .toThrow('coverage: saved analysis has invalid coverage figures: coverage evidence has inconsistent coverage figures');
  });

  it('rejects a saved clean result with an empty folder alongside a measured folder', () => {
    const document = saved();
    document.measurement.folders.push({ ...structuredClone(document.measurement.folders[0]), folder: 'empty/', files: 0 });
    expect(() => coverageAnalysis(document, 'approved-baseline'))
      .toThrow('coverage: saved analysis has invalid coverage figures: coverage evidence cannot pass without measured folders or with coverage failures');
  });
});

describe('a share, in tenths of a percent', () => {
  // A minimum is recorded from this figure. Rounded to the nearest, 93.98 would
  // be recorded as 94.0, a minimum the code that produced it does not meet.
  it('rounds down, never up', () => {
    expect(percent(tenths(9398, 10000))).toBe('93.9%');
    expect(percent(tenths(250, 266))).toBe('93.9%');
    expect(percent(tenths(9999, 10000))).toBe('99.9%');
  });

  it('is exact when the share is a whole number of tenths', () => {
    expect(tenths(939, 1000)).toBe(939);
    expect(tenths(10, 10)).toBe(1000);
    expect(tenths(0, 10)).toBe(0);
  });

  it('counts nothing to cover as fully covered', () => {
    expect(tenths(0, 0)).toBe(1000);
  });
});

describe('the coverage check', () => {
  const minimum = { 'modules/': { lines: 90, branches: 80 } };

  it('fails a folder below its line minimum, naming the folder, the figure and the minimum', () => {
    const { failures } = check({ 'modules/a.ts': [[899, 1000], [8, 10]] }, minimum);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('modules/');
    expect(failures[0]).toContain('line coverage is 89.9%');
    expect(failures[0]).toContain('minimum of 90.0%');
  });

  it('fails a folder below its branch minimum, naming the folder, the figure and the minimum', () => {
    const { failures } = check({ 'modules/a.ts': [[1000, 1000], [799, 1000]] }, minimum);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('modules/');
    expect(failures[0]).toContain('branch coverage is 79.9%');
    expect(failures[0]).toContain('minimum of 80.0%');
  });

  it('passes a folder exactly at its minimums', () => {
    const { failures, folders } = check({ 'modules/a.ts': [[900, 1000], [8, 10]] }, minimum);
    expect(failures).toEqual([]);
    expect(folders).toHaveLength(1);
  });

  // The minimum is recorded rounded down, so the figure it came from is a
  // little above it. That figure has to pass.
  it('passes the figure a minimum was recorded from', () => {
    const { failures } = check({ 'modules/a.ts': [[250, 266], [117, 119]] }, { 'modules/': { lines: 93.9, branches: 98.3 } });
    expect(failures).toEqual([]);
  });

  it('reports both when lines and branches are each below', () => {
    const { failures } = check({ 'modules/a.ts': [[1, 10], [1, 10]] }, minimum);
    expect(failures.map((failure) => /(line|branch) coverage/.exec(failure)[1])).toEqual(['line', 'branch']);
  });

  // Covered lines over lines, across the folder. An average of the files'
  // percentages would call this 50% and let a three-line file weigh as much as
  // a three-hundred-line one.
  it('sums a folder from its files instead of averaging them', () => {
    const { folders } = check({ 'modules/big.ts': [[300, 300], [0, 0]], 'modules/small.ts': [[0, 3], [0, 0]] }, minimum);
    expect(percent(folders[0].lines.measured)).toBe('99.0%');
    expect(folders[0].files).toBe(2);
  });

  it('holds each folder to its own minimum', () => {
    const { failures } = check(
      { 'modules/a.ts': [[10, 10], [1, 1]], 'app/page.tsx': [[1, 10], [1, 1]] },
      { 'modules/': { lines: 90, branches: 80 }, 'app/': { lines: 20, branches: 0 } },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^app\/: line coverage is 10\.0%/);
  });

  // Narrowing `include` in the vitest config makes a folder vanish from the
  // report, and a folder that is not there has nothing below its minimum.
  it('fails a folder that has a minimum and no measured file', () => {
    const { failures } = check({ 'modules/a.ts': [[10, 10], [1, 1]] }, { ...minimum, 'app/': { lines: 0, branches: 0 } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^app\/: no file under it was measured/);
  });

  // A new folder would otherwise be measured and never checked.
  it('fails a measured file that sits under no folder with a minimum', () => {
    const { failures } = check({ 'modules/a.ts': [[10, 10], [1, 1]], 'tools/new/x.mjs': [[10, 10], [1, 1]] }, minimum);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tools/new/x.mjs');
    expect(failures[0]).toContain('.katatay/rulebook.json');
  });

  // The other way past a minimum: measure less. An `exclude` entry takes a
  // file out of the report, and its uncovered lines leave the figure with it.
  it('fails a code file that is on disk and not in the report', () => {
    const { failures } = checkCoverage({
      report: reportOf({ 'modules/a.ts': [[10, 10], [1, 1]] }),
      minimum,
      files: ['modules/a.ts', 'modules/hidden.ts', 'modules/also/hidden.ts'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^code, but not in the coverage report: modules\/also\/hidden\.ts, modules\/hidden\.ts\./);
    expect(failures[0]).toContain("coverage tool's settings");
  });

  it('passes when every code file on disk is in the report', () => {
    const { failures } = checkCoverage({
      report: reportOf({ 'modules/a.ts': [[10, 10], [1, 1]] }), minimum, files: ['modules/a.ts'],
    });
    expect(failures).toEqual([]);
  });

  it('counts a file once, under the longest folder that holds it', () => {
    const { folders, failures } = check(
      { 'tools/a.mjs': [[10, 10], [0, 0]], 'src/workflow/b.mjs': [[0, 10], [0, 0]] },
      { 'tools/': { lines: 100, branches: 0 }, 'src/workflow/': { lines: 0, branches: 0 } },
    );
    expect(failures).toEqual([]);
    expect(folders.map(({ folder, files }) => [folder, files])).toEqual([['tools/', 1], ['src/workflow/', 1]]);
  });

  // The answer is keyed by file, and a file can be called anything. Istanbul's
  // summary has an entry named `total` for the whole run, which the check used
  // to skip; the command's answer has no such entry to skip.
  it('counts a file called total like any other', () => {
    const { failures } = check({ 'modules/total': [[0, 10], [0, 0]] }, minimum);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('line coverage is 0.0%');
  });
});

/**
 * Each of these would switch part of the check off without failing anything,
 * so each has to fail on its own.
 */
describe('minimums that are themselves wrong', () => {
  const files = { 'modules/a.ts': [[10, 10], [1, 1]] };

  it('fails when there is no minimum section at all', () => {
    for (const minimum of [undefined, null, {}, []]) {
      const { failures } = check(files, minimum);
      expect(failures, JSON.stringify(minimum)).toHaveLength(1);
      expect(failures[0]).toContain('no checks.testQuality.coverage.minimum section');
    }
  });

  it('fails a folder with no branch minimum, which would leave branches unchecked', () => {
    const { failures } = check(files, { 'modules/': { lines: 90 } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/modules\/: the branches minimum must be a number/);
  });

  it('fails a folder with no line minimum', () => {
    expect(check(files, { 'modules/': { branches: 90 } }).failures[0]).toMatch(/the lines minimum must be a number/);
  });

  // `10 < "90"` is false in a way that reads as a pass.
  it('fails a minimum that is not a number from 0 to 100', () => {
    for (const lines of ['90', null, NaN, -1, 100.1]) {
      expect(check(files, { 'modules/': { lines, branches: 0 } }).failures, String(lines)).toHaveLength(1);
    }
  });

  // The figures are compared in tenths, so a second decimal would be rounded
  // away without anyone having chosen which way.
  it('fails a minimum with more than one decimal', () => {
    expect(check(files, { 'modules/': { lines: 93.95, branches: 0 } }).failures).toHaveLength(1);
    expect(check(files, { 'modules/': { lines: 93.9, branches: 0 } }).failures).toEqual([]);
  });

  // `tools/work` would claim `src/workflow/` and anything else starting so.
  it('fails a folder written without its closing slash', () => {
    expect(check(files, { modules: { lines: 0, branches: 0 } }).failures[0]).toContain('must end with "/"');
  });
});

describe('what the check prints', () => {
  it('shows each folder\'s figure beside its minimum', () => {
    const { folders } = check(
      { 'modules/a.ts': [[955, 1000], [9, 10]], 'app/page.tsx': [[1, 10], [1, 1]] },
      { 'modules/': { lines: 90, branches: 80 }, 'app/': { lines: 10, branches: 0 } },
    );
    expect(renderFolders(folders)).toEqual([
      'modules/  lines  95.5% (minimum 90.0%)  branches  90.0% (minimum 80.0%)',
      'app/      lines  10.0% (minimum 10.0%)  branches 100.0% (minimum 0.0%)',
    ]);
  });
});

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
  /** A file on disk, as the code the report is compared with. */
  const code = (file) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'export const x = 1;\n');
  };
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

  it('passes and exits 0 when every folder is at its minimum', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    report({ 'modules/a.ts': [[900, 1000], [8, 10]] });
    expect(coverageCheck(root).ok).toBe(true);
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('coverage: modules/  lines  90.0% (minimum 90.0%)');
  });

  it('fails and exits 1 when the report is not lcov the referee can read', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    writeReport(root, 'all covered\n');
    expect(coverageCheck(root).lines.join('\n')).toContain('coverage command stdout, line 1: "all covered" is not an lcov record');
    expect(run().status).toBe(1);
  });

  // The totals of a report must agree with its records, so a writer that
  // gets one wrong is stopped here and not read as a pass.
  it('fails and exits 1 when the report\'s totals disagree with its records', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    writeReport(root, lcovOf(answerOf({ 'modules/a.ts': [[1000, 1000], [10, 10]] })).replace('LH:1000', 'LH:999'));
    expect(coverageCheck(root).lines.join('\n')).toContain('modules/a.ts says LH:999, and its records count 1000');
    expect(run().status).toBe(1);
  });

  it('takes the figures from the report, line and branch counts both', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    code('modules/a.ts');
    report({ 'modules/a.ts': [[9, 10], [8, 10]] });
    const { ok, lines } = coverageCheck(root);
    expect(ok).toBe(true);
    expect(lines[0]).toBe('modules/  lines  90.0% (minimum 90.0%)  branches  80.0% (minimum 80.0%)');
  });

  it('reads the minimums from .katatay/rulebook.json, which no session may write', () => {
    expect(SETTINGS_FILE).toBe('.katatay/rulebook.json');
  });

  it('fails and exits 1 when there is no config file', () => {
    report({ 'modules/a.ts': [[10, 10], [1, 1]] });
    expect(coverageCheck(root).lines[0]).toContain('.katatay/rulebook.json is missing');
    expect(run().status).toBe(1);
  });

  it('exits 1 and explains how to switch coverage off when the entry is absent', () => {
    writeChecks({});
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toMatch(/coverage: refused .*checks\.testQuality\.coverage.*"none"/);
  });

  // An `exclude` entry in the vitest config leaves the file on disk and takes
  // it out of the report. The folder's figure is then about less code.
  it('fails and exits 1 when a code file on disk is missing from the report', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    code('modules/a.ts');
    code('modules/excluded.ts');
    report({ 'modules/a.ts': [[1000, 1000], [10, 10]] });
    expect(coverageCheck(root).ok).toBe(false);
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain('FAILED — code, but not in the coverage report: modules/excluded.ts.');
  });

  it('passes when the report holds every code file on disk', () => {
    settings({ 'modules/': { lines: 90, branches: 80 } });
    code('modules/a.ts');
    report({ 'modules/a.ts': [[1000, 1000], [10, 10]] });
    expect(coverageCheck(root).ok).toBe(true);
    expect(run().status).toBe(0);
  });

  // A new folder under `src/` has no minimum yet. Listing only the folders
  // that have one would leave its files out of the comparison.
  it('compares every file under the top-level folders, not only the folders with a minimum', () => {
    settings({ 'src/workflow/': { lines: 0, branches: 0 } });
    code('src/workflow/a.mjs');
    code('src/new/excluded.mjs');
    report({ 'src/workflow/a.mjs': [[1, 1], [1, 1]] });
    expect(coverageCheck(root).lines.join('\n')).toContain('not in the coverage report: src/new/excluded.mjs.');
  });

  // The adapter section says where the report is. Without it nobody can say
  // which report to read.
  it('refuses when the config has no test paths', () => {
    mkdirSync(join(root, '.katatay'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'coverage/\nreports/\n');
    writeFileSync(join(root, SETTINGS_FILE), JSON.stringify({ ...bareSections(), checks: { testQuality: { mutation: 'none', coverage: { ...repositoryRulebook().checks.testQuality.coverage, minimum: { 'modules/': { lines: 0, branches: 0 } } } } } }));
    report({ 'modules/a.ts': [[1, 1], [1, 1]] });
    const { ok, lines } = coverageCheck(root);
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('"tests.paths" must be an object');
    expect(run().status).toBe(1);
  });

  // A language with no coverage tool. The operator's decision, written down
  // where no session can write, and said as checking nothing.
  // Its callers ask first, and the answer still says so on its own: a
  // report that is not to be read is not read, whatever is on disk.
  it('has no coverage check to run when coverage is explicitly switched off', () => {
    writeChecks({ testQuality: { mutation: 'none', coverage: 'none' } });
    writeReport(root, 'not lcov\n');
    expect(configuredCoverage(root)).toBeUndefined();
  });

  it('exits 0 and reports the explicit choice to switch coverage off', () => {
    writeChecks({ testQuality: { mutation: 'none', coverage: 'none' } });
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('not checked: coverage (checks.testQuality.coverage is "none")');
  });

  // Without the list the comparison would be off, and a pass would say
  // nothing about what is measured.
  it('refuses when git cannot list the code files', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    settings({ 'modules/': { lines: 90, branches: 80 } });
    report({ 'modules/a.ts': [[1000, 1000], [10, 10]] });
    const { ok, lines } = coverageCheck(root);
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('git');
  });
});

describe('what the check says when it fails', () => {
  it('says a folder whose files were not measured has a minimum that checks nothing', () => {
    const { failures } = checkCoverage({ report: reportOf({ 'app/page.tsx': [[1, 1], [1, 1]] }), minimum: { 'app/': { lines: 0, branches: 0 }, 'modules/': { lines: 0, branches: 0 } } });
    expect(failures).toEqual(['modules/: no file under it was measured, so its minimum checks nothing. '
      + "Either the folder is gone, or the coverage tool's settings no longer reach it."]);
  });

  it('says a code file missing from the report was taken out, or the report is old', () => {
    const { failures } = checkCoverage({ report: reportOf({ 'app/a.ts': [[1, 1], [1, 1]] }), minimum: { 'app/': { lines: 0, branches: 0 } }, files: ['app/a.ts', 'app/b.ts'] });
    expect(failures).toEqual([expect.stringMatching(/^code, but not in the coverage report: app\/b\.ts\. .* or the report is older than the file: verify writes a new one\. Code is never left out of the figure\.$/)]);
  });
});

describe('the code files a report has to hold', () => {
  let root;
  const write = (file) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'export const x = 1;\n');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-coverage-files-')));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', join(root, '.no-such-remote')], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists code under the given folders, tracked or not, and leaves out tests, other files and what git ignores', () => {
    for (const file of ['modules/a.ts', 'modules/a.test.ts', 'modules/notes.md', 'modules/data.json', 'app/page.tsx', 'tools/x.mjs', 'elsewhere/y.ts', 'modules/ignored.ts']) write(file);
    writeFileSync(join(root, '.gitignore'), 'modules/ignored.ts\n');
    execFileSync('git', ['add', 'modules/a.ts'], { cwd: root });
    expect(codeFiles(root, ['app/', 'modules/', 'tools/']).sort()).toEqual(['app/page.tsx', 'modules/a.ts', 'tools/x.mjs']);
  });

  // In the index and gone from disk: a deleted file is not unmeasured code.
  it('leaves out a file that is tracked and no longer on disk', () => {
    write('modules/gone.ts');
    execFileSync('git', ['add', '-A'], { cwd: root });
    rmSync(join(root, 'modules/gone.ts'));
    expect(codeFiles(root, ['modules/'])).toEqual([]);
  });

  it('lists nothing when no folder is named, where git would otherwise list everything', () => {
    write('modules/a.ts');
    expect(codeFiles(root, [])).toEqual([]);
  });

  // An empty list would read as "no code here", and every file missing from
  // the report would pass unnoticed.
  it('throws when git cannot list the files, rather than listing none', () => {
    write('modules/a.ts');
    rmSync(join(root, '.git'), { recursive: true, force: true });
    expect(() => codeFiles(root, ['modules/'])).toThrow(/not a git repository/);
  });
});

/** An answer whose files list exactly these lines as run by no test. */
const missed = (files) => ({ files: Object.entries(files).map(([file, uncoveredLines]) => ({
  file,
  lines: { covered: 100 - uncoveredLines.length, total: 100 },
  branches: { covered: 0, total: 0 },
  uncoveredLines,
})) });

describe('the new lines no test runs', () => {
  it('takes only the uncovered lines inside the touched ranges', () => {
    const gaps = untestedTouched(missed({ 'modules/a.ts': [3, 10, 11, 40] }), [{ file: 'modules/a.ts', lines: [10, 20] }]);
    expect(gaps).toEqual([{ file: 'modules/a.ts', lines: [10, 11] }]);
  });

  // A file git has not been told about is new, all of it.
  it('takes every uncovered line of a whole-file target', () => {
    expect(untestedTouched(missed({ 'modules/new.ts': [1, 2, 7] }), [{ file: 'modules/new.ts' }])).toEqual([{ file: 'modules/new.ts', lines: [1, 2, 7] }]);
  });

  // `coverage:check` already fails a code file missing from the report.
  it('leaves out a touched file the answer does not list', () => {
    expect(untestedTouched(missed({ 'modules/a.ts': [1] }), [{ file: 'modules/elsewhere.ts', lines: [1, 5] }])).toEqual([]);
  });

  it('leaves out a file whose touched lines all ran', () => {
    expect(untestedTouched(missed({ 'modules/a.ts': [1, 50] }), [{ file: 'modules/a.ts', lines: [10, 20] }])).toEqual([]);
  });

  it('counts a line once when two touched ranges hold it, and sorts files and lines', () => {
    const gaps = untestedTouched(missed({ 'modules/b.ts': [5], 'modules/a.ts': [2, 4, 6] }), [
      { file: 'modules/b.ts', lines: [1, 9] },
      { file: 'modules/a.ts', lines: [4, 6] },
      { file: 'modules/a.ts' },
    ]);
    expect(gaps).toEqual([{ file: 'modules/a.ts', lines: [2, 4, 6] }, { file: 'modules/b.ts', lines: [5] }]);
  });

  it('writes runs of lines as ranges', () => {
    expect(lineRanges([12, 13, 14, 30])).toBe('12-14, 30');
    expect(lineRanges([1, 3, 4])).toBe('1, 3-4');
    expect(lineRanges([7])).toBe('7');
  });

  it('names each file with its count and ranges, after the total', () => {
    expect(renderUntested([{ file: 'modules/a.ts', lines: [12, 13, 14, 30] }, { file: 'tools/x.mjs', lines: [5] }])).toEqual([
      'Coverage: 5 lines this change added that no test runs. For each, write',
      '  the test that runs it, or say why none can, such as code that runs only',
      '  in a separate process, where coverage cannot see.',
      '  - modules/a.ts: 4 lines (12-14, 30)',
      '  - tools/x.mjs: 1 line (5)',
    ]);
  });

  it('says so in one line when every new line runs', () => {
    expect(renderUntested([])).toEqual(['Coverage: every new line this change added runs under some test.']);
  });
});

describe('the new lines no test runs, in a working tree', () => {
  let root;
  let base;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  /** Coverage on with a 0 minimum, or `false` for no entry, or a string to
   *  write as the entry, such as "none". */
  const settings = (enabled = true) => {
    mkdirSync(dirname(join(root, SETTINGS_FILE)), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'coverage/\nreports/\n');
    const coverage = enabled === true ? { ...repositoryRulebook().checks.testQuality.coverage, minimum: { 'modules/': { lines: 0, branches: 0 } } } : enabled;
    writeFileSync(join(root, SETTINGS_FILE), JSON.stringify({ ...bareSections(), tests: repositoryRulebook().tests, code: repositoryRulebook().code, checks: coverage ? { testQuality: { mutation: 'none', coverage } } : {} }));
  };
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-coverage-touched-')));
    git('init', '--quiet');
    git('remote', 'add', 'origin', join(root, '.no-such-remote'));
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    write('modules/a.ts', 'one\ntwo\nthree\nfour\n');
    write('modules/a.test.ts', 'one\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', base);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The coverage check as verify runs it, and the analysis verify keeps:
   *  the snapshot's document, checked against the producing baseline. */
  const verified = () => {
    let document;
    const result = runCoverageCheck(configuredCoverage(root), root, { publish: (raw, analysis) => {
      document = JSON.parse(analysis);
      return { raw: 'raw', analysis: 'analysis' };
    } });
    return { result, analysis: document && coverageAnalysis(document, result.baseline) };
  };
  /** What the verified message says, with the fixture's rulebook. */
  const said = (result, analysis) => inRoot(root, () => touchedCoverage(result, analysis));

  it('lists the changed lines of code no test ran, and nothing of old lines or tests', () => {
    settings();
    write('modules/a.ts', 'one\nTWO\nthree\nFOUR\n');
    write('modules/a.test.ts', 'ONE\n');
    writeReport(root, lcovOf(missed({ 'modules/a.ts': [1, 2], 'modules/a.test.ts': [1] })));
    const { result, analysis } = verified();
    expect(result).toMatchObject({ outcome: 'clean', snapshots: { raw: 'raw', analysis: 'analysis' } });
    expect(said(result, analysis)).toEqual([
      'Coverage: 1 line this change added that no test runs. For each, write',
      '  the test that runs it, or say why none can, such as code that runs only',
      '  in a separate process, where coverage cannot see.',
      '  - modules/a.ts: 1 line (2)',
    ]);
  });

  it('refuses when the coverage entry is absent', () => {
    settings(false);
    write('modules/a.ts', 'changed\n');
    expect(() => said(undefined, null)).toThrow(/checks\.testQuality\.coverage.*"none"/);
  });

  it('says it was not checked when the rulebook switches coverage off with "none"', () => {
    settings('none');
    write('modules/a.ts', 'changed\n');
    expect(coverageCheck(root)).toEqual({ ok: true, lines: ['not checked: coverage (checks.testQuality.coverage is "none")'] });
    expect(said(undefined, null)).toEqual(['Coverage: not checked: coverage (checks.testQuality.coverage is "none").']);
  });

  it('says there is no code to ask about when the change touches none', () => {
    settings();
    write('notes.md', 'prose\n');
    writeReport(root, lcovOf(answerOf({ 'modules/a.ts': [[4, 4], [0, 0]] })));
    const { result, analysis } = verified();
    expect(said(result, analysis)).toEqual(['Coverage: this change adds or changes no code, so no new line needs a test.']);
  });

  // Touched and fully covered is a different fact from nothing touched.
  it('says every new line runs under a test when the change touches code and a test runs all of it', () => {
    settings();
    write('modules/a.ts', 'one\nTWO\nthree\nfour\n');
    writeReport(root, lcovOf(missed({ 'modules/a.ts': [] })));
    const { result, analysis } = verified();
    expect(said(result, analysis)).toEqual(['Coverage: every new line this change added runs under some test.']);
  });

  it('says there is nothing to measure from without a baseline', () => {
    settings();
    git('update-ref', '-d', 'refs/remotes/origin/main');
    writeReport(root, lcovOf(answerOf({ 'modules/a.ts': [[4, 4], [0, 0]] })));
    const { result, analysis } = verified();
    expect(said(result, analysis)).toEqual(['Coverage: there is no baseline to measure the new lines from.']);
  });

  // Turn end refuses a pass without readable evidence, so these are what a
  // result that reached the message without an analysis says.
  it('says what verify did not supply, and reads no file', () => {
    settings();
    write('modules/a.ts', 'changed\n');
    expect(said(undefined, null)).toEqual(['Coverage: verify supplied no coverage result.']);
    expect(said({ outcome: 'skipped', reason: 'skipped for a reason.' }, null)).toEqual(['Coverage: skipped for a reason.']);
    expect(said({ outcome: 'clean', reason: 'clean' }, null)).toEqual(['Coverage: verify supplied no coverage analysis.']);
  });

  it('publishes nothing when the coverage report is missing', () => {
    settings();
    write('modules/a.ts', 'changed\n');
    const { result, analysis } = verified();
    expect(result.outcome).toBe('broken');
    expect(result).not.toHaveProperty('snapshots');
    expect(analysis).toBeUndefined();
  });
});
