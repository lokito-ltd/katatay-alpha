import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotGrant } from '../../tests/fixtures/workflow/events.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { current } from '../workflow/state.mjs';
import { runTestCommand } from './test-run.ts';
import { compileErrors } from './typecheck.ts';

vi.mock('../workflow/state.mjs', () => ({ current: vi.fn() }));
vi.mock('./test-run.ts', { spy: true });
vi.mock('./typecheck.ts', { spy: true });

let previousArgv;
const cwd = process.cwd();
let repo;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'snapshot-command-'));
  process.chdir(repo);
  previousArgv = process.argv;
  process.argv = [process.execPath, fileURLToPath(new URL('./risk.ts', import.meta.url))];
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error('exit ' + code); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  compileErrors.mockReturnValue(null);
  runTestCommand.mockReturnValue({ cases: [{ file: 'a.test.ts', name: 'one', status: 'failed', ids: [], scenarios: [] }],
    leftOut: [], exit: 1 });
});
afterEach(() => { process.chdir(cwd); rmSync(repo, { recursive: true, force: true }); });
afterEach(() => { process.argv = previousArgv; vi.restoreAllMocks(); });

it('refuses a broken logbook before running tests', async () => {
  current.mockReturnValue({ broken: 'wrong event hash' });
  await expect(import('./risk.ts')).rejects.toThrow('exit 1');
  expect(console.error).toHaveBeenCalledWith('req:risk: refused — the workflow state chain is broken: wrong event hash');
  expect(runTestCommand).not.toHaveBeenCalled();
});

it.each([true, false])('classifies a failed test with a live grant present equal to %s', async hasGrant => {
  current.mockReturnValue({ branch: 'topic', grant: hasGrant ? snapshotGrant('topic', '# Plan\n\n```workflow\npredicted-failures: [a.test.ts]\n```', repo) : null });
  if (hasGrant) await import('./risk.ts');
  else await expect(import('./risk.ts')).rejects.toThrow('exit 1');
  expect(runTestCommand).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(hasGrant ? 'predicted 1/1 failed · 0 surprises' : 'predicted 0/0 failed · 1 surprise'));
});

it('refuses invalid snapshot evidence before running tests', async () => {
  current.mockReturnValue({ branch: 'topic', grant: { seq: 4, payload: { planSnapshot: 'wrong' } } });
  await expect(import('./risk.ts')).rejects.toThrow('exit 1');
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('req:risk: refused — approval 4 wrong: invalid approved plan reference'));
  expect(runTestCommand).not.toHaveBeenCalled();
});

it('propagates an unexpected runner error', async () => {
  current.mockReturnValue({ grant: null });
  const failure = new Error('runner bug');
  runTestCommand.mockImplementationOnce(() => { throw failure; });
  await expect(import('./risk.ts')).rejects.toBe(failure);
  expect(console.error).not.toHaveBeenCalled();
});
