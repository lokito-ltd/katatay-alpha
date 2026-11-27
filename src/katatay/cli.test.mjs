import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { runReferee } from '../workflow/runtime.mjs';
import { ROUTES } from '../workflow/cli/workflow.mjs';
import { agentActions } from '../agents/programs.mjs';
import { releaseVersion } from './release.mjs';

vi.mock('../workflow/runtime.mjs', () => ({ runReferee: vi.fn() }));
vi.mock('../distribution.mjs', () => ({ packaged: true }));
vi.mock('./release.mjs', () => ({ releaseVersion: vi.fn() }));
vi.mock('../schema-version.mjs', () => ({ HARNESS_SCHEMA_VERSION: 42 }));

const argv = process.argv;
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  runReferee.mockReset().mockReturnValue({ status: 0 });
  releaseVersion.mockReset().mockReturnValue('7.8.9');
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function invoke(...args) {
  process.argv = [process.execPath, 'ktty', ...args];
  await import('./cli.mjs');
  return process.exitCode;
}

it('labels the package release and rulebook schema independently', async () => {
  expect(await invoke('version')).toBe(0);
  expect(releaseVersion).toHaveBeenCalledWith(resolve(import.meta.dirname, '../..'), true);
  expect(console.log).toHaveBeenCalledWith('Katatay 7.8.9\nSchema 42');
  expect(runReferee).not.toHaveBeenCalled();
});

