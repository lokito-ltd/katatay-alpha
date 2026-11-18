import { mutant, mutationCommand } from '../../fixtures/workflow/mutation-report.mjs';
/**
 * A change with gaps at `record`, shared by the files that read the change
 * report: the hooks' `reporting-at-record.test.mjs` and the in-process
 * `reporting-gathered.test.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ctx, approvedChange, phase, setCoverage, setMutate, stop, triage } from './harness.mjs';

/** A stub mutation command that finds one survivor: text, and exit 1. */
export const survivor = () => {
  const text = `1 mutant: 0 caught, 1 survived.\nSurvived:\n- modules/feature.mjs:1 ${'BooleanLiteral'} → false`;
  return mutationCommand(text, 1, [mutant('Survived', { file: 'modules/feature.mjs', source: 'export const on = true;\n', mutatorName: 'BooleanLiteral', replacement: 'false' })]);
};

/** New code under `modules/`, triaged, then verified with a line no test runs
 *  and a surviving mutant: a change with gaps, at its first verified pass. */
export const verifiedWithGaps = () => {
  approvedChange();
  mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
  writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\nexport const off = () => false;\n');
  triage();
  setCoverage({ 'modules/feature.mjs': { total: 2, uncovered: [2] } });
  setMutate(survivor());
  stop();
  expect(phase()).toBe('verified');
};
