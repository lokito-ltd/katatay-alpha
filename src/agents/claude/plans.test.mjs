import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimCorrection, presentPlan } from './plans.mjs';

// Only the disk-full case overrides the real, exclusive marker write.
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

// Synthetic PreToolUse cases based on the documented ExitPlanMode input.
const hook = { session_id: 'session', prompt_id: 'prompt', tool_input: { planFilePath: '/plans/one.md' } };
const message = (code, text) => ({ code, for: 'operator', text });
const result = (needsCorrection, ...messages) => ({ answer: { version: 1, needsCorrection, messages } });
const invalid = result(true, message('refused', 'Correct the plan.'));
const advisory = (out, phrase) => {
  expect(out.systemMessage).toContain(phrase);
  expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: out.systemMessage });
};

describe('checking the file before the plan dialog', () => {
  it('asks only for presentation of the named file and stays silent on success', () => {
    const ask = vi.fn(() => result(false)); const claim = vi.fn();
    expect(presentPlan(hook, { ask, claim })).toBeNull();
    expect(ask.mock.calls).toEqual([['plan-presented', { version: 1, planFile: '/plans/one.md' }]]);
    expect(claim).not.toHaveBeenCalled();
  });

  it('never substitutes a transcript, inline text or approval response for a missing path', () => {
    for (const path of [undefined, null, '', ' \t', 9]) {
      const ask = vi.fn();
      advisory(presentPlan({ transcript_path: '/t', tool_response: { filePath: '/approved' }, tool_input: { planFilePath: path, plan: '# Draft' } }, { ask }), 'no tool_input.planFilePath');
      expect(ask).not.toHaveBeenCalled();
    }
  });

  it('interrupts for invalid contents only when the marker is claimed', () => {
    const claim = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const ask = vi.fn(() => invalid);
    expect(presentPlan(hook, { ask, claim, root: '/repo' })).toEqual({ systemMessage: 'Correct the plan.', hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Correct the plan.',
    } });
    expect(claim.mock.calls[0]).toEqual(['/repo', 'session', 'prompt']);
    advisory(presentPlan(hook, { ask, claim, root: '/repo' }), 'Correct the plan.');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('warns both audiences when identifiers or the marker are unavailable', () => {
    for (const key of ['session_id', 'prompt_id']) for (const value of [undefined, 1, '  ']) {
      const claim = vi.fn();
      advisory(presentPlan({ ...hook, [key]: value }, { ask: () => invalid, claim }), 'session_id or prompt_id');
      expect(claim).not.toHaveBeenCalled();
    }
    const claim = () => { throw Object.assign(new Error('could not write'), { code: 'EACCES' }); };
    const out = presentPlan(hook, { ask: () => invalid, claim });
    advisory(out, 'EACCES'); expect(out.systemMessage).toContain('Correct the plan.');
  });

  it('delivers read and checker failures without consuming the correction', () => {
    for (const [ask, text] of [
      [() => result(false, message('warning', 'File missing.')), 'File missing.'],
      [() => result(false, message('stop', 'Checker failed.')), 'Checker failed.'],
      [() => result(true), 'without an explanation'],
      [() => ({ problem: 'broken pipe' }), 'broken pipe'],
      [() => ({ answer: { version: 1, needsCorrection: 'yes', messages: [] } }), 'could not be checked'],
      [() => { throw new Error('not available'); }, 'not available'],
    ]) {
      const claim = vi.fn(); advisory(presentPlan(hook, { ask, claim }), text); expect(claim).not.toHaveBeenCalled();
    }
  });

  it('stores empty markers distinguished by repository, session and prompt', () => {
    const base = mkdtempSync(join(tmpdir(), 'courtesy-'));
    try {
      const claim = (...args) => claimCorrection(...args, base);
      expect(claim(base, 'a', 'b')).toBe(true);
      expect(claim(base, 'a', 'b')).toBe(false);
      expect(claim(base, 'other', 'b')).toBe(true);
      expect(claim(base, 'a', 'other')).toBe(true);
      expect(claim(tmpdir(), 'a', 'b')).toBe(true);
      const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      writeFileSync.mockImplementationOnce(() => { throw full; });
      expect(() => claim(base, 'a', 'fresh')).toThrow(full);
      expect(claim(base, 'a', 'fresh')).toBe(true);
      const folder = join(base, 'workflow-claude-plan-courtesy');
      for (const path of readdirSync(folder)) expect(readFileSync(join(folder, path))).toHaveLength(0);
      expect(() => claimCorrection(base, 'a', 'b', join(folder, readdirSync(folder)[0]))).toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
