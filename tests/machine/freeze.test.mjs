/** The test freeze, and the files the gate lets through before any approval.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, approvedChange, approvePlan, attempt, phase, setVerify, show, stop, triage,
} from '../support/machine/harness.mjs';

machineFixture({ approved: true });

describe('files that never wait for a plan', () => {
  // Absolute already, the way Claude Code sends them, so `attempt` passes them
  // through untouched.
  const write = (file_path) => attempt(file_path);

  it('does not report a parked follow-up as an unapproved change', () => {
    writeFileSync(join(ctx.repo, 'FOLLOW-UPS.md'), '# Follow-ups\n\n- later\n');
    expect(stop()).toBeNull();
  });
});

describe('the test freeze', () => {
  const writeTest = (name = 'thing.test.mjs') => {
    writeFileSync(join(ctx.repo, name), 'it("x", () => {});\n');
  };

  it('says nothing about a change that leaves the tests alone', () => {
    approvedChange();
    writeFileSync(join(ctx.repo, 'source.txt'), 'implementation only\n');
    expect(stop().decision).toBeUndefined();
  });

  it('lifts once the triage is recorded', () => {
    approvedChange();
    triage();
    writeTest();
    const decision = stop();
    expect(decision.reason).not.toMatch(/frozen until the triage/);
    expect(decision.reason).toMatch(/Verification passed/);
    expect(phase()).toBe('verified');
  });

  it('puts the triage in front of the operator on the turn it lands', () => {
    approvedChange();
    triage({ level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 2 against 0 predicted, 20% or more.'], surprise: { failed: 2, total: 9, failures: ['a.test.ts — x (boom)', 'b.test.ts — y (boom)'], names: ['a.test.ts — x', 'b.test.ts — y'] } });
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/^Repeat this to the operator/);
    expect(decision.reason).toMatch(/Risk: HIGH/);
    expect(decision.reason).toContain('2 surprises');
    // The report names the tests, and leaves their messages in the event.
    expect(decision.reason).toContain('\nSurprises:\na.test.ts — x\nb.test.ts — y\n');
    expect(decision.reason).not.toContain('boom');
    expect(decision.reason).toMatch(/\n\nDetails: \.katatay\/state\/[^\n]+__triaged\.json/);
  });

  it('asks for the triage to be repeated when verify then fails', () => {
    approvedChange();
    triage({ level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.'], surprise: { failed: 1, total: 9, failures: ['a.test.ts — x'] } });
    setVerify(false);
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/^Repeat this to the operator[\s\S]*Risk: HIGH[\s\S]*\n\nThen:\n\n`workflow verify` failed on the current working tree[\s\S]*a test failed/);
  });

  /**
   * A change whose whole content is tests. The freeze does not move for it —
   * that is the point of these cases — because such a change triages first, on
   * the tree as it stands before the work, where there is nothing to freeze.
   */
  describe('declared test-only in the plan', () => {
    const declared = '# Plan\n\nAdd cases for the freeze itself.\n\n```workflow\ntest-only: true\n```\n';

    it('is recorded at approval and said out loud, in the turn and in state:show', () => {
      const decision = approvePlan({ plan: declared });
      expect(decision.systemMessage).toMatch(/test-only/);
      expect(decision.systemMessage).toMatch(/triage/i);
      expect(show()).toMatch(/declared test-only/);
    });

    // The advice is what changes. "Unwind them and run this again" is circular
    // when the tests are the change, and it is how two changes here concluded
    // the machine could not express one at all.
    it('tells the agent the triage comes first, where an ordinary plan does not', () => {
      approvePlan({ plan: declared });
      writeTest();
      expect(stop().reason).toMatch(/triage runs first/);
    });

    it('says the same on a turn with nothing to block', () => {
      approvePlan({ plan: declared });
      expect(stop().systemMessage).toMatch(/no implementation to wait for/);
    });
  });
});
