/**
 * Running one check: its placeholders, its time limit, and what its exit code
 * means. Verify runs every check through this; `referee-verify.process.test.mjs`
 * covers that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineSha, commandWith, filesOnDisk, placeholdersIn, runCheck, shellQuote } from './checks.mjs';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';

const node = (code) => `node -e ${JSON.stringify(code)}`;
/** A check as `parseChecks` gives one, with `over` laid over it. */
const check = (command, over = {}) => ({
  name: 'lint', chain: 'codeQuality', command, exitCodes: { 0: 'clean', 1: 'findings' },
  runs: 'always', onFailure: 'block', timeLimitSeconds: 10, suppressions: [], ...over,
});
/** A baseline nobody should have to ask for. */
const unasked = () => { throw new Error('the baseline was asked for'); };

describe('a check\'s placeholders', () => {
  it('are found in the command', () => {
    expect(placeholdersIn('lint')).toEqual({ baseline: false, changedFiles: false });
    expect(placeholdersIn('lint {changedFiles} --since {baseline}')).toEqual({ baseline: true, changedFiles: true });
  });

  it('are filled in wherever they appear, the files each quoted', () => {
    expect(commandWith('lint {changedFiles} --since {baseline} {baseline}', { baseline: 'abc', files: ['a.ts', 'b c.ts'] }))
      .toBe("lint 'a.ts' 'b c.ts' --since abc abc");
  });

  // A file name is data. Quoted, a shell reads it back as it was, whatever
  // it holds.
  it('quote a file name so a shell reads it back as it was', () => {
    for (const name of ['plain.ts', 'with space.ts', "it's.ts", 'a;rm -rf x.ts', '$(boom).ts', 'src/[id]/(group)/page.tsx']) {
      expect(spawnSync(`printf %s ${shellQuote(name)}`, { shell: true, encoding: 'utf8' }).stdout, name).toBe(name);
    }
  });
});

