import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Start from a readable state so these cases exercise the CLI's later read
// of adapter settings. The machine suite covers state discovery through Git.
vi.mock('../state.mjs', () => ({
  current: () => ({
    branch: 'feature', phase: 'open', why: 'no approval', dir: 'log', entries: [],
    saved: { committed: false }, merged: 0, changeFiles: [], next: ['write a plan'],
  }),
  savedWarnings: () => [],
}));
vi.mock('../agent.mjs', () => ({ agentWarnings: () => [] }));

let output;
let diagnostic;
let exit;
let readAdapters;
const exited = new Error('CLI exited');
const show = () => import('./show.mjs');

beforeEach(async () => {
  vi.resetModules();
  readAdapters = vi.spyOn(await import('../rulebook.mjs'), 'readAgentAdapters');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
});

afterEach(() => vi.restoreAllMocks());

it('names only the adapter whose extra-hook check is disabled', async () => {
  const enabled = { checkCommand: 'check', extraHooks: { check: true } };
  readAdapters.mockReturnValue({
    enabled, disabled: { ...enabled, extraHooks: { check: false } }, defaulted: { checkCommand: 'check' },
  });
  await expect(show()).rejects.toBe(exited);
  expect(exit.mock.calls).toEqual([[0]]);
  expect(diagnostic).not.toHaveBeenCalled();
  const notices = output.mock.calls.flat().filter(line => line.startsWith('NOTE'));
  expect(notices).toEqual([
    "NOTE       disabled: the rulebook turns the extra-hooks check off (agent.adapters.disabled.extraHooks.check), so hooks that are not the workflow's own are not listed",
  ]);
});

it('prints a late rulebook refusal and exits before giving the next step', async () => {
  const { TargetError } = await import('../target.mjs');
  const field = '"agent.adapters.second.extraHooks.check" must be true or false';
  readAdapters.mockImplementation(() => { throw new TargetError(field); });
  await expect(show()).rejects.toBe(exited);
  expect(diagnostic.mock.calls).toEqual([[`state: refused — ${field}`]]);
  expect(exit.mock.calls).toEqual([[1]]);
  expect(output).not.toHaveBeenCalledWith('next       write a plan');
});

it('propagates an unexpected adapter-read error to the caller', async () => {
  const failure = new Error('read failed');
  readAdapters.mockImplementation(() => { throw failure; });
  await expect(show()).rejects.toBe(failure);
  expect(diagnostic).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});
