import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { append } from '../chain.mjs';
import { current } from '../state.mjs';

vi.mock('../chain.mjs', () => ({ append: vi.fn() }));
vi.mock('../state.mjs', () => ({ current: vi.fn() }));

const argv = process.argv;
const exitCode = process.exitCode;
const approval = { seq: 1, event: 'plan_approved' };
const branch = { phase: 'implementing', branch: 'topic', dir: 'log', grant: approval, live: [approval], entries: [approval] };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

async function invoke(...args) {
  process.argv = [process.execPath, fileURLToPath(new URL('./replan.mjs', import.meta.url)), ...args];
  await import('./replan.mjs');
}

it('prints how to resolve the pending revision and records the current approval', async () => {
  current.mockReturnValue(branch);
  await invoke();
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/revision is pending.*Present the revision for approval.*original plan.*workflow replan --resume/));
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  expect(append).toHaveBeenCalledExactlyOnceWith('log', 'replan_requested', { approval: 1 }, 'topic', 1);
});

it('passes --resume to the referee and tells the agent where to continue', async () => {
  const request = { seq: 2, event: 'replan_requested', payload: { approval: 1 } };
  const events = [approval, request];
  current.mockReturnValue({ ...branch, live: events, entries: events, replan: request });
  await invoke('--resume');
  expect(console.log).toHaveBeenCalledWith('The operator chose the original plan. Continue in implementing.');
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  expect(append).toHaveBeenCalledExactlyOnceWith('log', 'replan_resumed', { request: 2 }, 'topic', 2);
});

it('exits 2 and tells the operator why an edited recorded change must merge or reset', async () => {
  const events = [approval, { event: 'recorded' }];
  current.mockReturnValue({ ...branch, phase: 'converging', live: events, entries: events });
  await invoke();
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^For the operator: This branch already holds a recorded change\. Merge it first.*operator type `reset`/));
  expect(console.log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(2);
  expect(append).not.toHaveBeenCalled();
});
