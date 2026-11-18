/**
 * `skipInCi`, through the real verify command, in a clean detached worktree:
 * the shape `CI=true npm run verify` has when a script stands in for the
 * pipeline. The fixture repository has a bare remote holding the target,
 * because under `CI=true` `req:guard` and `state:verify` fetch it first, and
 * one commit of code past the target, so mutation has lines to mutate.
 *
 * The mutation command counts its runs in a file outside the worktree. Each
 * case gives the child its own `CI`, built from this process's environment
 * with `CI` taken out first, so the runner's own setting never decides a case.
 *
 * Every case starts a process, so mutation testing leaves this file out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configureTarget, markTarget } from '../../fixtures/workflow/target.mjs';
import { mutationCommand } from '../../fixtures/workflow/mutation-report.mjs';
import { fixtureMutation, writeConfig } from '../../fixtures/workflow/adapter.mjs';

const VERIFY = resolve('src/workflow/cli/verify-change.ts');
const TSX = resolve('node_modules/tsx/dist/loader.mjs');
const SKIPPED = 'skipped in CI (skipInCi: true)';

const mark = (name) => `node -e "require('fs').appendFileSync('ran.txt', '${name}\\n')"`;
const entry = (command, more = {}) => ({ command, exitCodes: { 0: 'clean', 1: 'findings' }, ...more });

/** The fixture's test command: one passing test, in the JUnit report the
 *  referee reads. */
const TEST_COMMAND = `const fs = require('fs');
fs.mkdirSync('reports/junit', { recursive: true });
fs.writeFileSync('reports/junit/run.xml', '<testsuites><testcase name="works" file="a.test.ts"></testcase></testsuites>');
`;

/** The child's environment: this process's, with `CI` removed, then set to
 *  `ci` when given. */
const envWith = (ci) => {
  const env = { ...process.env };
  delete env.CI;
  if (ci !== undefined) env.CI = ci;
  return env;
};

describe('a check the rulebook skips in CI', () => {
  let dir;
  let root;
  let tree;
  let counter;
  let base;

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0);
  const ran = () => (existsSync(join(tree, 'ran.txt')) ? readFileSync(join(tree, 'ran.txt'), 'utf8').trim().split('\n') : []);

  /** Commits a rulebook with these checks on the branch, and checks the
   *  branch's last commit out into a detached worktree. */
  const setUp = ({ mutation = {}, codeQuality = { after: entry(mark('after')) } } = {}) => {
    const counting = mutationCommand('0 mutants.', 0, [], `fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n');`);
    writeConfig(root, {
      adapter: {
        run: { command: 'node test-command.cjs', reportPaths: ['reports/junit/*.xml'], tagComment: '^\\s*//' },
        compile: 'none',
      },
      fields: { checks: { testQuality: { coverage: 'none', mutation: fixtureMutation({ command: counting, ...mutation }) }, codeQuality } },
    });
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'rulebook');
    git(root, 'worktree', 'add', '--quiet', '--detach', tree, 'HEAD');
  };

  const verify = (ci) => {
    const results = join(dir, `results-${Math.random()}.json`);
    const run = spawnSync(process.execPath, ['--import', TSX, VERIFY, '--results', results], { cwd: tree, encoding: 'utf8', env: envWith(ci) });
    const unified = existsSync(results) ? JSON.parse(readFileSync(results, 'utf8')).results : [];
    const named = name => unified.find(result => result.name === name);
    return { ...run, output: `${run.stdout}${run.stderr}`, mutation: named('mutation'), named };
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'skip-in-ci-')));
    root = join(dir, 'repo');
    tree = join(dir, 'worktree');
    counter = join(dir, 'mutation-runs.txt');
    const remote = join(dir, 'server.git');
    mkdirSync(root);
    git(dir, 'init', '--quiet', '--bare', remote);
    git(root, 'init', '--quiet', '--initial-branch', 'feat/x');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    configureTarget(root);
    git(root, 'remote', 'set-url', 'origin', remote);
    writeFileSync(join(root, '.gitignore'), 'ran.txt\nreports/\n');
    writeFileSync(join(root, 'test-command.cjs'), TEST_COMMAND);
    writeFileSync(join(root, 'a.test.ts'), "it('works', () => {});\n");
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'base');
    base = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'push', '--quiet', 'origin', 'HEAD:main');
    markTarget(root, base);
    // Code past the target, so a mutation run has lines to ask about.
    writeFileSync(join(root, 'feature.ts'), 'export const on = true;\n');
    git(root, 'add', 'feature.ts');
    git(root, 'commit', '--quiet', '-m', 'feature');
  });

  afterEach(() => {
    if (root && existsSync(tree)) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  });

  it('still runs mutation once with CI unset, and with CI=false', () => {
    setUp({ mutation: { skipInCi: true } });
    for (const [ci, expected] of [[undefined, 1], ['false', 2]]) {
      const run = verify(ci);
      expect(run.status, run.output).toBe(0);
      expect(runs(), String(ci)).toBe(expected);
      expect(run.output).not.toContain(SKIPPED);
      expect(run.mutation.status, String(ci)).toBe('ok');
    }
  });

  it('runs mutation under CI=true when the rulebook does not say skipInCi, as before', () => {
    setUp();
    const run = verify('true');
    expect(run.status, run.output).toBe(0);
    expect(runs()).toBe(1);
    expect(run.output).not.toContain(SKIPPED);
  });

});
