/**
 * The referee verify, run as the `Stop` hook runs it, in a repository whose
 * adapter is stubs. The referee's own checks run for real against it. The stubs
 * write a mark when they run, so a case can see what ran, and in what order.
 *
 * Every case here starts verify as a process, so mutation testing leaves this
 * file out: a mutant is never on in another process. The order of the steps,
 * which can be read in process, is in `referee-verify.test.mjs`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REGISTERED } from '../../support/machine/harness.mjs';
import { configureTarget, markTarget } from '../../fixtures/workflow/target.mjs';
import { mutant, mutationCommand, writeReport } from '../../fixtures/workflow/mutation-report.mjs';
import { fixtureMutation, writeConfig } from '../../fixtures/workflow/adapter.mjs';

const VERIFY = resolve('src/workflow/cli/verify-change.ts');
const TSX = resolve('node_modules/tsx/dist/loader.mjs');

/** A command that appends `name` to `ran.txt`, then prints `answer`, if any. */
const mark = (name, answer) =>
  `node -e "require('fs').appendFileSync('ran.txt', '${name}\\n');${answer ? ` console.log(JSON.stringify(${answer}))` : ''}" --`;
/**
 * A compile command that marks that it ran, prints `line` if given, and exits
 * with `exit`. The fixture's `code.compile` reads it with `PATTERN`, and
 * 1 means it found errors.
 */
const compiler = (line, exit = 0) =>
  `node -e "require('fs').appendFileSync('ran.txt', 'compile\\n');${line ? ` console.log('${line}');` : ''} process.exitCode = ${exit}"`;
const COMPILE = { command: compiler(), pattern: '^(?<file>[^:\\n]+):(?<line>\\d+): (?<message>.*)$', exitCodes: { 0: 'clean', 1: 'errors' } };

/**
 * The fixture's test command: it marks that it ran, then writes the JUnit
 * report the referee reads from `cases.json`, as `{ file, title, failed,
 * reason? }` entries, or `cases.json`'s `raw` text as it stands. It exits 1
 * when a case failed, as a runner does.
 */
const TEST_COMMAND = `const fs = require('fs');
fs.appendFileSync('ran.txt', 'tests\\n');
console.log('Test runner output is plain text.');
const given = JSON.parse(fs.readFileSync('cases.json', 'utf8'));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
fs.mkdirSync('reports/junit', { recursive: true });
fs.writeFileSync('reports/junit/run.xml', given.raw ?? '<testsuites>' + given.cases.map((c) =>
  '<testcase name="' + esc(c.title) + '" file="' + esc(c.file) + '">'
  + (c.failed ? '<failure message="' + esc(c.reason ?? 'failed') + '"/>' : '') + '</testcase>').join('') + '</testsuites>');
process.exitCode = (given.cases ?? []).some((c) => c.failed) ? 1 : 0;
`;

