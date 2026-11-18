/**
 * The probe, in process: each item it runs, what makes it pass and fail, and
 * each break it can be asked to see. Every case is a small repository in a
 * temporary folder whose "tools" are shell commands that copy a prepared
 * report into place, so what the probe reads is exactly what the case wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { draftRulebook, gatherAnswers } from '../workflow/init.mjs';
import { CONFIG, readConfig } from '../workflow/rulebook.mjs';
import { PROBE_STATES } from './probe-states.mjs';
import { answer, parseRequest, probe, type Item, type State } from './probe.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-probe-')));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  write('.gitignore', 'reports/\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });

// ------------------------------------------------------------ the fixtures

interface Case { name: string; file: string; status?: 'passed' | 'failed' | 'skipped' }

const resultXml = { passed: '', failed: '<failure message="expected 1, got 2"/>', skipped: '<skipped/>' };
const junit = (cases: Case[]): string => `<testsuites><testsuite name="s">${cases.map(({ name, file, status = 'passed' }) =>
  `<testcase name="${name}" file="${file}">${resultXml[status]}</testcase>`).join('')}</testsuite></testsuites>`;

/** The test command: copies the prepared report into place, and exits as told. */
function tests(cases: Case[] | null, exit = 0): void {
  if (cases !== null) write('junit.xml', junit(cases));
  write('run-tests.sh', `${cases === null ? '' : 'mkdir -p reports/junit && cp junit.xml reports/junit/r.xml\n'}exit ${exit}\n`);
}

/** The compile command: prints `lines` and exits as told. */
function compiler(lines: string[], exit: number): void {
  write('compile.sh', `${lines.map((line) => `echo '${line}'`).join('\n')}\nexit ${exit}\n`);
}

const lcov = (files: Record<string, [covered: number, total: number]>): string => Object.entries(files).map(([file, [covered, total]]) =>
  [`SF:${file}`, ...Array.from({ length: total }, (_, index) => `DA:${index + 1},${index < covered ? 1 : 0}`), `LF:${total}`, `LH:${covered}`, 'end_of_record'].join('\n')).join('\n');

const mutant = (id: string, status: string) => ({ id, mutatorName: 'Arithmetic', status, location: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } } });
const mutationReport = (statuses: string[]): string => JSON.stringify({
  schemaVersion: '1', thresholds: { high: 80, low: 60 },
  files: { 'src/app.x': { language: 'x', source: 'a+b\n', mutants: statuses.map((status, index) => mutant(String(index), status)) } },
});

/** The mutation command: keeps the question it was asked, writes the prepared
 *  report unless told not to, says `text`, and exits as told. */
function mutator({ statuses = ['Killed'], exit = 0, text = 'checked the mutants', report = true }: { statuses?: string[]; exit?: number; text?: string; report?: boolean } = {}): void {
  write('mutation.json', mutationReport(statuses));
  write('mutate.sh', ['cat > asked.json', ...(report ? ['mkdir -p reports && cp mutation.json reports/mutation.json'] : []),
    ...(text === '' ? [] : [`echo '${text}'`]), `exit ${exit}`, ''].join('\n'));
}

const BASE = {
  'tests.all': ['tests/**'], 'tests.acceptance': ['acceptance/**'], code: ['src/**'],
  'testRun.command': 'sh run-tests.sh', 'testRun.reports': ['reports/junit/*.xml'], 'testRun.tagComment': '^\\s*#',
};
const COMPILE = { 'compile.command': 'sh compile.sh', 'compile.pattern': '^(?<file>[^:]+):(?<line>\\d+): (?<message>.*)$' };
const COVERAGE = { coverage: true, 'coverage.command': 'cat lcov.info', 'coverage.minimum': { 'src/': { lines: 80, branches: 0 } } };
const MUTATION = { mutation: true, 'mutation.command': 'sh mutate.sh', 'mutation.report': 'reports/mutation.json', 'mutation.timeLimitSeconds': 30 };
const proposals = [{ label: 'one', proposal: { locked: ['.one/**'], commands: { check: 'node one.mjs' } } }];

