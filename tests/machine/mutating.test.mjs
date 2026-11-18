import { mutant, mutationCommand } from '../fixtures/workflow/mutation-report.mjs';
/** Mutation testing, as the `Stop` hook runs it once verify has passed. See
 *  `mutation.mjs` and `harness.mjs` for why these cases spawn real processes.
 *  The hook runs the referee's command for real, and the fixture's adapter
 *  `mutate` piece is a stub: what the TypeScript adapter finds is tested in
 *  `src/adapters/typescript/`, and what the referee makes of an answer in
 *  `src/evidence/mutants.test.ts`. Here it is what the hook does with it. */
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutationReferences } from '../../src/workflow/result-readers.mjs';
import { ctx, machineFixture, approvedChange, events, phase, setMutate, stop, triage } from '../support/machine/harness.mjs';

machineFixture({ approved: true });

/** A stub mutation command that finds one survivor, with `mutator` as its
 *  name, so a case can tell which stub answered: text, and exit 1. */
const survivor = (mutator) => {
  const text = `1 mutant: 0 caught, 1 survived.\nSurvived:\n- feature.mjs:1 ${mutator} → false`;
  return mutationCommand(text, 1, [mutant('Survived', { file: 'feature.mjs', source: 'export const on = true;\n', mutatorName: mutator, replacement: 'false' })]);
};

/** The approved change with a code file in it, so the referee has lines to ask
 *  the adapter about. `source.txt` alone is not code. */
const codeChange = (timeout) => {
  approvedChange();
  writeFileSync(join(ctx.repo, 'feature.mjs'), 'export const on = true;\n');
  if (timeout) hookTimeout(timeout);
  triage();
};

/** A receipt's mutation result, and the snapshots it names. */
const mutationOf = (verified = receipt()) => verified.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'mutation');
const snapshotsOf = (verified = receipt()) => mutationReferences(mutationOf(verified));
const measurement = (verified = receipt()) => JSON.parse(readFileSync(join(ctx.repo, snapshotsOf(verified).findings), 'utf8'));
/** A later pass repeats the producer's measurement, evidence and all. */
const reusedFrom = first => ({ status: 'reused', evidence: mutationOf(first).evidence, summary: mutationOf(first).summary });

const receipt = () => JSON.parse(readFileSync(join(ctx.logbook, events().findLast(e => e.endsWith('__verified.json'))), 'utf8')).payload;

/** Shortens the hook's own timeout, which the run's budget comes from. */
const hookTimeout = (seconds) => {
  const path = join(ctx.repo, '.claude/settings.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"timeout": 900', `"timeout": ${seconds}`));
};

describe('mutation testing after verify passes', () => {
  // Silence would read as "nothing survived".
  it('says the run failed when it printed nothing, and refuses verification', () => {
    codeChange();
    setMutate('node -e "console.error(\'Stryker exploded\');process.exit(1)"');
    const decision = stop();
    expect(decision.reason).toContain('Mutation testing failed before it could say anything');
    expect(decision.reason).toContain('Stryker exploded');
    expect(events()).toContain('0003__verify_failed.json');
    expect(phase()).toBe('converging');
  });

  // Switched off, the command answers at once, so no time is asked of it, and
  // the message says it was not checked rather than that there was no time.
  it('says it was not checked when switched off, however little time is left', () => {
    codeChange(60);
    setMutate('none');
    const decision = stop();
    expect(decision.reason).toContain('\nmutation: SKIPPED — Disabled in the rulebook.\n');
    expect(decision.reason).not.toContain('Mutation testing was not run');
  });

});

describe('mutation testing runs once per plan', () => {
  /** A second verified pass under the same plan: an edit, then a stop. */
  const passAgain = (text) => {
    writeFileSync(join(ctx.repo, 'mutation.test.mjs'), `// ${text}\n`);
    return stop();
  };

  it('records what the first verified pass found, and shows its survivors', () => {
    codeChange();
    setMutate(survivor('EqualityOperator'));
    const decision = stop();
    expect(decision.reason).toContain('mutation: FINDINGS\n1 survived · 0 killed · 1 mutants\nfeature.mjs:1 EqualityOperator → false');
    expect(events()).toEqual(['0001__plan_approved.json', '0002__triaged.json', '0003__verified.json']);
    const stored = measurement();
    expect(stored.result.text).toContain('1 mutant: 0 caught, 1 survived.');
    expect(stored).toMatchObject({ name: 'mutation', result: { exitCode: 1, outcome: 'findings' }, measurement: { toolOutcome: 'survived' } });
    expect(stored.measurement.findings).toMatchObject({ counts: { survived: 1, caught: 0 },
      survivors: [{ file: 'feature.mjs', id: '1', sourceLine: 'export const on = true;', mutator: 'EqualityOperator' }] });
    const verified = receipt();
    expect(mutationOf(verified)).toMatchObject({ status: 'ok', summary: { unproved: 0, errored: 0 } });
    const { raw } = snapshotsOf(verified);
    expect(readFileSync(join(ctx.repo, raw), 'utf8')).toBe(readFileSync(join(ctx.repo, 'reports/mutation/mutation.json'), 'utf8'));
  });

  it.each([['raw', 'removed'], ['findings', 'removed'], ['raw', 'altered'], ['findings', 'altered']])(
    'fails when its %s mutation snapshot is %s and resumes after exact restoration without rerunning', (kind, damage) => {
      codeChange();
      const count = join(ctx.home, 'mutation-runs');
      setMutate(mutationCommand('finished', 0, [], `fs.appendFileSync(${JSON.stringify(count)}, 'run\\n');`));
      expect(stop().reason).toContain('Verification passed');
      const first = receipt();
      const path = join(ctx.repo, snapshotsOf(first)[kind]);
      const originalBytes = readFileSync(path);
      if (damage === 'removed') rmSync(path);
      else writeFileSync(path, '{}');
      const later = passAgain('a later test');
      expect(later.reason).toContain('failed on the current working tree');
      expect(later.reason).toMatch(/mutation: verification \d+:/);
      expect(later.reason).toContain('Restore the exact evidence in .katatay/local/ or ask the operator to reset the workflow.');
      expect(readFileSync(count, 'utf8')).toBe('run\n');
      expect(receipt()).toEqual(first);
      expect(phase()).toBe('converging');
      const failure = JSON.parse(readFileSync(join(ctx.logbook, events().findLast(e => e.endsWith('__verify_failed.json'))), 'utf8'));
      expect(mutationOf(failure.payload).status).toBe('failed');
      writeFileSync(path, originalBytes);
      const restored = passAgain('test edit after restoring the original evidence');
      expect(restored.reason).toContain('Verification passed');
      expect(phase()).toBe('verified');
      expect(mutationOf()).toMatchObject(reusedFrom(first));
      expect(readFileSync(count, 'utf8')).toBe('run\n');
    });

});
