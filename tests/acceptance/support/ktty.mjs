import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, onTestFinished } from 'vitest';

export function givenAnEmptyFolder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-acceptance-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'case');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const folder of [cwd, home, bin]) mkdirSync(folder);

  const command = process.env.KTTY_BIN
    ? [resolve(process.env.KTTY_BIN)]
    : [process.execPath, resolve(import.meta.dirname, '../../../src/katatay/cli.mjs')];
  const quoted = command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
  writeFileSync(join(bin, 'ktty'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });

  const env = { ...process.env, HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'INIT_CWD', 'CI']) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Acceptance', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Acceptance', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  return { cwd, env };
}

export function givenAGitRepository() {
  const folder = givenAnEmptyFolder();
  execFileSync('git', ['init', '--quiet', '-b', 'main'], folder);
  return folder;
}

// `env` adds to the folder's environment, such as CI=true for one run.
export function whenKttyRuns(args, { in: folder, input, env = {} }) {
  const { status, stdout, stderr, error } = spawnSync('ktty', args, { ...folder, env: { ...folder.env, ...env }, input, encoding: 'utf8' });
  if (error) throw error;
  return { status, stdout, stderr };
}

export function thenItExits(run, code) {
  expect(run.status, run.stdout + run.stderr).toBe(code);
}

export function thenItPrintsLines(run, lines) {
  expect(run.stderr).toBe('');
  const actual = run.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  expect(actual).toEqual(lines.map(line => line instanceof RegExp ? expect.stringMatching(line) : line));
}

export function thenItPrintsError(run, lines) {
  expect(run.stdout).toBe('');
  expect(run.stderr).toBe(lines.join('\n') + '\n');
}

export function thenHookReplies(run, exitCode) {
  thenItExits(run, exitCode);
  return JSON.parse(run.stdout);
}

// Like thenItPrintsError, with a RegExp allowed for a line that carries a
// value the test cannot know, such as a fingerprint.
export function thenItPrintsErrorLines(run, lines) {
  expect(run.stdout).toBe('');
  const actual = run.stderr.replace(/\r?\n$/, '').split(/\r?\n/);
  expect(actual).toEqual(lines.map(line => line instanceof RegExp ? expect.stringMatching(line) : line));
}

// For a command that prints on both streams, such as a guard in CI that lists
// changes for the reviewer and fails on others.
export function thenItPrintsOnBoth(run, stdout, stderr) {
  const lines = text => text.replace(/\r?\n$/, '').split(/\r?\n/);
  const expected = list => list.map(line => line instanceof RegExp ? expect.stringMatching(line) : line);
  expect(lines(run.stdout)).toEqual(expected(stdout));
  expect(lines(run.stderr)).toEqual(expected(stderr));
}
