import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitFixtureAnalysis, ctx, fixtureChecks, setMutate, approvePlan, events, git, machineFixture, phase, planFile, reportedChangeFile, triage } from '../support/machine/harness.mjs';
import { GUARD, VERIFY } from '../../src/workflow/moments/turn-end.mjs';
import { onPrompt } from '../../src/workflow/moments/prompt.mjs';
import * as planTemplate from '../../src/workflow/plan-template.mjs';
import { mutationReferences, resultNamed } from '../../src/workflow/result-readers.mjs';
import { inFixture, present, end, said } from '../support/workflow/presenting.mjs';

machineFixture();

function passVerify(_, args) {
  writeFileSync(args[1], JSON.stringify({ results: fixtureChecks() }));
  return { status: 0, stdout: 'Passed.' };
}

describe('presented plans at turn end', () => {
  it('validates a revision while preserving the existing approval', () => {
    approvePlan();
    const before = events();
    const result = end({ planFile: present('Invalid revision.') });
    expect(result.keepWorking).toBe(true);
    expect(said(result)).toContain('section Why is missing');
    expect(phase()).toBe('implementing');
    expect(events()).toEqual(before);
  });

  it('retains the freeze and normal refusal even when a plan file cannot be read', () => {
    approvePlan();
    writeFileSync(join(ctx.repo, 'new.test.mjs'), 'export {};');
    for (const planFile of [present('Invalid plan.'), join(ctx.home, '.claude/plans/missing.md')]) {
      const result = end({ planFile });
      expect(result.keepWorking).toBe(true);
      expect(result.messages.some(m => m.code === 'frozen')).toBe(true);
      expect(result.messages.some(m => m.code === 'refused' || m.code === 'warning')).toBe(true);
      expect(end({ planFile, stopRefusedBefore: true }).keepWorking).toBe(false);
    }
  });

  it('runs mutation during verification despite an invalid plan', () => {
    approvePlan();
    writeFileSync(join(ctx.repo, 'feature.mjs'), 'export const on = true;');
    triage();
    const result = end({ planFile: present('Invalid plan.'), secondsLeft: 900 });
    const verified = JSON.parse(readFileSync(join(ctx.logbook, events().findLast(e => e.endsWith('__verified.json'))), 'utf8')).payload;
    const run = JSON.parse(readFileSync(join(ctx.repo, mutationReferences(resultNamed(verified.results, 'mutation')).findings), 'utf8'));
    expect(run).toMatchObject({ result: { exitCode: 0, outcome: 'clean' }, measurement: { toolOutcome: 'clean', findings: { counts: { total: 0 } } } });
    expect(said(result)).toMatch(/\nPassed:\n[\s\S]*\nmutation: PASSED\n/);
    expect(result.messages.some(m => m.code === 'refused')).toBe(true);
  });

  it('still verifies and reports a checker exception, asking for correction only once', () => {
    approvePlan();
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed');
    triage();
    const broken = vi.spyOn(planTemplate, 'templateProblems').mockImplementation(() => { throw new Error('checker failed'); });
    setMutate('none');
    const referee = vi.fn(passVerify);
    try {
      const result = end({ planFile: present() }, { referee });
      expect(referee).toHaveBeenCalledWith(VERIFY, ['--results', expect.any(String), '--deadline', expect.any(String)], expect.any(Object));
      expect(result.messages).toContainEqual({ code: 'stop', for: 'operator', text: 'The presented-plan check failed: checker failed' });
      expect(result.messages.some(m => m.code === 'verified')).toBe(true);
      expect(result.keepWorking).toBe(true);
      const again = end({ planFile: present(), stopRefusedBefore: true }, { referee });
      expect(again.keepWorking).toBe(false);
      expect(said(again)).toContain('checker failed');
    } finally { broken.mockRestore(); }
  });

  it('records a declared change despite an invalid presented plan', () => {
    // The report compares the change file with this local target, just as
    // the full Codex journey does when it exercises declaration.
    git('checkout', '--quiet', '-b', 'main');
    git('checkout', '--quiet', 'feat/x');
    approvePlan();
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed');
    triage();
    // Real fixture verification writes the report that declaration reads.
    end();
    submitFixtureAnalysis();
    const declaration = inFixture(() => onPrompt({ prompt: 'record' }));
    expect(phase(), said(declaration)).toBe('declared');
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    const change = 'requirements/changes/20260908T000000.000Z__x.md';
    writeFileSync(join(ctx.repo, change), reportedChangeFile());
    const referee = vi.fn(() => ({ status: 0, stdout: 'Guard passed.' }));
    const result = end({ planFile: present('Invalid plan.') }, { referee });
    expect(referee).toHaveBeenCalledWith(GUARD, ['--record'], expect.any(Object));
    expect(phase()).toBe('recorded');
    expect(result.messages.map(m => m.code)).toEqual(['refused', 'recorded']);
    expect(git('diff', '--cached', '--name-only')).toContain(change);
  });
});