it('prints why the release is unknown on stderr and exits 1, printing no version', async () => {
  releaseVersion.mockImplementation(() => { throw new Error('Katatay cannot tell its release: no tag.'); });
  expect(await invoke('version')).toBe(1);
  expect(console.error).toHaveBeenCalledWith('Katatay cannot tell its release: no tag.');
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it.each([['agent', 'codex'], ['agent', 'other', 'check'],
  ['agent', 'codex', '../defaults'], ['agent', 'codex', 'post-tool']])('refuses invalid arguments %s %s %s before launching a child', async (...args) => {
  expect(await invoke(...args)).toBe(2);
  expect(console.error).toHaveBeenCalledWith("Usage: ktty agent <adapter> <action>.\nRun 'ktty help' for usage.");
  expect(console.log).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});

it.each([['codex', 'check'], ['claude', 'defaults']])('rejects trailing arguments to %s %s before running the adapter', async (adapter, action) => {
  expect(await invoke('agent', adapter, action, 'extra')).toBe(2);
  expect(runReferee).not.toHaveBeenCalled();
});

it.each([
  [[], 'No command supplied.'],
  [['missing', 'extra'], "Unknown command 'missing'."],
  [['req', 'bogus', 'extra'], "Unknown command 'req bogus'."],
  [['state'], "Unknown command 'state'."],
  [['state', 'missing'], "Unknown command 'state missing'."],
  [['state show'], "Unknown command 'state show'."],
  [['on', 'bad\r\nname'], "Unknown command 'on bad\\r\\nname'."],
])('explains the invalid invocation %j before launching a child', async (args, message) => {
  expect(await invoke(...args)).toBe(2);
  expect(console.error).toHaveBeenCalledWith(`${message}\nRun 'ktty help' for usage.`);
  expect(console.log).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});

it('lists every registered command once with a description, without launching a child', async () => {
  expect(await invoke('help')).toBe(0);
  const lines = console.log.mock.calls[0][0].split('\n');
  expect(lines.slice(0, 3)).toEqual(['Usage: ktty <command> [arguments]', '', 'Commands:']);
  const expected = new Set(['help', 'path', 'version', ...Object.keys(ROUTES)]);
  for (const pair of agentActions()) expected.add('agent ' + pair);
  const names = lines.slice(3).map(line => {
    const [name, description] = line.trim().split(/\s{2,}/);
    expect(description, name).toMatch(/\w+\s+\w+/);
    return name;
  });
  expect(names.sort()).toEqual([...expected].sort());
  expect(lines.find(line => line.trimStart().startsWith('version '))).toMatch(/release.*schema/i);
  expect(console.error).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});

it('runs the selected adapter action with the caller’s streams and its exit status', async () => {
  runReferee.mockReturnValue({ status: 13 });
  expect(await invoke('agent', 'claude', 'post-tool')).toBe(13);
  expect(runReferee).toHaveBeenCalledWith(expect.stringMatching(/\/src\/agents\/claude\/hooks\/post-tool\.mjs$/), [], { stdio: 'inherit' });
});

it('initializes from the calling directory with every adapter and the supplied probe arguments', async () => {
  vi.stubEnv('INIT_CWD', '/different-directory');
  expect(await invoke('init', '--project', 'relative', '--probe', '--scratch-module', 'src/scratch.ts',
    '--agent', 'demo-=echo ok')).toBe(0);
  expect(process.env.INIT_CWD).toBeUndefined();
  expect(runReferee).toHaveBeenCalledWith(expect.stringMatching(/\/cli\/init\.mjs$/), [
    '--agent', 'claude=ktty agent claude defaults', '--agent', 'codex=ktty agent codex defaults', '--agent', 'cursor=ktty agent cursor defaults',
    '--project', 'relative', '--probe', '--scratch-module', 'src/scratch.ts', '--agent', 'demo-=echo ok',
  ], { stdio: 'inherit' });
});

it('reports a launch failure instead of treating the absence of an exit status as success', async () => {
  runReferee.mockReturnValue({ status: null, error: new Error('cannot start referee') });
  expect(await invoke('verify', '--rerun')).toBe(1);
  expect(console.error).toHaveBeenCalledWith('cannot start referee');
  expect(runReferee).toHaveBeenCalledWith(expect.stringMatching(/\/cli\/verify-rerun\.mjs$/), [], { stdio: 'inherit' });
});

// Each row states the correction an operator should see for that command.
// Spread the operands as argv so spaces inside one value stay in that value.
for (const [command, correction, invalidOperands] of [
  ['replan', 'Usage: ktty replan [--resume].', [['--other'], ['--resume', 'extra']]],
  ['req renumber', 'Usage: ktty req renumber <fromId> <toId>.',
    [['AC0001'], ['bad', 'INV0001'], ['xAC0001', 'AC0002'], ['AC0001', 'INV0002x'], ['AC0001', 'INV0002', 'extra']]],
  ['checks-analysis', 'Usage: ktty checks-analysis <verification-seq>.', [[], ['01'], ['12x'], ['1', 'extra']]],
  ['req lint', 'Usage: ktty req lint [<directory>].', [['   '], ['docs', 'extra']]],
  ['defaults', 'Usage: ktty defaults <adapter command> [arguments].', [[]]],
  ['mutate', 'Usage: ktty mutate [--base <ref>] [--budget <seconds>] [--verbose] [--json].',
    [['--base'], ['--budget', 'abc'], ['--budget']]],
  ['verify', 'Usage: ktty verify [--results <file>] [--deadline <milliseconds>].',
    [['--unknown', 'output.json'], ['--deadline', ' '], ['--deadline', 'tomorrow'], ['--results'], ['--results', '--deadline']]],
  ['areas', 'Usage: ktty areas [--staged].', [['--wrong']]],
  ['report', 'Usage: ktty report [--json].', [['--json', 'extra']]],
  ['verify --rerun', "The 'verify --rerun' command takes no arguments. Run 'ktty verify --rerun'.", [['extra']]],
  ['on prompt', "The 'on prompt' command takes no arguments. Run 'ktty on prompt'.", [['extra']]],
  ['init', 'Usage: ktty init [--agent <label>=<defaults command>] [--project <dir>] [--answers <file>] [--questions] [--scratch-module <file>] [--probe [--expect <state>]].',
    [['--expect', 'survivors'], ['--project', '--probe'], ['--project', '   '], ['--agent', '  =a'], ['--agent', '-demo=echo ok']]],
  ['req guard', 'Usage: ktty req guard [--record].', [['extra']]],
]) {
  for (const operands of invalidOperands) {
    it(`rejects ktty ${command} with operands ${JSON.stringify(operands)} before launch`, async () => {
      expect(await invoke(...command.split(' '), ...operands)).toBe(2);
      expect(runReferee).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error.mock.calls).toEqual([[`${correction}\nRun 'ktty help' for usage.`]]);
    });
  }
}

it.each([
  ['mutate', '--base', 'main', '--budget', '30', '--json', '--verbose'],
  ['replan'], ['replan', '--resume'],
  ['verify', '--deadline', '100', '--results', 'results.json'],
  ['req', 'lint', 'my catalogue'], ['req', 'guard', '--record'], ['req', 'renumber', 'AC0001', 'AC0002'],
  ['defaults', 'some-adapter', '--its-flag'], ['areas', '--staged'], ['report', '--json'],
  ['checks-analysis', '1'], ['checks-analysis', '14'], ['req', 'lint'], ['state', 'show'], ['on', 'turn-end'],
])('passes valid argv %j and the caller’s streams to its handler', async (...args) => {
  runReferee.mockReturnValue({ status: 2 });
  expect(await invoke(...args)).toBe(2);
  const prefix = ['req', 'state', 'on'].includes(args[0]) ? 2 : 1;
  expect(runReferee).toHaveBeenCalledWith(ROUTES[args.slice(0, prefix).join(' ')], args.slice(prefix), { stdio: 'inherit' });
  expect(console.error).not.toHaveBeenCalled();
});

it('prints the absolute root of the package it runs from, for projects to find the adapter in', async () => {
  expect(await invoke('path')).toBe(0);
  expect(releaseVersion).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(resolve(import.meta.dirname, '../..'));
  expect(console.log.mock.calls[0][0]).toMatch(/^\/.*[^/]$/);
  expect(runReferee).not.toHaveBeenCalled();
});

it.each(['version', 'path', 'help'])('refuses arguments after %s', async verb => {
  expect(await invoke(verb, 'extra')).toBe(2);
  expect(console.error).toHaveBeenCalledWith(
    `The '${verb}' command takes no arguments. Run 'ktty ${verb}'.\nRun 'ktty help' for usage.`,
  );
  expect(console.log).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});
