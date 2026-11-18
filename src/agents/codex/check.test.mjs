// Run the adapter entry point in-process so fast coverage and mutation see the
// decision it makes from Git and Codex answers. The slow suite uses real worktrees.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askAppServer } from './app-server.mjs';
import { EXPECTED, commandFor } from './registration.mjs';
import { gitText } from '../../workflow/git.mjs';

vi.mock('./app-server.mjs', () => ({ askAppServer: vi.fn() }));
vi.mock('../../workflow/git.mjs', () => ({ gitText: vi.fn() }));

let main, root, mainFile, worktreeFile;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('CI', 'false');
  main = mkdtempSync(join(tmpdir(), 'main checkout '));
  root = join(main, 'linked checkout');
  mainFile = join(main, '.codex/hooks.json');
  worktreeFile = join(root, '.codex/hooks.json');
  for (const path of [main, root]) {
    mkdirSync(join(path, '.codex'), { recursive: true });
    writeFileSync(join(path, '.codex/hooks.json'), '{}');
  }
  writeFileSync(join(root, 'AGENTS.md'), 'Instructions');
  gitText.mockImplementation(([command]) => command === 'worktree'
    ? `worktree ${main}\0HEAD head\0branch refs/heads/main\0\0worktree ${root}\0HEAD head\0detached\0\0`
    : 'AGENTS.md\0');
  const hooks = EXPECTED.map(({ event, script, matcher }) => ({
    eventName: event, command: commandFor(script), matcher: matcher.join('|'), source: 'project',
    sourcePath: mainFile, enabled: true, trustStatus: 'trusted',
  }));
  askAppServer.mockResolvedValue({ answers: [{ data: [{ cwd: root, hooks }] }, { config: {} }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(main, { recursive: true, force: true });
});

async function check() {
  const input = JSON.stringify({ version: 1, root, extraHooks: { acknowledged: [] } });
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield input; });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await import('./check.mjs');
    expect(output).toHaveBeenCalledTimes(1);
    const answer = JSON.parse(output.mock.calls[0][0]);
    expect(answer.version).toBe(1);
    return answer.warnings;
  } finally {
    output.mockRestore();
  }
}

it('queries Codex from the linked checkout and compares its file to the reported main file', async () => {
  writeFileSync(worktreeFile, '{"hooks":{}}');
  expect(await check()).toEqual([
    `Codex loaded project hooks from ${mainFile}, the main checkout’s registration. The worktree registration at ${worktreeFile} differs.`,
  ]);
  expect(askAppServer).toHaveBeenCalledWith([
    { method: 'hooks/list', params: { cwds: [root] } },
    { method: 'config/read', params: { cwd: root } },
  ], { cwd: root });
  expect(gitText).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], { cwd: root });
});

it.each(['unlisted checkout', 'Git unavailable'])('keeps foreign hooks extra with %s', async mode => {
  gitText.mockImplementation(([command]) => {
    if (command !== 'worktree') return 'AGENTS.md\0';
    if (mode === 'Git unavailable') throw Error('not a repository');
    return `worktree ${main}\0HEAD head\0\0`;
  });
  const warnings = await check();
  for (const { event } of EXPECTED) {
    expect(warnings).toContainEqual(expect.stringContaining(`does not register the workflow's ${event} hook`));
    expect(warnings).toContainEqual(expect.stringContaining(`${mainFile} (project) registers an extra ${event} hook`));
  }
  expect(warnings).toHaveLength(6);
});

it('still reports missing instructions in CI without querying Codex or Git', async () => {
  vi.stubEnv('CI', 'true');
  rmSync(join(root, 'AGENTS.md'));
  expect(await check()).toEqual(['Codex live setup check skipped in CI.', 'AGENTS.md is missing.']);
  expect(askAppServer).not.toHaveBeenCalled();
  expect(gitText).not.toHaveBeenCalled();
});

it('distinguishes an unavailable app server from a listing with no registered hooks', async () => {
  askAppServer.mockResolvedValue({ problem: 'app server unavailable' });
  expect(await check()).toEqual([
    expect.stringMatching(/settings could not be read.*app server unavailable/),
    expect.stringMatching(/could not be asked about its hooks.*app server unavailable/),
  ]);
});
