/** The receipt: when verification runs, what it records, and what voids it.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, approvedChange, events, phase, setVerify, stop, triage,
} from '../support/machine/harness.mjs';

machineFixture({ approved: true });

describe('the walk from open to recorded', () => {
  it('verifies nothing while the implementation is still being written', () => {
    approvedChange();
    writeFileSync(join(ctx.repo, 'source.txt'), 'implementation in progress');
    const decision = stop();
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/workflow triage/);
    expect(events()).toEqual(['0001__plan_approved.json']);
  });

  it('blocks the turn when verification fails, and records the failure', () => {
    approvedChange();
    triage();
    setVerify(false);
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('a test failed');
    expect(events()).toContain('0003__verify_failed.json');
    expect(phase()).toBe('converging');
  });

});

/**
 * A passing verify is said with a block, because the desktop app folds a
 * message away and this is the result the operator most needs to read. The
 * block's reason reaches Claude, so it asks to be passed on.
 */
describe('a passing verify, relayed', () => {
  const relayed = () => {
    approvedChange();
    triage();
    const decision = stop();
    expect(decision.decision).toBe('block');
    return decision;
  };

  it('blocks with the result and asks Claude to repeat it to the operator', () => {
    const { reason } = relayed();
    expect(reason).toMatch(/^Repeat this to the operator in full/);
    expect(reason).toMatch(/Verification passed/);
    expect(events()).toContain('0003__verified.json');
  });

  it('does not block again when the relaying turn changed nothing', () => {
    relayed();
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/Verification passed/);
    expect(decision.systemMessage).not.toContain('Write the checks analysis');
    expect(phase()).toBe('verified');
  });

  // The relay must not use up the turn's one block, or a failure the relaying
  // turn caused could only be a folded message.
  it('still blocks a failure the relaying turn caused, and only once', () => {
    relayed();
    setVerify(false);
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('a test failed');
    expect(events()).toContain('0004__verify_failed.json');

    writeFileSync(join(ctx.repo, 'repair.test.mjs'), '// a fix that did not work\n');
    const after = stop({ stop_hook_active: true });
    expect(after.decision).toBeUndefined();
    expect(after.systemMessage).toContain('a test failed');
  });

  // Fixing the failure produces a fresh receipt with its own analysis request.
  it('relays a fresh analysis request after a fixed failure', () => {
    approvedChange();
    triage();
    setVerify(false);
    expect(stop().decision).toBe('block');
    setVerify(true);
    const { reason } = stop({ stop_hook_active: true });
    expect(reason).toContain('Verification passed');
    expect(reason).toContain('Write the checks analysis');
  });
});

/**
 * The stop that ends a turn this hook already blocked. Claude Code marks it with
 * `stop_hook_active`. Check the fix and deliver any fresh verification once.
 * Repeating the request on an unchanged tree would hold the session in a loop.
 */
describe('the stop after a block', () => {
  const blocked = () => {
    approvedChange();
    triage();
    setVerify(false);
    expect(stop().decision).toBe('block');
  };

  it('requests the analysis once when the forced turn fixed the failure', () => {
    blocked();
    setVerify(true);
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/Verification passed/);
    expect(stop({ stop_hook_active: true }).decision).toBeUndefined();
    expect(events()).toContain('0004__verified.json');
    expect(phase()).toBe('verified');
  });

  it('records a failure when the forced turn changed the tree and it still fails, without blocking', () => {
    blocked();
    writeFileSync(join(ctx.repo, 'repair.test.mjs'), '// a fix that did not work\n');
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toContain('a test failed');
    expect(events()).toContain('0004__verify_failed.json');
    expect(phase()).toBe('converging');
  });

  // The last answer is already about this exact tree, and a second run can
  // take minutes to say the same thing.
  it('does not run verify again when the forced turn changed nothing', () => {
    blocked();
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/not run again/);
    expect(events()).toHaveLength(3);
  });

  it('reports the frozen tests without blocking', () => {
    approvedChange();
    writeFileSync(join(ctx.repo, 'thing.test.mjs'), 'it("x", () => {});\n');
    expect(stop().decision).toBe('block');
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toContain('thing.test.mjs');
  });
});
