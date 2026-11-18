import { afterEach, expect, it, vi } from 'vitest';
import { runTrace } from './trace.ts';
import { compileErrors } from './typecheck.ts';
import { loadCatalogue } from '../requirements/parse.ts';
import { readTestRun } from './test-run.ts';
import { runCompile } from '../workflow/adapter.mjs';

vi.mock('../requirements/parse.ts', { spy: true });
vi.mock('./test-run.ts', { spy: true });
vi.mock('../workflow/adapter.mjs', { spy: true });
afterEach(() => vi.restoreAllMocks());

it('reports missing acceptance evidence even without an inverted-test report', () => {
  readTestRun.mockReturnValue({ cases: [], leftOut: [] });
  loadCatalogue.mockReturnValue([{ id: 'INV0001', status: 'active', scenarios: [] }]);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(runTrace()).toBe(false);
  expect(log.mock.calls.flat().join('\n')).not.toMatch(/not checked/i);
  expect(error.mock.calls.flat().join('\n')).toContain('INV0001: is active but no acceptance test');
});

it('accepts a report with no missing evidence', () => {
  readTestRun.mockReturnValue({ cases: [], leftOut: [] });
  loadCatalogue.mockReturnValue([]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(runTrace()).toBe(true);
  expect(log.mock.calls.flat()).toEqual(['req:trace — every active requirement has evidence']);
});

it('keeps a disabled compiler distinct from a clean or failing compilation', () => {
  const errors = [{ file: 'a.ts', line: 3, message: 'wrong type' }];
  runCompile.mockReturnValueOnce(null).mockReturnValueOnce({ errors: [] }).mockReturnValueOnce({ errors });
  expect(compileErrors()).toBeNull();
  expect(compileErrors()).toEqual([]);
  expect(compileErrors()).toEqual(errors);
});