describe('running a check', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'checks-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (command, over, options = {}) => runCheck(check(command, over), { root, baseline: unasked, ...options });

  it('reads an exit code the rulebook lists as what it says', () => {
    expect(run('exit 0')).toEqual({ outcome: 'clean', code: 0, text: '', reason: 'clean' });
    expect(run(node('console.log("one finding"); process.exit(1)'))).toEqual({ outcome: 'findings', code: 1, text: 'one finding', reason: 'findings (exit 1)' });
  });

  it('reads a code inside a range as the range says', () => {
    expect(run('exit 7', { exitCodes: { 0: 'clean', 1: 'findings', 2: 'findings', 7: 'findings' } }).outcome).toBe('findings');
  });

  it.each([[0, 'clean'], [1, 'findings']])('keeps ordinary testQuality output on exit %i', (code, outcome) => {
    const result = run(`echo audit-result; exit ${code}`, { name: 'audit', chain: 'testQuality' });
    expect(result).toMatchObject({ code, outcome, text: 'audit-result' });
  });

  // A crash must never read as a clean run or as findings.
  it('reads a code the rulebook does not list as broken, and names where it would be listed', () => {
    const result = run('exit 3');
    expect(result).toMatchObject({ outcome: 'broken', code: 3 });
    expect(result.reason).toBe('broke: exited 3, which "checks.codeQuality.lint.exitCodes" does not list');
  });

  it('reads a code the rulebook says means broken as broken', () => {
    expect(run('exit 2', { exitCodes: { 0: 'clean', 1: 'findings', 2: 'broken' } }))
      .toMatchObject({ outcome: 'broken', reason: 'broke: exited 2, which its exit codes say means broken' });
  });

  it('reads a run stopped by a signal as broken', () => {
    expect(run('kill -TERM $$')).toMatchObject({ outcome: 'broken', code: null, reason: 'broke: stopped by SIGTERM' });
  });

  it('keeps what it printed, stdout then stderr, without the trailing space', () => {
    expect(run(node('console.log("out"); console.error("err\\n\\n"); process.exit(1)')).text).toBe('out\nerr');
  });

  it('runs from the repository root', () => {
    writeFileSync(join(root, 'here.txt'), 'found');
    expect(run(node('process.stdout.write(require("fs").readFileSync("here.txt", "utf8")); process.exit(1)')).text).toBe('found');
  });

  // A check that names no placeholder runs where there is no target at all.
  it('asks for no baseline when the command names no placeholder', () => {
    expect(run('exit 0').outcome).toBe('clean');
  });

  it('gives the command the baseline and the changed files', () => {
    const result = run(node('console.log(process.argv.slice(1).join("|")); process.exit(1)') + ' {baseline} {changedFiles}', {}, {
      baseline: () => 'abc123', files: (base) => [`${base}.ts`, 'b c.ts'],
    });
    expect(result.text).toBe('abc123|abc123.ts|b c.ts');
  });

  it('fills in the baseline when that is the only placeholder', () => {
    expect(run(`${node('console.log(process.argv[1]); process.exit(1)')} {baseline}`, {}, { baseline: () => 'abc123' }).text).toBe('abc123');
  });

  it('keeps an output of several megabytes', () => {
    const result = run(node('process.stdout.write("x".repeat(3 * 1024 * 1024)); process.exitCode = 1'));
    expect(result.text).toHaveLength(3 * 1024 * 1024);
  });

  it('reads a run that could not be started as broken', () => {
    const result = runCheck(check('exit 0'), { root: join(root, 'no-such-folder'), baseline: unasked });
    expect(result.outcome).toBe('broken');
    expect(result.reason).toMatch(/^broke: could not be started \(/);
  });

  // An error of the referee's own setup is a broken harness. Returned as a
  // result, a check that only reports would print it and let verify go on.
  it('throws an error of its own setup, rather than reading it as broken', () => {
    expect(() => runCheck(check('exit 0 {baseline}'), { root, baseline: unasked })).toThrow('the baseline was asked for');
  });

  // Many tools given no file check the whole project.
  it('is skipped, and runs nothing, when it names the changed files and none changed', () => {
    const result = run(`${node('require("fs").writeFileSync("ran.txt", "")')} {changedFiles}`, {}, { baseline: () => 'abc', files: () => [] });
    expect(result).toEqual({ outcome: 'skipped', code: null, text: '', reason: 'skipped: no file changed since the baseline' });
    expect(spawnSync('ls', [root], { encoding: 'utf8' }).stdout).not.toContain('ran.txt');
  });
});

describe('the baseline and the changed files, in a repository', () => {
  let root;
  let cwd;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'checks-repo-')));
    git('init', '--quiet', '--initial-branch', 'feat/x');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(root);
    writeFileSync(join(root, 'kept.ts'), 'one\n');
    writeFileSync(join(root, 'gone.ts'), 'one\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    markTarget(root);
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  // With no plan approved, the logbook pins nothing, so the change is
  // measured from where it meets the target.
  it('is where HEAD meets the target when the logbook pins no baseline', () => {
    const target = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'kept.ts'), 'two\n');
    git('commit', '--quiet', '-am', 'on the branch');
    expect(baselineSha()).toBe(target);
  });

  // A pinned baseline is the one the plan was measured from, even when the
  // target has moved since.
  it('is the one the logbook pinned, when it pinned one', () => {
    expect(baselineSha({ pinned: () => 'pinned-sha' })).toBe('pinned-sha');
  });

  it('gives a check the changed files on disk unless told otherwise', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'kept.ts'), 'two\n');
    rmSync(join(root, 'gone.ts'));
    const result = runCheck(check(`${node('console.log(process.argv.slice(1).join("|")); process.exit(1)')} {changedFiles}`), { root, baseline: () => base });
    expect(result.text).toBe('kept.ts');
  });

  it('are the changed files still on disk, a deleted one left out', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'kept.ts'), 'two\n');
    writeFileSync(join(root, 'new.ts'), 'new\n');
    rmSync(join(root, 'gone.ts'));
    expect(filesOnDisk(base, root).sort()).toEqual(['kept.ts', 'new.ts']);
  });
});
