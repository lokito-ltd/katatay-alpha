/** Plan presentation decisions that run in the fast project. */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ctx, setMutate, approvePlan, events, git, machineFixture, phase, planFile, triage } from '../../../tests/support/machine/harness.mjs';
import { append, fileFor } from '../chain.mjs';
import { snapshotGrant } from '../../../tests/fixtures/workflow/events.mjs';
import { VERIFY, SHAPE } from './turn-end.mjs';
import { onPlanPresented } from './plan-presented.mjs';
import { onPlanApproved } from './plan-approved.mjs';
import { shapeProblems } from './io.mjs';
import { valid, inFixture, present, end, said, switchTo } from '../../../tests/support/workflow/presenting.mjs';

machineFixture();

describe('presented plans at turn end', () => {
  it('returns only the courtesy decision without running phase work on a converging change', () => {
    approvePlan();
    triage();
    const before = events();
    const check = (file) => inFixture(() => onPlanPresented({ planFile: file }));
    expect(check(present())).toEqual({ version: 1, needsCorrection: false, messages: [] });
    expect(check(present('Invalid.'))).toMatchObject({ needsCorrection: true, messages: [{ code: 'refused' }] });
    expect(check(planFile('missing.md'))).toMatchObject({ needsCorrection: false, messages: [{ code: 'warning' }] });
    switchTo('false');
    expect(check(present())).toMatchObject({ needsCorrection: false, messages: [{ code: 'stop' }] });
    expect(events()).toEqual(before);
  });

  it('accepts a complete plan silently without granting permission or recording an event', () => {
    const before = events();
    expect(end({ planFile: present() })).toEqual({ version: 1, keepWorking: false, messages: [] });
    expect(events()).toEqual(before);
    expect(phase()).toBe('open');
  });

  it('reports all template problems, requests correction once, and accepts the corrected plan', () => {
    const file = present('## Why\n{{WHY}}\n\n## What\n');
    const result = end({ planFile: file });
    expect(result.keepWorking).toBe(true);
    expect(said(result)).toMatch(/placeholder/);
    expect(said(result)).toMatch(/section What is empty/);
    expect(said(result)).toMatch(/section How is missing/);
    expect(said(result)).toContain('\n- section What is empty\n- section How is missing');
    expect(said(result)).toMatch(/present the complete plan again/);
    expect(said(result)).toContain(`The presented plan in ${realpathSync(file)} has these problems:`);
    const again = end({ planFile: file, stopRefusedBefore: true });
    expect(again.keepWorking).toBe(false);
    expect(said(again)).toMatch(/placeholder/);
    expect(end({ planFile: present() }).keepWorking).toBe(false);
    expect(phase()).toBe('open');
  });

  it('skips plans on ordinary turns with an omitted or null path', () => {
    present('Invalid older plan.');
    expect(end().messages).toEqual([]);
    expect(end({ planFile: null }).messages).toEqual([]);
  });

  it.each([true, false])('checks declarations with template enforcement set to %s', (enabled) => {
    switchTo(enabled);
    for (const block of ['predicted-failures: [', 'predicted-failures: [3]', 'unknown-key: yes']) {
      const result = end({ planFile: present(valid + '\n```workflow\n' + block + '\n```') });
      expect(result.keepWorking).toBe(true);
      expect(said(result)).toContain('problems');
    }
    expect(end({ planFile: present('```workflow\npredicted-failures: []\n```\n' + valid) }).keepWorking).toBe(true);
    expect(end({ planFile: present('---\npredicted-failures: []\n---\n' + valid) }).keepWorking).toBe(true);
  });

  it('disables only template checks and refuses an invalidly typed switch', () => {
    switchTo(false);
    expect(said(end({ planFile: present('A short plan without sections.') }))).not.toContain('section Why');
    switchTo(true);
    expect(said(end({ planFile: present('A short plan without sections.') }))).toContain('section Why');
    switchTo('false');
    const result = end({ planFile: present() });
    expect(result.keepWorking).toBe(true);
    expect(said(result)).toContain('plans.validateFormat');
  });

  it('warns about unreadable files, subfolders and files outside the plans folder without blocking', () => {
    const missing = end({ planFile: planFile('missing.md') });
    expect(said(missing)).toContain('cannot be read');
    expect(missing.keepWorking).toBe(false);
    expect(missing.messages[0]).toMatchObject({ code: 'warning', for: 'operator' });
    for (const file of [join(ctx.repo, 'elsewhere.md'), planFile('sub/plan.md'), planFile('not-markdown.txt')]) {
      const result = end({ planFile: file });
      expect(said(result)).toContain('not a Markdown file directly');
      expect(result.keepWorking).toBe(false);
    }
  });

  it.each([1])('still runs verify with an invalid plan and returns both results (verify status %s)', (status) => {
    approvePlan();
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed');
    triage();
    setMutate('none');
    const referee = vi.fn(() => ({ status, stdout: status ? 'A test failed.' : 'Passed.' }));
    const result = end({ planFile: present('Invalid plan.') }, { referee });
    expect(referee).toHaveBeenCalledWith(VERIFY, ['--results', expect.any(String), '--deadline', expect.any(String)], expect.any(Object));
    expect(result.messages.map(m => m.code)).toContain(status ? 'verify_failed' : 'verified');
    expect(result.messages.map(m => m.code)).toContain('refused');
    expect(result.keepWorking).toBe(true);
    expect(events().some(e => e.endsWith(status ? '__verify_failed.json' : '__verified.json'))).toBe(true);
    const corrected = end({ planFile: present(), stopRefusedBefore: true }, { referee });
    expect(corrected.keepWorking).toBe(false);
    expect(corrected.messages.some(m => m.code === 'refused')).toBe(false);
    expect(referee).toHaveBeenCalledTimes(1);
  });

  it('keeps template validation out of approval and requires no receipt', () => {
    const file = present('A short plan without sections.');
    const result = inFixture(() => onPlanApproved({ planFile: file }));
    expect(result.recorded).toBe(true);
    expect(phase()).toBe('implementing');
  });

  it('keeps the prior grant after a publication failure and records the revision once on retry', () => {
    const file = present('The first plan.');
    const approve = () => inFixture(() => onPlanApproved({ planFile: file }));
    expect(approve().recorded).toBe(true);
    const before = events();
    const eventPath = join(ctx.logbook, before[0]);
    const original = readFileSync(eventPath);
    const folder = join(ctx.repo, '.katatay/local/feat_x/plans');
    renameSync(folder, folder + '-saved');
    writeFileSync(folder, 'a regular file blocks publication');
    writeFileSync(file, 'A material revision.');
    expect(approve()).toMatchObject({ recorded: false, messages: [{ code: 'stop' }] });
    expect(events()).toEqual(before);
    expect(readFileSync(eventPath)).toEqual(original);
    unlinkSync(folder);
    renameSync(folder + '-saved', folder);
    expect(approve().recorded).toBe(true);
    expect(approve().recorded).toBe(false);
    expect(events()).toEqual([...before, '0002__plan_approved.json']);
    const readSnapshot = ({ payload }) => {
      expect(payload).not.toHaveProperty('planSnapshotFile');
      return readFileSync(join(ctx.repo, payload.planSnapshot), 'utf8');
    };
    expect(readSnapshot(JSON.parse(original))).toBe('The first plan.');
    expect(readSnapshot(JSON.parse(readFileSync(join(ctx.logbook, events()[1]), 'utf8')))).toBe('A material revision.');
  });

  it('reuses a stored dual-field grant and publishes one snapshot for its revision', () => {
    const first = 'The approved plan.\r\n';
    const { payload } = snapshotGrant('feat/x', first, ctx.repo);
    const historical = append(ctx.logbook, 'plan_approved', {
      ...payload, baseline: git('rev-parse', 'HEAD').trim(),
    }, 'feat/x');
    const eventPath = join(ctx.logbook, fileFor(historical));
    // Stage 1 wrote this extra field in the approval that authorizes stage 2.
    historical.payload.planSnapshotFile = payload.planSnapshot;
    writeFileSync(eventPath, JSON.stringify(historical, null, 2) + '\n');
    const originalEvent = readFileSync(eventPath);
    const snapshotDir = dirname(join(ctx.repo, payload.planSnapshot));
    const approve = (text) => {
      const planFile = present(text);
      return inFixture(() => onPlanApproved({ planFile }));
    };

    const replay = approve(first);
    expect(replay.recorded).toBe(false);
    expect(said(replay)).toContain('already approved');
    expect(events()).toEqual([fileFor(historical)]);
    expect(readdirSync(snapshotDir)).toEqual([basename(payload.planSnapshot)]);

    const revision = 'The revised plan.\r\n';
    expect(approve(revision).recorded).toBe(true);
    const revisedEvent = '0002__plan_approved.json';
    expect(events()).toEqual([fileFor(historical), revisedEvent]);
    const { planSnapshot, planSnapshotFile } = JSON.parse(readFileSync(join(ctx.logbook, revisedEvent))).payload;
    expect(planSnapshotFile).toBeUndefined();
    expect(readFileSync(join(ctx.repo, planSnapshot))).toEqual(Buffer.from(revision));
    expect(readFileSync(join(ctx.repo, payload.planSnapshot))).toEqual(Buffer.from(first));
    expect(readdirSync(snapshotDir).sort()).toEqual([basename(payload.planSnapshot), basename(planSnapshot)].sort());
    expect(readFileSync(eventPath)).toEqual(originalEvent);
  });

  it('accepts the optional wire field while rejecting invalid values', () => {
    const base = { version: 1, stopRefusedBefore: false, secondsLeft: 0 };
    for (const value of [undefined, null, '/plans/a.md']) expect(shapeProblems({ ...base, planFile: value }, SHAPE)).toEqual([]);
    for (const value of ['', 3, false, []]) expect(shapeProblems({ ...base, planFile: value }, SHAPE)).not.toEqual([]);
  });
});