describe('the referee verify', () => {
  let root, fixtureHome;

  const configure = ({ checks = { codeQuality: { boundaries: entry(mark('boundaries')), build: entry(mark('build')) } }, ...more } = {}) => writeConfig(root, {
    fields: { checks: { ...checks, testQuality: { ...checks.testQuality, coverage: checks.testQuality?.coverage ?? 'none', mutation: checks.testQuality?.mutation ?? 'none' } } },
    adapter: {
      run: { command: 'node test-command.cjs', reportPaths: ['reports/junit/*.xml'], tagComment: '^\\s*//' },
      compile: COMPILE,
      ...more,
    },
  });
  const cases = (given) => writeFileSync(join(root, 'cases.json'), JSON.stringify(given));
  const verify = (...args) => spawnSync(process.execPath, ['--import', TSX, VERIFY, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: fixtureHome, CLAUDE_CONFIG_DIR: join(fixtureHome, '.claude') },
  });
  const resultsPath = () => join(root, 'ran-results.json');
  function verifyWithReports() {
    return verify('--results', resultsPath());
  }
  /** The unified results the last run wrote, as one list. */
  const resultsIn = path => { const { results } = JSON.parse(readFileSync(path, 'utf8'));
    return results; };
  /** The JUnit copies the tests result names, or null when the tests did not run. */
  function savedReports() {
    const tests = resultsIn(resultsPath()).find(result => result.name === 'tests');
    if (tests.status === 'skipped') return null;
    return tests.evidence.filter(item => item.role === 'raw').map(item => readFileSync(join(root, item.snapshot), 'utf8'));
  }
  const ran = () => (existsSync(join(root, 'ran.txt')) ? readFileSync(join(root, 'ran.txt'), 'utf8').trim().split('\n') : []);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'referee-verify-')));
    fixtureHome = mkdtempSync(join(tmpdir(), 'referee-verify-home-'));
    mkdirSync(join(root, '.claude/rules'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(REGISTERED));
    writeFileSync(join(root, '.claude/rules/workflow.md'), '# Fixture workflow\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet', '--initial-branch', 'feat/x');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(root);
    writeFileSync(join(root, '.gitignore'), 'ran.txt\nran-results.json\nreports/\n/.katatay/local/\n');
    writeFileSync(join(root, 'test-command.cjs'), TEST_COMMAND);
    writeFileSync(join(root, 'a.test.ts'), "it('works', () => {});\n");
    cases({ cases: [{ file: 'a.test.ts', title: 'works', failed: false }] });
    configure();
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    markTarget(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  it('fails on any compile error, test file or not, and runs nothing after it', () => {
    const prior = verifyWithReports();
    expect(prior.status, prior.stderr).toBe(0);
    expect(savedReports()).toHaveLength(1);
    rmSync(join(root, 'ran.txt'));
    configure({ compile: { ...COMPILE, command: compiler('a.test.ts:3: TS2339: x', 1) } });
    const run = verifyWithReports();
    expect(savedReports()).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('compile — 1 error(s)\n  a.test.ts:3 TS2339: x');
    expect(run.stderr).toContain('verify: failed at compile.');
    expect(ran()).toEqual(['compile']);
    const data = JSON.parse(readFileSync(resultsPath()));
    const compile = data.results.find(item => item.name === 'compile');
    expect(compile.status).toBe('failed');
    expect(readFileSync(join(root, compile.evidence[0].snapshot), 'utf8')).toContain('a.test.ts:3 TS2339: x');
    expect(data.results.find(item => item.name === 'tests')).toMatchObject({ name: 'tests', status: 'skipped', evidence: [], summary: {} });
  });

  // A compiler that broke must never read as a clean one.
  it('refuses when the compiler exits with a code the rulebook does not list, and runs nothing after it', () => {
    configure({ compile: { ...COMPILE, command: compiler('a.test.ts:3: TS2339: x', 7) } });
    const run = verify();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('verify: refused — compile');
    expect(run.stderr).toContain('exited with 7, which "code.compile.exitCodes" does not list, so it means broken');
    expect(ran()).toEqual(['compile']);
  });

  it.each([false, true])('saves the failed suite when SIGTERM stops the command (XML already written: %s)', wroteXML => {
    const command = wroteXML ? 'node test-command.cjs && kill -TERM $$' : 'kill -TERM $$';
    configure({ run: { command, reportPaths: ['reports/junit/*.xml'], tagComment: '^//' } });
    const run = verifyWithReports();
    expect(run.status, run.stderr).toBe(1);
    const tests = resultsIn(resultsPath()).find(item => item.name === 'tests');
    expect(tests).toMatchObject({ status: 'failed', reason: 'Test command stopped by SIGTERM.',
      summary: { total: Number(wroteXML), passed: Number(wroteXML), omittedFiles: wroteXML ? 0 : 1 } });
    const reports = tests.evidence.filter(item => item.role === 'raw').map(item => item.snapshot);
    expect(reports).toHaveLength(Number(wroteXML));
    const snapshot = tests.evidence.find(item => item.role === 'analysis').snapshot;
    expect(JSON.parse(readFileSync(join(root, snapshot), 'utf8'))).toEqual({ version: 1, name: 'tests',
      result: { outcome: 'findings', exitCode: null, reason: 'Test command stopped by SIGTERM.', text: expect.stringContaining('failed') },
      measurement: { reports, cases: wroteXML ? [expect.objectContaining({ name: 'works', status: 'passed' })] : [],
        leftOut: wroteXML ? [] : [{ file: 'a.test.ts', ids: [], scenarios: [], bare: [] }] } });
  });

  /** A check in the new shape, with `over` laid over it. */
  const entry = (command, over = {}) => ({ command, exitCodes: { 0: 'clean', 1: 'findings' }, ...over });

  const withMutation = (command, over = {}) => {
    configure({ checks: { testQuality: { first: entry(mark('first')), mutation: fixtureMutation({ command, timeLimitSeconds: 7, ...over }) },
      codeQuality: { build: entry(mark('build')) } } });
    writeFileSync(join(root, 'feature.ts'), 'export const value = 1;\n');
  };

  it.each([[0, 'clean'], [1, 'survived'], [2, 'nothing']])('reads exit %i and its report in quality-chain order without a live plan', (code, outcome) => {
    const results = join(root, 'reports/results.json');
    const mutants = [mutant('Killed')];
    if (code) mutants.push(mutant('Survived', { id: '2' }));
    withMutation(mutationCommand('complete command output', code, mutants,
      "fs.appendFileSync('ran.txt', 'mutation\\n'); fs.writeFileSync('reports/input', fs.readFileSync(0));"));
    const run = verify('--results', results);
    expect(run.status, run.stderr).toBe(0);
    expect(ran()).toEqual(['compile', 'tests', 'mutation', 'first', 'build']);
    expect(JSON.parse(readFileSync(join(root, 'reports/input')))).toEqual({ budget: 7, verbose: false, targets: [{ file: 'feature.ts' }] });
    const result = resultsIn(results).find(r => r.name === 'mutation');
    expect(result).toMatchObject({ status: code === 2 ? 'partial' : 'ok', summary: { killed: 1, survived: code ? 1 : 0 } });
    expect(run.stdout).toContain('complete command output');
    if (code) expect(run.stdout).toContain('modules/a.ts:1\n  a === b\n    EqualityOperator → a !== b');
    if (code === 2) expect(run.stdout).toContain('inconclusive: 2 mutants');
    expect(existsSync(join(root, '.katatay/state'))).toBe(false);
  });

  it.each([
    ['crash', 'echo crash >&2; exit 9', 'crash'],
    ['silence', 'exit 0', 'printed nothing'],
    ['signal', 'kill -TERM $$', 'SIGTERM'],
    ['missing report', 'echo no-report', 'Mutation report failed'],
    ['invalid report', 'echo invalid > reports/mutation/mutation.json; echo ran', 'Mutation report failed'],
    ['contradiction', mutationCommand('ran', 0, [mutant('Survived')]), 'contradicts'],
    ['hard timeout', 'exec sleep 15', 'was still running after'],
  ])('stops before the next check on %s, even with an old clean report', (_name, command, cause) => {
    withMutation(command, { timeLimitSeconds: 1 });
    writeReport(root);
    const results = join(root, 'reports/results.json');
    const run = verify('--results', results);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('failed at mutation');
    expect(run.stderr).toContain(cause);
    expect(ran()).toEqual(['compile', 'tests']);
    expect(resultsIn(results).find(r => r.name === 'mutation')).toMatchObject({ status: 'failed', reason: 'mutation check broke' });
    expect(resultsIn(results).find(r => r.name === 'build')).toMatchObject({ status: 'skipped', reason: 'An earlier step stopped verification.' });
  });

  it('says coverage was switched off when the rulebook writes "none"', () => {
    configure({ checks: { testQuality: { coverage: 'none' }, codeQuality: { build: entry(mark('build')) } } });
    const run = verify();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('verify: not checked: coverage (checks.testQuality.coverage is "none")');
    expect(ran()).toEqual(['compile', 'tests', 'build']);
  });

  it('refuses a missing coverage entry before running any verify step', () => {
    const path = join(root, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    delete config.checks.testQuality.coverage;
    writeFileSync(path, JSON.stringify(config));
    const run = verify();
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/verify: refused .*checks\.testQuality\.coverage.*"none"/);
    expect(ran()).toEqual([]);
  });

  // The turn-end hook reads it: the results are the receipt's evidence.
  it('writes each check\'s outcome to the results file it is given, whether it passed or not', () => {
    const results = join(root, '..', `results-${process.pid}.json`);
    configure({ checks: { codeQuality: { lint: entry('echo found; exit 1', { onFailure: 'report', runs: 'oncePerPlan' }), build: entry('exit 1') } } });
    try {
      const run = spawnSync(process.execPath, ['--import', TSX, VERIFY, '--results', results], { cwd: root, encoding: 'utf8' });
      expect(run.status).toBe(1);
      const data = JSON.parse(readFileSync(results, 'utf8')).results;
      const lint = data.find(item => item.name === 'lint');
      expect(lint).toMatchObject({ status: 'ok', summary: { outcome: 'findings', exitCode: 1 } });
      expect(readFileSync(join(root, lint.evidence[0].snapshot), 'utf8')).toBe('found');
      expect(data.find(item => item.name === 'build')).toMatchObject({ status: 'failed', summary: { outcome: 'findings', exitCode: 1 } });
    } finally {
      rmSync(results, { force: true });
    }
  });

  it('refuses --results without a file', () => {
    const run = spawnSync(process.execPath, ['--import', TSX, VERIFY, '--results'], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--results needs the file');
  });

  it('refuses a rulebook whose checks are still a name and a command each', () => {
    const path = join(root, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...config, checks: { build: 'make build' } }));
    const run = verify();
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/verify: refused — unknown "checks\.build"\. Allowed keys: testQuality, codeQuality/);
    expect(ran()).toEqual([]);
  });

  // A pass without a step must not read as a pass with it.
  it('says what it did not check, where the adapter says the language lacks it', () => {
    configure({ compile: 'none' });
    const results = join(root, 'step-results.json');
    const run = verify('--results', results);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('verify: not checked: compile (the adapter says "none" in .katatay/rulebook.json)');
    expect(run.stdout).toContain('verify: not checked: coverage');
    const steps = resultsIn(results);
    const named = name => steps.find(step => step.name === name);
    expect(['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace'].map(name => [name, named(name).status])).toEqual([
      ['req:lint', 'ok'], ['req:guard', 'ok'], ['state:verify', 'ok'],
      ['compile', 'skipped'], ['tests', 'ok'], ['req:trace', 'ok'],
    ]);
    expect(named('compile').reason).toContain('not checked: compile');
    expect(named('tests').reason).toBe('Check passed.');
    expect(run.stdout).not.toContain('not checked: inverted tests');
    expect(named('req:trace').reason).toBe('Check passed.');
  });

  it('refuses when a test report cannot be read, rather than reading it as a pass', () => {
    cases({ raw: 'all green' });
    const run = verifyWithReports();
    expect(savedReports()).toEqual([readFileSync(join(root, 'reports/junit/run.xml'), 'utf8')]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/verify: refused — test run: a test report could not be read: reports\/junit\/run\.xml/);
    const results = resultsIn(resultsPath());
    const tests = results.find(result => result.name === 'tests');
    expect(tests).toMatchObject({ status: 'failed',
      evidence: [{ role: 'raw', title: 'JUnit: reports/junit/run.xml' }] });
    expect(Object.keys(tests.summary)).toEqual(['diagnostics']);
    expect(tests.summary.diagnostics).toContain('a test report could not be read');
    expect(results.find(result => result.name === 'req:trace').status).toBe('skipped');
    expect(ran()).toEqual(['compile', 'tests']);
  });

  it.each(['a-valid.xml', 'z-valid.xml'])('preserves every report around malformed XML and keeps its evidence after recovery (%s)', validName => {
    const validXml = '<testsuites/>\n';
    writeFileSync(join(root, 'test-command.cjs'), TEST_COMMAND
      + `fs.writeFileSync('reports/junit/${validName}', ${JSON.stringify(validXml)});\n`);
    cases({ raw: 'all green' });

    const failure = verifyWithReports();
    expect(failure.status, failure.stderr).toBe(1);
    expect(failure.stderr).toContain('a test report could not be read: reports/junit/run.xml');
    const failedResults = resultsIn(resultsPath());
    const failedTests = failedResults.find(result => result.name === 'tests');
    const expected = [
      { name: 'run.xml', bytes: 'all green' },
      { name: validName, bytes: validXml },
    ].sort((a, b) => a.name.localeCompare(b.name));
    expect(failedTests.status).toBe('failed');
    expect(Object.keys(failedTests.summary)).toEqual(['diagnostics']);
    expect(failedTests.summary.diagnostics).toContain('reports/junit/run.xml');
    expect(failedTests.evidence.map(({ role, title }) => ({ role, title }))).toEqual(
      expected.map(({ name }) => ({ role: 'raw', title: `JUnit: reports/junit/${name}` })),
    );
    const archivedFailure = () => failedTests.evidence.map(item => readFileSync(join(root, item.snapshot), 'utf8'));
    expect(archivedFailure()).toEqual(expected.map(item => item.bytes));
    for (const name of ['req:trace', 'boundaries', 'build']) {
      expect(failedResults.find(result => result.name === name)).toMatchObject({ status: 'skipped', evidence: [] });
    }
    expect(ran()).toEqual(['compile', 'tests']);

    rmSync(join(root, 'reports/junit'), { recursive: true });
    expect(archivedFailure()).toEqual(expected.map(item => item.bytes));
    cases({ cases: [{ file: 'a.test.ts', title: 'works', failed: false }] });
    rmSync(join(root, 'ran.txt'));
    const recovery = verifyWithReports();
    expect(recovery.status, recovery.stderr).toBe(0);
    const recoveredTests = resultsIn(resultsPath()).find(result => result.name === 'tests');
    expect(recoveredTests).toMatchObject({ status: 'ok', summary: { total: 1, passed: 1, failed: 0 } });
    expect(savedReports()).toEqual(expected.map(({ name }) => readFileSync(join(root, 'reports/junit', name), 'utf8')));
    expect(savedReports()).not.toContain('all green');
    expect(archivedFailure()).toEqual(expected.map(item => item.bytes));
    expect(ran()).toEqual(['compile', 'tests', 'boundaries', 'build']);
  });

  it('refuses when the config has no test paths', () => {
    writeConfig(root, { adapter: null });
    const run = verify();
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/verify: refused — .*"tests.paths" must be an object/);
  });

  // The referee's own checks run whatever the language, and a project cannot
  // leave them out: a broken catalogue fails before any piece runs.
  it('runs the catalogue checks before any piece of the adapter', () => {
    execFileSync('mkdir', ['-p', join(root, 'requirements/acceptance')]);
    writeFileSync(join(root, 'requirements/acceptance/AC0001__broken.md'), 'not a requirement\n');
    const run = verify();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('verify: failed at req:lint.');
    expect(ran()).toEqual([]);
  });
});
