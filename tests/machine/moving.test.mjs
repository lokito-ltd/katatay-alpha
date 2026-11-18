/** The baseline moving forward when the target is merged into the branch,
 *  and only then.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { machineFixture, approvedChange, git, phase, show, stop } from '../support/machine/harness.mjs';
import { read, eventNamed, targetGainsATest } from '../support/machine/baselines.mjs';
import { readBaseline } from '../../src/workflow/phase.mjs';

machineFixture({ approved: true });

describe('moving the baseline', () => {
  it('moves forward when the target is merged into the branch, and the merged-in tests are not this change\'s', () => {
    approvedChange();
    const pinned = readBaseline(read('0001__plan_approved.json').payload.baseline);
    targetGainsATest();
    git('merge', '--quiet', '--no-edit', 'origin/main');

    const decision = stop();
    expect(decision?.decision).not.toBe('block');
    const [moved] = eventNamed('baseline_moved');
    expect(read(moved).payload).toEqual({ from: pinned, to: git('rev-parse', 'origin/main').trim() });
    expect(phase()).toBe('implementing');
    expect(show()).toMatch(/^           moved [0-9a-f]{12} → [0-9a-f]{12}, \S+$/m);
  });
});
