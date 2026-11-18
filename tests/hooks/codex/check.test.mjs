/**
 * The check command as the referee starts it, with a stand-in `codex` first on
 * `PATH`. `setup.test.mjs` covers every warning; this proves the command asks
 * Codex, hands the answers on, and refuses a request that does not match.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const CHECK = resolve('src/agents/codex/check.mjs');
let dir;
let bin;
let repo;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-check-')));
  bin = join(dir, 'bin');
  repo = join(dir, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(repo, 'AGENTS.md'), '# The workflow\n');
  // Lists no hooks at all for the repository, and default settings.
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.env.CODEX_PROBE_MARKER) writeFileSync(process.env.CODEX_PROBE_MARKER, 'started');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'hooks/list') send({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], hooks: JSON.parse(process.env.CODEX_PROBE_HOOKS ?? '[]'), warnings: [], errors: [] }] } });
  else if (m.method === 'config/read') send({ id: m.id, result: { config: { features: {} }, origins: {}, layers: null } });
  else if (m.id !== undefined) send({ id: m.id, result: {} });
});
`);
  chmodSync(join(bin, 'codex'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (input, path = `${bin}${delimiter}${process.env.PATH}`, env = {}) => spawnSync(process.execPath, [CHECK], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: repo, env: { ...process.env, CI: undefined, PATH: path, ...env },
});

describe('the Codex check command', () => {
  it('asks Codex and answers with what is wrong', () => {
    const answered = run({ version: 1, root: repo, extraHooks: { acknowledged: [] } });
    expect(answered.status).toBe(0);
    const { version, warnings } = JSON.parse(answered.stdout);
    expect(version).toBe(1);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.startsWith('.codex/hooks.json does not register'))).toBe(true);
  });

  it('warns when the repository\'s AGENTS.md files are over what Codex reads', () => {
    const git = join(dir, 'git-repo');
    mkdirSync(join(git, 'app'), { recursive: true });
    spawnSync('git', ['init', '--quiet'], { cwd: git });
    writeFileSync(join(git, 'AGENTS.md'), 'x'.repeat(32000));
    writeFileSync(join(git, 'app/AGENTS.md'), 'y'.repeat(1000));
    writeFileSync(join(git, '.gitignore'), 'ignored/\n');
    mkdirSync(join(git, 'ignored'));
    writeFileSync(join(git, 'ignored/AGENTS.md'), 'z'.repeat(40000));
    const answered = run({ version: 1, root: git, extraHooks: null });
    expect(answered.status).toBe(0);
    expect(JSON.parse(answered.stdout).warnings).toEqual([
      expect.stringMatching(/^The AGENTS\.md files Codex loads together in `app\/` \(`AGENTS\.md`, `app\/AGENTS\.md`\) come to 33000 bytes/),
      ...Array(3).fill(expect.stringMatching(/^\.codex\/hooks\.json does not register/)),
    ]);
  });

  it('recognizes the loaded main checkout hooks in a linked worktree and reports configuration drift once', () => {
    const main = mkdtempSync(join(dir, 'main-'));
    const worktree = join(dir, 'linked checkout');
    const git = (...args) => execFileSync('git', args, { cwd: main });
    git('init', '--quiet');
    const hooksFile = '.codex/hooks.json';
    const config = JSON.parse(readFileSync(resolve(hooksFile), 'utf8'));
    const mainFile = join(main, hooksFile);
    const worktreeFile = join(worktree, hooksFile);
    mkdirSync(join(main, '.codex'));
    writeFileSync(mainFile, JSON.stringify(config));
    writeFileSync(join(main, 'AGENTS.md'), 'Instructions');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'base');
    git('worktree', 'add', '--quiet', '--detach', worktree);
    const hooks = Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(({ command }) => ({
      source: 'project', sourcePath: mainFile, enabled: true, trustStatus: 'trusted',
      eventName: event[0].toLowerCase() + event.slice(1), command, matcher: group.matcher ?? null,
    }))));
    function check(hooksToList = hooks) {
      const result = run({ version: 1, root: worktree, extraHooks: { acknowledged: [] } }, undefined,
        { CI: 'false', CODEX_PROBE_HOOKS: JSON.stringify(hooksToList) });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).warnings;
    }
    writeFileSync(worktreeFile, JSON.stringify(config, null, 4));
    expect(check()).toEqual([]);
    expect(check(hooks.map(h => ({ ...h, enabled: false })))).toEqual(Object.keys(config.hooks).map(event =>
      expect.stringContaining(`the workflow's ${event} hook`)
    ));
    expect(check([{ ...hooks[0], enabled: false }, ...hooks.slice(1)])).toEqual([expect.stringContaining('is disabled')]);
    expect(check([{ ...hooks[0], trustStatus: 'untrusted' }, ...hooks.slice(1)])).toEqual([expect.stringContaining('has not been trusted')]);
    const foreign = { ...hooks[0], sourcePath: join(repo, hooksFile) };
    expect(check([foreign, ...hooks.slice(1)])).toEqual([expect.stringContaining('does not register'), expect.stringContaining('extra PreToolUse')]);
    const sibling = join(dir, 'sibling checkout');
    git('worktree', 'add', '--quiet', '--detach', sibling);
    expect(readFileSync(join(sibling, hooksFile), 'utf8')).toBe(readFileSync(mainFile, 'utf8'));
    const siblingHook = { ...hooks[0], sourcePath: join(sibling, hooksFile) };
    expect(check([siblingHook, ...hooks.slice(1)])).toEqual([
      expect.stringContaining('does not register'), expect.stringContaining(siblingHook.sourcePath),
    ]);
    writeFileSync(worktreeFile, '{}');
    expect(check()).toEqual([expect.stringContaining(`${mainFile}, the main checkout’s registration. The worktree registration at ${worktreeFile} differs`)]);
    for (const unreadable of ['invalid JSON', null]) {
      if (unreadable === null) rmSync(worktreeFile);
      else writeFileSync(worktreeFile, unreadable);
      const [warning, ...others] = check();
      expect(warning).toContain(mainFile);
      expect(warning).toContain(`Could not compare it with ${worktreeFile}`);
      expect(others).toEqual([]);
    }
  });

  it('skips the live query only with CI=true and still validates the request', () => {
    const marker = join(dir, 'live-query-started');
    const input = { version: 1, root: repo, extraHooks: null };
    const env = { CI: 'true', CODEX_PROBE_MARKER: marker };
    expect(run({ ...input, version: 2 }, undefined, env).status).toBe(2);
    const skipped = run(input, undefined, env);
    expect(JSON.parse(skipped.stdout).warnings).toEqual(['Codex live setup check skipped in CI.']);
    expect(existsSync(marker)).toBe(false);
    const live = run(input, undefined, { ...env, CI: 'false' });
    expect(JSON.parse(live.stdout).warnings).toHaveLength(3);
    expect(readFileSync(marker, 'utf8')).toBe('started');
  });

  it.each([
    ['is not JSON', 'nope', 'the request is not JSON'],
    ['is not an object', '[1]', 'the request is not a JSON object'],
    ['has no version', { root: '/r', extraHooks: null }, '`version` must be 1, and is missing'],
    ['has a null version', { version: null, root: '/r', extraHooks: null }, '`version` must be 1, and is null'],
    ['has a string version', { version: '1', root: '/r', extraHooks: null }, '`version` must be 1, and is "1"'],
    ['has another version', { version: 2, root: '/r', extraHooks: null }, '`version` must be 1, and is 2'],
    ['has no root', { version: 1, root: '', extraHooks: null }, '`root` must be the repository root'],
    ['has extra hooks of the wrong shape', { version: 1, root: '/r', extraHooks: { acknowledged: [{ event: 1 }] } }, '`extraHooks` must be null or'],
  ])('refuses a request that %s, with exit 2 and a sentence', (_case, input, why) => {
    const answered = run(input);
    expect(answered.status).toBe(2);
    expect(answered.stdout).toBe('');
    expect(answered.stderr).toContain(`check: refused, ${why}`);
  });
});