/** A rulebook as `init` drafts it from these answers. */
async function drafted(given: Record<string, unknown> = {}): Promise<unknown> {
  const gathered = await gatherAnswers({ ...BASE, ...given }, null);
  if ('problems' in gathered) throw new Error(gathered.problems!.join('\n'));
  return draftRulebook(gathered.answers, proposals);
}

/** The probe's items for a draft of these answers. */
async function items(given: Record<string, unknown> = {}, expect: State | null = null, scratchModule = 'src/app.x'): Promise<Item[]> {
  return (await answer({ root, config: await drafted(given), expect, scratchModule })).items;
}

const ONE = [{ name: 'adds', file: 'tests/app_test.x' }];

/** One code file and one test file, with a test run that reports the test passing. */
function hello(): void {
  write('src/app.x', 'a+b\n');
  write('tests/app_test.x', '# adds\n');
  tests(ONE);
}

// ------------------------------------------------------------------ tests

describe('the test run', () => {
  it('passes when every test file is in the report and no test failed', async () => {
    hello();
    expect(await items()).toEqual([{ name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), all passing'] }]);
  });

  it('fails when the project has no test file, and runs nothing', async () => {
    write('src/app.x', 'a+b\n');
    write('run-tests.sh', 'touch ran\n');
    const [item] = await items({ 'tests.all': ['tests/**', 'spec/**'] });
    expect(item).toMatchObject({ name: 'tests', passed: false });
    expect(item!.lines[0]).toContain('no file matches "tests.paths.all" (tests/**, spec/**). Write a first passing test');
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('fails when the command wrote no report', async () => {
    hello();
    tests(null, 3);
    const [item] = await items({ 'testRun.reports': ['reports/unit/*.xml', 'reports/integration/*.xml'] });
    expect(item).toEqual({ name: 'tests', passed: false, lines: ['`sh run-tests.sh` wrote no test in a report at reports/unit/*.xml, reports/integration/*.xml (it exited 3)'] });
  });

  it.each([
    ['five', ['a', 'b', 'c', 'd', 'e'], ''],
    ['seven', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ', and 2 more'],
  ] as const)('names at most five omitted files and explains how to fix the report (%s omitted)', async (_, names, remainder) => {
    hello();
    for (const name of names) write(`tests/${name}.x`, '# omitted\n');
    const firstFive = 'tests/a.x, tests/b.x, tests/c.x, tests/d.x, tests/e.x';
    expect(await items()).toEqual([{ name: 'tests', passed: false, lines: [
      `left out of the report: ${firstFive}${remainder}. A test file the report leaves out counts as failed to load. Make the command report it, or narrow "tests.paths.all"`,
    ] }]);
  });

  it('fails when a test failed, and names it', async () => {
    hello();
    tests([{ ...ONE[0]!, status: 'failed' }], 1);
    expect(await items()).toEqual([{ name: 'tests', passed: false, lines: ['1 failed of 1 test(s) in 1 file(s)', 'tests/app_test.x: adds'] }]);
  });

  it('stops before coverage and mutation if every reported case was skipped', async () => {
    hello();
    tests([{ ...ONE[0]!, status: 'skipped' }]);
    expect(await items({ ...COVERAGE, ...MUTATION })).toEqual([
      { name: 'tests', passed: false, lines: ['1 test(s) in 1 file(s), no test passed (1 skipped)'] },
    ]);
  });

  it('prints the passed and skipped counts when a suite has both', async () => {
    hello();
    tests([...ONE, { name: 'subtracts', file: 'tests/app_test.x', status: 'skipped' }]);
    expect(await items()).toEqual([{ name: 'tests', passed: true, lines: ['2 test(s) in 1 file(s), 1 passed, 1 skipped'] }]);
  });

  it('fails when the command exited non-zero while no test failed', async () => {
    hello();
    tests(ONE, 1);
    const [item] = await items();
    expect(item!.passed).toBe(false);
    expect(item!.lines[0]).toBe('1 failed of 1 test(s) in 1 file(s)');
  });

  it('fails when git does not ignore the reports', async () => {
    hello();
    write('.gitignore', '');
    const [item] = await items();
    expect(item).toEqual({ name: 'tests', passed: false, lines: [
      'git does not ignore the reports the command wrote (reports/junit/r.xml). Reports are output: add their folder to .gitignore',
    ] });
  });

  it('fails with the reader\'s own words for a report it cannot read', async () => {
    hello();
    write('junit.xml', '<testsuites><testsuite><testcase name="adds" file="tests/missing_test.x"/></testsuite></testsuites>');
    const [item] = await items();
    expect(item).toMatchObject({ name: 'tests', passed: false });
    expect(item!.lines[0]).toMatch(/^test run: /);
  });
});

describe('a failing test, looked for', () => {
  it('counts all six failures but displays only the first five in ordinary and expected-failure probes', async () => {
    hello();
    const file = 'tests/app_test.x';
    tests(['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ file, name, status: 'failed' })), 1);
    const shown = ['a', 'b', 'c', 'd', 'e'].map(name => `${file}: ${name}`);
    expect(await items()).toEqual([{ name: 'tests', passed: false, lines: ['6 failed of 6 test(s) in 1 file(s)', ...shown] }]);
    expect(await items({}, 'failing-test')).toEqual([{ name: 'tests', passed: true, lines: ['6 test(s) in 1 file(s), 6 failed', ...shown] }]);
  });

  it('does not count a skipped test as the expected failure', async () => {
    hello();
    tests([{ ...ONE[0]!, status: 'skipped' }]);
    expect(await items({}, 'failing-test')).toEqual([
      { name: 'tests', passed: false, lines: ['expected a failed test, and none of 1 test(s) in 1 file(s) failed'] },
    ]);
  });

  it('is seen', async () => {
    hello();
    tests([{ ...ONE[0]!, status: 'failed' }], 1);
    expect(await items({}, 'failing-test')).toEqual([{ name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), 1 failed', 'tests/app_test.x: adds'] }]);
  });

  it('is missed when every test passes', async () => {
    hello();
    expect(await items({}, 'failing-test')).toEqual([{ name: 'tests', passed: false, lines: ['expected a failed test, and none of 1 test(s) in 1 file(s) failed'] }]);
  });

  it('is not a test file left out of the report', async () => {
    hello();
    write('tests/other_test.x', '# subtracts\n');
    const [item] = await items({}, 'failing-test');
    expect(item!.passed).toBe(false);
    expect(item!.lines[0]).toContain('left out of the report');
  });

  it('stops the probe at the test run', async () => {
    hello();
    tests([{ ...ONE[0]!, status: 'failed' }], 1);
    write('lcov.info', 'not lcov');
    expect((await items(COVERAGE, 'failing-test')).map(({ name }) => name)).toEqual(['tests']);
  });
});

describe('compile', () => {
  beforeEach(hello);

  it('passes when it is clean, and the test run follows', async () => {
    compiler([], 0);
    expect(await items(COMPILE)).toEqual([
      { name: 'compile', passed: true, lines: ['clean'] },
      { name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), all passing'] },
    ]);
  });

  it('is left out when the project has no compile step', async () => {
    expect((await items()).map(({ name }) => name)).toEqual(['tests']);
  });

  it('fails for an error, names it, and runs no test', async () => {
    compiler(['src/app.x:3: unknown name b'], 1);
    write('run-tests.sh', 'touch ran\n');
    expect(await items(COMPILE)).toEqual([{ name: 'compile', passed: false, lines: ['1 error(s)', 'src/app.x:3 unknown name b'] }]);
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('fails when its exit code and the pattern disagree', async () => {
    compiler(['something went wrong'], 1);
    const [item] = await items(COMPILE);
    expect(item).toMatchObject({ name: 'compile', passed: false });
    expect(item!.lines[0]).toContain('"code.compile.pattern" matched none in its output');
  });

  it('reports the full compiler error count and details of just the first five', async () => {
    compiler([1, 2, 3, 4, 5, 6].map(n => `src/app.x:${n}: error ${n}`), 1);
    expect(await items(COMPILE)).toEqual([{ name: 'compile', passed: false, lines: [
      '6 error(s)', ...[1, 2, 3, 4, 5].map(n => `src/app.x:${n} error ${n}`),
    ] }]);
  });

  it('fails for an exit code the rulebook does not list', async () => {
    compiler([], 7);
    expect((await items(COMPILE))[0]!.lines[0]).toContain('exited with 7, which "code.compile.exitCodes" does not list');
  });
});

describe('a compile error, looked for', () => {
  beforeEach(hello);

  it('in code is seen, also beside one in a test', async () => {
    compiler(['src/app.x:3: unknown name b', 'tests/app_test.x:1: unknown name c'], 1);
    expect(await items(COMPILE, 'compile-error-in-code')).toEqual([{ name: 'compile', passed: true,
      lines: ['the pattern read 2 error(s), 1 in code', 'src/app.x:3 unknown name b', 'tests/app_test.x:1 unknown name c'] }]);
  });

  it('in code is missed when compile is clean, and when every error is in a test', async () => {
    compiler([], 0);
    expect(await items(COMPILE, 'compile-error-in-code')).toEqual([{ name: 'compile', passed: false, lines: ['expected an error in a code file, and compile was clean'] }]);
    compiler(['tests/app_test.x:1: unknown name c'], 1);
    expect(await items(COMPILE, 'compile-error-in-code')).toEqual([{ name: 'compile', passed: false,
      lines: ['expected an error in a code file, and every error read is in a test file', 'tests/app_test.x:1 unknown name c'] }]);
  });

  it('in a test is seen', async () => {
    compiler(['tests/app_test.x:1: unknown name c'], 1);
    expect(await items(COMPILE, 'compile-error-in-test')).toEqual([{ name: 'compile', passed: true,
      lines: ['the pattern read 1 error(s), all in test files', 'tests/app_test.x:1 unknown name c'] }]);
  });

  it('in a test is missed when compile is clean, and when an error is in code', async () => {
    compiler([], 0);
    expect(await items(COMPILE, 'compile-error-in-test')).toEqual([{ name: 'compile', passed: false, lines: ['expected an error in a test file, and compile was clean'] }]);
    compiler(['src/app.x:3: unknown name b', 'tests/app_test.x:1: unknown name c'], 1);
    expect((await items(COMPILE, 'compile-error-in-test'))[0]).toMatchObject({ passed: false, lines: expect.arrayContaining(['expected errors in test files only, and 1 are in code']) });
  });

  it('is still a failure when the compiler itself broke', async () => {
    compiler(['something went wrong'], 1);
    expect((await items(COMPILE, 'compile-error-in-code'))[0]!.passed).toBe(false);
  });
});

describe('coverage', () => {
  beforeEach(hello);

  it('passes when the report is complete and every folder meets its minimum', async () => {
    write('lcov.info', lcov({ 'src/app.x': [9, 10] }));
    expect((await items(COVERAGE)).at(-1)).toEqual({ name: 'coverage', passed: true, lines: [expect.stringMatching(/^src\/\s+lines\s+90\.0% \(minimum 80\.0%\)/)] });
  });

  it('is left out when coverage is off', async () => {
    expect((await items()).map(({ name }) => name)).toEqual(['tests']);
  });

  it('fails when the command exits non-zero', async () => {
    const coverage = await items({ ...COVERAGE, 'coverage.command': 'echo no report >&2; exit 4' });
    expect(coverage.at(-1)).toEqual({ name: 'coverage', passed: false, lines: ['broke: coverage command exited 4', 'no report'] });
  });

  it('fails for a report it cannot read', async () => {
    write('lcov.info', 'not lcov\n');
    const item = (await items(COVERAGE)).at(-1)!;
    expect(item).toMatchObject({ name: 'coverage', passed: false });
    expect(item.lines[0]).toContain('coverage command stdout, line 1');
  });

  it('fails when a code file is not in the report', async () => {
    write('src/other.x', 'c\n');
    write('lcov.info', lcov({ 'src/app.x': [10, 10] }));
    const item = (await items(COVERAGE)).at(-1)!;
    expect(item.passed).toBe(false);
    expect(item.lines.join('\n')).toContain('code, but not in the coverage report: src/other.x');
  });

  it('does not ask for a test file or a file outside the measured folders', async () => {
    write('lib/extra.x', 'c\n');
    write('src/app_test.x', '# subtracts\n');
    tests([...ONE, { name: 'subtracts', file: 'src/app_test.x' }]);
    write('lcov.info', lcov({ 'src/app.x': [10, 10] }));
    const all = await items({ ...COVERAGE, 'tests.all': ['**/*_test.x'], code: ['**/*.x'] });
    expect(all).toEqual([
      { name: 'tests', passed: true, lines: ['2 test(s) in 2 file(s), all passing'] },
      { name: 'coverage', passed: true, lines: expect.any(Array) },
    ]);
  });

  it('fails when a folder is below its minimum', async () => {
    write('lcov.info', lcov({ 'src/app.x': [5, 10] }));
    const item = (await items(COVERAGE)).at(-1)!;
    expect(item.passed).toBe(false);
    expect(item.lines.join('\n')).toContain('src/: line coverage is 50.0%, below the minimum of 80.0%');
  });
});

describe('a folder below its minimum, looked for', () => {
  beforeEach(hello);

  it('is seen', async () => {
    write('lcov.info', lcov({ 'src/app.x': [5, 10] }));
    const item = (await items(COVERAGE, 'below-minimum')).at(-1)!;
    expect(item).toMatchObject({ name: 'coverage', passed: true });
    expect(item.lines[0]).toBe('the report is complete and a folder is below its minimum');
    expect(item.lines[1]).toContain('below the minimum of 80.0%');
  });

  it('is missed when every folder meets its minimum', async () => {
    write('lcov.info', lcov({ 'src/app.x': [10, 10] }));
    expect((await items(COVERAGE, 'below-minimum')).at(-1)!).toMatchObject({ passed: false, lines: expect.arrayContaining(['expected a folder below its minimum, and every folder meets it']) });
  });

  it('is missed when the report has another problem beside it', async () => {
    write('src/other.x', 'c\n');
    write('lcov.info', lcov({ 'src/app.x': [5, 10] }));
    expect((await items(COVERAGE, 'below-minimum')).at(-1)!).toMatchObject({ passed: false,
      lines: expect.arrayContaining(['expected only a folder below its minimum, and the report has other problems']) });
  });

  it('needs every test passing first', async () => {
    tests([{ ...ONE[0]!, status: 'failed' }], 1);
    write('lcov.info', lcov({ 'src/app.x': [5, 10] }));
    expect((await items(COVERAGE, 'below-minimum')).at(-1)).toMatchObject({ name: 'tests', passed: false });
  });

  it('stops the probe at coverage', async () => {
    write('lcov.info', lcov({ 'src/app.x': [5, 10] }));
    mutator({ exit: 3 });
    expect((await items({ ...COVERAGE, ...MUTATION }, 'below-minimum')).map(({ name }) => name)).toEqual(['tests', 'coverage']);
  });
});

describe('mutation', () => {
  beforeEach(hello);

  it('asks about only the selected module within the configured budget', async () => {
    write('src/another.x', 'c\n');
    write('src/deleted.x', 'removed\n');
    git('add', 'src/deleted.x');
    rmSync(join(root, 'src/deleted.x'));
    mutator({ statuses: ['Killed', 'Timeout'] });
    git('add', 'src/app.x');
    expect((await items(MUTATION, null, './src/app.x')).at(-1)).toEqual({ name: 'mutation', passed: true, lines: ['2 mutant(s): 2 caught, 0 survived'] });
    expect(JSON.parse(readFileSync(join(root, 'asked.json'), 'utf8'))).toEqual({
      targets: [{ file: 'src/app.x' }], budget: 30, verbose: false,
    });
  });

  it('passes with survivors, and counts them', async () => {
    mutator({ statuses: ['Killed', 'Survived'], exit: 1 });
    expect((await items(MUTATION)).at(-1)).toEqual({ name: 'mutation', passed: true, lines: ['2 mutant(s): 1 caught, 1 survived'] });
  });

  it('is left out when mutation is off', async () => {
    expect((await answer({ root, config: await drafted(), expect: null })).items.map(({ name }) => name)).toEqual(['tests']);
  });

  it('fails for a run that checked nothing', async () => {
    mutator({ statuses: [], exit: 2, text: 'no test reaches these files' });
    expect((await items(MUTATION)).at(-1)).toEqual({ name: 'mutation', passed: false, lines: ['the command exited 2: the run checked nothing', 'no test reaches these files'] });
  });

  it('fails for a crash', async () => {
    mutator({ exit: 3 });
    expect((await items(MUTATION)).at(-1)!.lines[0]).toContain('exited with 3, which means it crashed');
  });

  it('fails when the command says nothing', async () => {
    mutator({ text: '' });
    expect((await items(MUTATION)).at(-1)!.lines[0]).toContain('printed nothing');
  });

  it('fails when the command wrote no report, and when the report contradicts its exit', async () => {
    mutator({ report: false });
    expect((await items(MUTATION)).at(-1)).toMatchObject({ name: 'mutation', passed: false });
    mutator({ statuses: ['Survived'], exit: 0 });
    expect((await items(MUTATION)).at(-1)!.lines[0]).toBe('report contradicts the command\'s clean outcome');
  });

  it('does not read a report an earlier run left', async () => {
    mutator();
    expect((await items(MUTATION)).at(-1)!.passed).toBe(true);
    mutator({ report: false });
    expect((await items(MUTATION)).at(-1)!.passed).toBe(false);
  });

  it('fails when git does not ignore the report', async () => {
    mutator();
    const item = (await items({ ...MUTATION, 'mutation.report': 'mutation-out.json' })).at(-1)!;
    expect(item).toEqual({ name: 'mutation', passed: false, lines: ['check output mutation-out.json: output must be ignored by git'] });
  });

  it('asks for a scratch module when mutation is enabled and no path was supplied', async () => {
    mutator();
    const run = await answer({ root, config: await drafted(MUTATION), expect: null });
    expect(run.items.at(-1)).toEqual({ name: 'mutation', passed: false, lines: [expect.stringContaining('supply --scratch-module <file>')] });
    expect(existsSync(join(root, 'asked.json'))).toBe(false);
  });

  it.each(['src/app.x', 'tests/app_test.x', 'fixtures/data.x', 'src/skip.x'])('refuses ineligible code, tests, support and exclusions: %s', async (scratchModule) => {
    write('fixtures/data.x', 'd\n');
    write('src/skip.x', '1\n');
    const config = await drafted({ ...MUTATION, code: ['tests/**', 'fixtures/**', 'src/skip.x'], testSupport: ['fixtures/**'] }) as {
      checks: { testQuality: { mutation: { excludePaths: string[] } } };
    };
    config.checks.testQuality.mutation.excludePaths = ['src/skip.x'];
    mutator();
    const run = await answer({ root, config, expect: null, scratchModule });
    expect(run.items.at(-1)).toEqual({ name: 'mutation', passed: false, lines: [expect.stringContaining('mutation exclusions')] });
    expect(existsSync(join(root, 'asked.json'))).toBe(false);
  });

  it('refuses absolute and parent-relative paths before invoking the mutator', async () => {
    for (const path of [join(root, 'src/app.x'), 'src/../src/app.x']) {
      expect((await items(MUTATION, null, path)).at(-1)).toEqual({
        name: 'mutation', passed: false, lines: [expect.stringContaining('inside the project by its relative path')],
      });
    }
    expect(existsSync(join(root, 'asked.json'))).toBe(false);
  });

  it('requires an existing regular file Git tracks or would track, without symlinks', async () => {
    write('.gitignore', 'reports/\nsrc/ignored.x\n');
    write('src/ignored.x', 'a\n');
    symlinkSync('app.x', join(root, 'src/link.x'));
    mkdirSync(join(root, 'src/folder.x'));
    for (const file of ['src/ignored.x', 'src/link.x', 'src/folder.x', 'src/missing.x']) {
      expect((await items(MUTATION, null, file)).at(-1)).toEqual({
        name: 'mutation', passed: false, lines: [expect.stringContaining('regular file Git tracks or would track')],
      });
    }
    expect(existsSync(join(root, 'asked.json'))).toBe(false);
  });
});

describe('a surviving mutant, looked for', () => {
  beforeEach(hello);

  it('is seen, and named', async () => {
    mutator({ statuses: ['Killed', 'Survived'], exit: 1 });
    expect((await items(MUTATION, 'survivors')).at(-1)).toEqual({ name: 'mutation', passed: true, lines: ['2 mutant(s): 1 caught, 1 survived', 'src/app.x:1 Arithmetic'] });
  });

  it('fails when the only survivor is in another eligible module', async () => {
    write('src/other.x', 'b+c\n');
    mutator({ statuses: ['Survived'], exit: 1 });
    expect((await items(MUTATION, 'survivors', 'src/other.x')).at(-1)).toEqual({
      name: 'mutation', passed: false, lines: ['the report contains no confirmed survivor in src/other.x', '1 mutant(s): 0 caught, 1 survived'],
    });
  });

  it('is missed when every mutant was caught, and when the run checked nothing', async () => {
    mutator();
    expect((await items(MUTATION, 'survivors')).at(-1)).toEqual({ name: 'mutation', passed: false,
      lines: ['expected a surviving mutant, and the command\'s outcome was clean', '1 mutant(s): 1 caught, 0 survived'] });
    mutator({ statuses: [], exit: 2 });
    expect((await items(MUTATION, 'survivors')).at(-1)!.lines[0]).toBe('expected a surviving mutant, and the command\'s outcome was nothing');
  });

  it('stops the probe before the other checks', async () => {
    mutator({ statuses: ['Survived'], exit: 1 });
    const lint = { command: 'exit 9', exitCodes: { 0: 'clean', 1: 'findings' } };
    expect((await items({ ...MUTATION, 'checks.codeQuality': { lint } }, 'survivors')).map(({ name }) => name)).toEqual(['tests', 'mutation']);
  });
});

describe('the other checks', () => {
  beforeEach(hello);
  const codes = { 0: 'clean', 1: 'findings' };
  const checked = async (lint: Record<string, unknown>) => (await items({ 'checks.codeQuality': { lint } })).at(-1)!;

  it('pass when clean, each in the order the rulebook lists them', async () => {
    const all = await items({ 'checks.codeQuality': { lint: { command: 'true', exitCodes: codes }, build: { command: 'true', exitCodes: codes } } });
    expect(all.slice(1)).toEqual([{ name: 'lint', passed: true, lines: ['clean'] }, { name: 'build', passed: true, lines: ['clean'] }]);
  });

  it('fail for findings that block, with what the tool said', async () => {
    expect(await checked({ command: 'echo "app.x: unused name"; exit 1', exitCodes: codes })).toEqual({ name: 'lint', passed: false, lines: ['findings (exit 1)', 'app.x: unused name'] });
  });

  it('pass for findings that are only reported', async () => {
    expect(await checked({ command: 'exit 1', exitCodes: codes, onFailure: 'report' })).toEqual({ name: 'lint', passed: true, lines: ['findings (exit 1)'] });
  });

  it('fail for an exit code the rulebook does not list, also when findings are only reported', async () => {
    const item = await checked({ command: 'exit 9', exitCodes: codes, onFailure: 'report' });
    expect(item.passed).toBe(false);
    expect(item.lines[0]).toContain('exited 9, which "checks.codeQuality.lint.exitCodes" does not list');
  });

  it('stop at the first that fails', async () => {
    const all = await items({ 'checks.codeQuality': { lint: { command: 'exit 1', exitCodes: codes }, build: { command: 'true', exitCodes: codes } } });
    expect(all.map(({ name }) => name)).toEqual(['tests', 'lint']);
  });

  it('are given every file git knows as the changed files', async () => {
    await checked({ command: 'echo {changedFiles} > reports/files.txt', exitCodes: codes });
    const files = execFileSync('cat', [join(root, 'reports/files.txt')], { encoding: 'utf8' }).trim().split(' ').sort();
    expect(files).toEqual(['.gitignore', 'junit.xml', 'run-tests.sh', 'src/app.x', 'tests/app_test.x']);
  });

  it('are given the newest commit as the baseline, and fail when there is none', async () => {
    const check = { command: 'echo {baseline} > reports/baseline.txt', exitCodes: codes };
    const item = await checked(check);
    expect(item).toMatchObject({ name: 'lint', passed: false });
    expect(item.lines[0]).toMatch(/^could not be run: /);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'first');
    expect((await checked(check)).passed).toBe(true);
    expect(execFileSync('cat', [join(root, 'reports/baseline.txt')], { encoding: 'utf8' }).trim()).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('are not run when a break is looked for', async () => {
    tests([{ ...ONE[0]!, status: 'failed' }], 1);
    expect((await items({ 'checks.codeQuality': { lint: { command: 'true', exitCodes: codes } } }, 'failing-test')).map(({ name }) => name)).toEqual(['tests']);
  });
});

describe('every item together', () => {
  it('runs in verify\'s order: compile, the tests, coverage, mutation, then the other checks', async () => {
    hello();
    compiler([], 0);
    write('lcov.info', lcov({ 'src/app.x': [10, 10] }));
    mutator();
    const all = await items({ ...COMPILE, ...COVERAGE, ...MUTATION, 'checks.codeQuality': { lint: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' } } } });
    expect(all.map(({ name, passed }) => [name, passed])).toEqual([['compile', true], ['tests', true], ['coverage', true], ['mutation', true], ['lint', true]]);
  });
});

describe('a break whose item is switched off', () => {
  beforeEach(hello);

  it.each([
    ['compile-error-in-code', 'compile-error-in-code cannot be probed: "code.compile" is "none"'],
    ['compile-error-in-test', 'compile-error-in-test cannot be probed: "code.compile" is "none"'],
    ['below-minimum', 'below-minimum cannot be probed: "checks.testQuality.coverage" is "none"'],
    ['survivors', 'survivors cannot be probed: "checks.testQuality.mutation" is "none"'],
  ] as [State, string][])('%s is refused, and nothing is run', async (state, refused) => {
    write('run-tests.sh', 'touch ran\n');
    expect(await answer({ root, config: await drafted(), expect: state })).toEqual({ items: [], refused });
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('is not refused when its item is on', async () => {
    compiler([], 0);
    write('lcov.info', lcov({ 'src/app.x': [10, 10] }));
    mutator();
    for (const state of PROBE_STATES as State[]) {
      expect((await answer({ root, config: await drafted({ ...COMPILE, ...COVERAGE, ...MUTATION }), expect: state })).refused, state).toBeUndefined();
    }
  });
});

describe('the rulebook the probe reads', () => {
  beforeEach(hello);

  it('is the draft, which is never written, and is forgotten afterwards', async () => {
    expect((await items())[0]!.passed).toBe(true);
    expect(existsSync(join(root, CONFIG))).toBe(false);
    expect(() => readConfig(root)).toThrow(/there is no \.katatay\/rulebook\.json/);
  });

  it('is the project\'s own when no draft is sent', async () => {
    write(CONFIG, JSON.stringify(await drafted()));
    expect((await answer({ root, expect: null })).items).toEqual([{ name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), all passing'] }]);
    expect((await probe({ root })).items[0]!.passed).toBe(true);
  });

  it('is said to be missing or refused, as one failed item', async () => {
    expect(await answer({ root, expect: null })).toEqual({ items: [{ name: 'rulebook', passed: false, lines: [expect.stringContaining('there is no .katatay/rulebook.json')] }] });
    const bad = await answer({ root, config: { version: 1 }, expect: null });
    expect(bad.items).toEqual([{ name: 'rulebook', passed: false, lines: [expect.any(String)] }]);
  });
});

describe('the request', () => {
  it('names the project, and may carry a draft and a break', () => {
    expect(parseRequest(JSON.stringify({ root: '/p' }))).toEqual({ root: '/p', expect: null });
    expect(parseRequest(JSON.stringify({ root: '/p', expect: null }))).toEqual({ root: '/p', expect: null });
    const request = { root: '/p', config: { version: 1 }, expect: 'survivors', scratchModule: 'src/demo.x' };
    expect(parseRequest(JSON.stringify(request))).toEqual(request);
  });

  it.each([
    ['{', /^the request is not JSON \(.+\)$/],
    ['null', /^the request names no "root"$/],
    ['"/p"', /^the request names no "root"$/],
    ['{"root":1}', /^the request names no "root"$/],
    ['{"root":"/p","scratchModule":42}', /^scratchModule must be a project-relative file path$/],
    ['{"root":"/p","expect":"red"}', /^"expect" is "red", which is not one of compile-error-in-code, compile-error-in-test, failing-test, below-minimum, survivors$/],
  ])('refuses %s', (text, problem) => {
    expect(parseRequest(text)).toEqual({ problem: expect.stringMatching(problem) });
  });
});
