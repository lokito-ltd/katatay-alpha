import { expect, it } from 'vitest';
import { mutationIncomplete } from './mutation.mjs';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

it.each(['Pending', 'NoCoverage', 'RuntimeError', 'CompileError'])('marks %s as incomplete mutation evidence', status => {
  expect(mutationIncomplete('clean', findingsOf(reportOf([mutant(status)])))).toBe(true);
});

it.each(['Killed', 'Timeout', 'Ignored', 'Survived'])('does not mark a completed %s measurement as partial', status => {
  expect(mutationIncomplete(status === 'Survived' ? 'survived' : 'clean', findingsOf(reportOf([mutant(status)])))).toBe(false);
});

it('marks explicit partial reports, inconclusive outcomes and unproven survivors as partial', () => {
  expect(mutationIncomplete('clean', findingsOf({ ...reportOf(), partial: true }))).toBe(true);
  expect(mutationIncomplete('nothing', findingsOf(reportOf()))).toBe(true);
  expect(mutationIncomplete('nothing', findingsOf(reportOf([mutant('Survived', { testsCompleted: 0 })])))).toBe(true);
  expect(mutationIncomplete('survived', findingsOf(reportOf([
    mutant('Survived'), mutant('Survived', { id: 'unproven', testsCompleted: 0 }),
  ])))).toBe(true);
  expect(mutationIncomplete('clean', findingsOf(reportOf()))).toBe(false);
});
