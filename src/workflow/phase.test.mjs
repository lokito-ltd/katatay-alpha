import { verificationInputs, verified as receiptPayload, triaged as counts } from '../../tests/fixtures/workflow/events.mjs';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { readBaseline, baselineOf, baselinesIn, declarationFor, epoch, latestVerified, testsChangedSinceVerify, sameMeasurement, sameVerificationInputs, grant, heldFor, phaseOf, provedBaselines, receiptFor, recordFor, RISK_MEANS, transitions, triageCountLine, triageIn, triageNames } from './phase.mjs';

const { implementationFingerprint, testFingerprint } = receiptPayload();
const measurement = (treeFingerprint, changes = {}) => ({ treeFingerprint, implementationFingerprint, testFingerprint,
  ...verificationInputs, ...changes });
const ev = (event, payload = {}) => {
  if (event === 'verified') payload = receiptPayload(payload);
  if (event === 'triaged') payload = counts({ implementationFingerprint, ...payload });
  return { seq: 0, prev: null, ts: '2026-01-01T00:00:00.000Z', event, payload };
};

const state = (entries, { treeFingerprint = 'T', changeFiles = [], changeDigest = '', merged = 0 } = {}) =>
  phaseOf({ entries, ...measurement(treeFingerprint), changeFiles, changeDigest, merged });

/** The shortest legal route to a tree that may be verified: approved, then
 *  triaged. Spelled out here so the cases below read as what they test rather
 *  than as a setup ritual. */
const granted = [ev('plan_approved'), ev('triaged', { treeFingerprint: 'T', level: 'LOW' })];

describe('phase', () => {
  it('is open until the operator approves a plan', () => {
    expect(state([]).phase).toBe('open');
    expect(state([ev('verify_failed', { treeFingerprint: 'T' })]).phase).toBe('open');
  });

  it('opens on a plan approval', () => {
    expect(state([ev('plan_approved')]).phase).toBe('implementing');
  });

  it('stays in implementing while the tree has no passing verification', () => {
    expect(state([ev('plan_approved'), ev('verify_failed', { treeFingerprint: 'T' })]).phase).toBe('implementing');
  });

  it('reaches verified only for a receipt matching this exact tree', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'OLD' })];
    expect(state(entries).phase).toBe('converging');
    expect(state([...entries, ev('verified', { treeFingerprint: 'T' })]).phase).toBe('verified');
  });

  it('requires a verification after the latest triage even when the tree is identical', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'T' }), ev('triaged', { treeFingerprint: 'T' })];
    expect(state(entries).phase).toBe('converging');
    expect(receiptFor(entries, measurement('T'))).toBeNull();
    const fresh = ev('verified', { treeFingerprint: 'T' });
    entries.push(fresh);
    expect(receiptFor(entries, measurement('T'))).toBe(fresh);
    expect(state(entries).phase).toBe('verified');
  });

  it('stays verified when a change file exists but the operator has not declared it finished', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'T' })];
    expect(state(entries, { changeFiles: ['requirements/changes/x.md'], changeDigest: 'D' }).phase).toBe('verified');
  });

  it('does not let a change file substitute for verification', () => {
    const entries = [ev('plan_approved')];
    expect(state(entries, { changeFiles: ['requirements/changes/x.md'] }).phase).toBe('implementing');
  });
});

describe('the approved plan', () => {
  // Plans are revised mid-change and approved again. The plan in force is the
  // one approved last, not the one that happened to come first.
  it('is the latest approval, not the first', () => {
    const entries = [ev('plan_approved', { proposal: 'first' }), ev('plan_approved', { proposal: 'revised' })];
    expect(grant(epoch(entries)).payload.proposal).toBe('revised');
  });

  // A triage belongs to the plan it follows. The work a revision adds has never
  // been triaged, and a triage inherited from the plan before would let it
  // through with the tests already unfrozen. This case used to say the
  // opposite; the operator decided on 2026-09-25 that a revision is triaged
  // again.
  it('reopens the freeze when a revised plan is approved after the triage', () => {
    const revised = [...granted, ev('plan_approved', { proposal: 'revised' })];
    expect(triageIn(epoch(revised))).toBeNull();
    expect(state(revised).phase).toBe('implementing');
    expect(state(revised).why).toMatch(/approved again after the last triage/);
    expect(state([...revised, ev('triaged', { treeFingerprint: 'T', level: 'LOW' })]).phase).toBe('converging');
  });

  // Nor does a receipt from before the revision vouch for the tree after it.
  it('does not count a receipt written under the plan it replaced', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'T' }), ev('plan_approved', { proposal: 'revised' }), ev('triaged', { treeFingerprint: 'T' })];
    expect(state(entries).phase).toBe('converging');
  });

  // A branch holds one change until it merges. The approval hook refuses a
  // second plan after `recorded`; this is the same rule read from the logbook, so a
  // logbook written by older code cannot grant one either.
  it('grants nothing from an approval after the change was recorded', () => {
    const finished = [...granted, ev('verified', { treeFingerprint: 'T' }), ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'D' })];
    const second = [...finished, ev('plan_approved', { proposal: 'second change' })];
    expect(grant(epoch(second)).payload.proposal).toBeUndefined();
    expect(state(second, { changeFiles: ['requirements/changes/x.md'], changeDigest: 'D' }).phase).toBe('recorded');
  });

  // Fixing the recorded change needs no new plan: an edit goes back to
  // converging under the plan it was recorded under.
  it('still lets the recorded change be fixed under its own plan', () => {
    const finished = [...granted, ev('verified', { treeFingerprint: 'T' }), ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'D' })];
    expect(state(finished, { treeFingerprint: 'EDITED', changeFiles: ['requirements/changes/x.md'], changeDigest: 'D' }).phase).toBe('converging');
  });
});

/** The commit a change is measured from, pinned at approval and moved forward
 *  when the target is merged into the branch. */
it.each([undefined, null])('reads an absent baseline (%s) as null', value => {
  expect(readBaseline(value)).toBeNull();
});

it.each(['baseline', 'rulebookFingerprint'])('never reuses verification inputs with an absent %s', field => {
  expect(sameVerificationInputs(verificationInputs, verificationInputs)).toBe(true);
  for (const missing of [undefined, null, '']) {
    const inputs = { ...verificationInputs, [field]: missing };
    expect(sameVerificationInputs(inputs, inputs)).toBe(false);
    expect(sameVerificationInputs(inputs, verificationInputs)).toBe(false);
    expect(sameVerificationInputs(verificationInputs, inputs)).toBe(false);
  }
});

it('does not extract a commit from a retired baseline object', () => {
  expect(readBaseline({ sha: verificationInputs.baseline, source: 'server' })).toBeNull();
});

describe('the baseline', () => {
  const pinned = (baseline) => ev('plan_approved', { baseline });

  it('reads the stored baseline as a commit', () => {
    expect(readBaseline(verificationInputs.baseline)).toBe(verificationInputs.baseline);
  });

  it('is the one the approval pinned', () => {
    expect(baselineOf(epoch([pinned('A')]))).toBe('A');
  });

  it('is the latest move after that', () => {
    const entries = [pinned('A'), ev('baseline_moved', { from: 'A', to: 'B' }), ev('baseline_moved', { from: 'B', to: 'C' })];
    expect(baselineOf(epoch(entries))).toBe('C');
    expect(baselinesIn(epoch(entries))).toEqual(['A', 'B', 'C']);
  });

  // A revision keeps the baseline in force, so it records the same sha again,
  // and the gate proves it once.
  it('lists each sha once, however often it was recorded', () => {
    const entries = [pinned('A'), ev('baseline_moved', { from: 'A', to: 'B' }), pinned('B')];
    expect(baselineOf(epoch(entries))).toBe('B');
    expect(baselinesIn(epoch(entries))).toEqual(['A', 'B']);
  });

  it('is not carried across a reset', () => {
    expect(baselineOf(epoch([pinned('A'), ev('reset')]))).toBeNull();
  });

  it('reads the baseline at the requested sequence and ignores verification baselines', () => {
    const entries = [pinned('A'), ev('baseline_moved', { from: 'A', to: 'B' }), pinned('B'),
      ev('verified', { baseline: 'C' }), ev('verify_failed', { baseline: 'D' })]
      .map((entry, i) => ({ ...entry, seq: i + 1 }));
    expect(baselineOf(entries, 0)).toBeNull();
    expect(baselineOf(entries, 1)).toBe('A');
    expect(baselineOf(entries, 2)).toBe('B');
    expect(baselineOf(entries, 3)).toBe('B');
    expect(baselineOf(entries)).toBe('B');
    expect(baselinesIn(entries)).toEqual(['A', 'B']);
  });
});

/** The baselines a `recorded` event vouches for. The hook proves every baseline
 *  on the server before it writes `recorded`, so `state:verify` trusts these
 *  without finding them on the target. */
describe('the proved baselines', () => {
  const pinned = (baseline) => ev('plan_approved', { baseline });
  const recorded = ev('recorded', { treeFingerprint: 'T', changes: 'D' });

  it('are every baseline pinned or moved before the last recorded', () => {
    const entries = [pinned('A'), ev('baseline_moved', { from: 'A', to: 'B' }), recorded];
    expect(provedBaselines(epoch(entries))).toEqual(['A', 'B']);
  });

  it('are none while the change is not recorded', () => {
    expect(provedBaselines(epoch([pinned('A'), ev('verified', { treeFingerprint: 'T' }), ev('declared', { treeFingerprint: 'T' })]))).toEqual([]);
  });

  // The target merged in after recording moves the baseline, and nothing has
  // proved the new one yet.
  it('leave out a baseline moved after the last recorded', () => {
    const entries = [pinned('A'), recorded, ev('baseline_moved', { from: 'A', to: 'B' })];
    expect(provedBaselines(epoch(entries))).toEqual(['A']);
  });

  it('take in a baseline moved before a later recorded', () => {
    const entries = [pinned('A'), recorded, ev('baseline_moved', { from: 'A', to: 'B' }), recorded];
    expect(provedBaselines(epoch(entries))).toEqual(['A', 'B']);
  });

  it('do not reach back past a reset', () => {
    expect(provedBaselines(epoch([pinned('A'), recorded, ev('reset'), pinned('B')]))).toEqual([]);
  });
});

describe('triage', () => {
  it('holds an approved change in implementing until the suite has been triaged', () => {
    expect(state([ev('plan_approved')]).phase).toBe('implementing');
    expect(state(granted).phase).toBe('converging');
  });

  // The gate the whole phase exists for. Verification on its own is not enough,
  // because a change driven straight to green never showed anyone what it broke.
  it('refuses to reach verified on a receipt with no triage behind it', () => {
    const entries = [ev('plan_approved'), ev('verified', { treeFingerprint: 'T' })];
    expect(state(entries).phase).toBe('implementing');
    expect(state(entries, { changeFiles: ['requirements/changes/x.md'] }).phase).toBe('implementing');
  });

  // Nobody wrote this transition. The receipt names a tree and stops matching,
  // while the triage records something that happened and cannot stop having
  // happened. Landing in implementing would re-freeze the tests at the exact
  // moment a red verification means one needs fixing.
  it('drops an edited tree back to converging rather than to implementing', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'T' })];
    expect(state(entries).phase).toBe('verified');
    expect(state(entries, { treeFingerprint: 'EDITED' }).phase).toBe('converging');
  });

  it('is cleared by a reset, because that starts the change over', () => {
    expect(triageIn(epoch(granted))).not.toBeNull();
    expect(triageIn(epoch([...granted, ev('reset')]))).toBeNull();
    expect(state([...granted, ev('reset'), ev('plan_approved')]).phase).toBe('implementing');
  });

  it('names the frozen tests when there is nothing to fix yet', () => {
    expect(transitions('implementing').join(' ')).toMatch(/frozen/);
    expect(transitions('converging').join(' ')).toMatch(/write the tests/);
  });
});

describe('reset', () => {
  it('ends the epoch by being appended, leaving the logbook whole', () => {
    const entries = [ev('plan_approved'), ev('verified', { treeFingerprint: 'T' }), ev('reset')];
    expect(entries).toHaveLength(3);
    expect(epoch(entries)).toEqual([]);
    expect(state(entries).phase).toBe('open');
  });

  it('keeps only the approvals that came after it', () => {
    const entries = [ev('plan_approved', { proposal: 'old' }), ev('reset'), ev('plan_approved', { proposal: 'new' })];
    expect(grant(epoch(entries)).payload.proposal).toBe('new');
    expect(grant(epoch([ev('plan_approved', { proposal: 'old' }), ev('reset')]))).toBeNull();
  });

  it('discards a receipt written before it', () => {
    const entries = [ev('plan_approved'), ev('verified', { treeFingerprint: 'T' }), ev('reset'), ev('plan_approved')];
    expect(receiptFor(epoch(entries), measurement('T'))).toBeNull();
    expect(state(entries).phase).toBe('implementing');
  });
});

/** A branch name is reused, or work continues after a merge. Either way the logbook
 *  arrives with events already in `main`, and reading those as live would hand
 *  the new change a plan nobody approved for it. */
describe('merged events', () => {
  const finished = [...granted, ev('verified', { treeFingerprint: 'T' }), ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'D' })];

  // A new change on a reused name has a tree of its own, so the old receipts
  // never match it. That is what used to land it in `converging`: a plan and a
  // triage inherited from a change that was over, and the freeze already gone.
  it('grant nothing once the whole logbook is in main', () => {
    expect(state(finished, { treeFingerprint: 'NEW' }).phase).toBe('converging');
    expect(state(finished, { treeFingerprint: 'NEW', merged: finished.length }).phase).toBe('open');
  });

  it('say why, so a folder full of events reporting open reads as the answer', () => {
    expect(state(finished, { merged: finished.length }).why).toMatch(/merged/);
    expect(state([]).why).toMatch(/no plan has been approved/);
  });

  // The `recorded`-but-unmerged case, which is the ordinary "one more fix
  // before I merge" loop. Nothing here may move.
  it('leave a recorded change alone until it is actually merged', () => {
    const files = { changeFiles: ['requirements/changes/x.md'], changeDigest: 'D' };
    expect(state(finished, files).phase).toBe('recorded');
    expect(state(finished, { ...files, treeFingerprint: 'EDITED' }).phase).toBe('converging');
  });

  it('keep the live events that came after them', () => {
    const entries = [...finished, ev('plan_approved', { proposal: 'next' })];
    expect(epoch(entries, finished.length)).toHaveLength(1);
    expect(state(entries, { merged: finished.length }).phase).toBe('implementing');
  });

  // A branch merged mid-change: the approval reached the target, the triage
  // after it did not. The triage left on the live side belongs to a plan that
  // is over, and a new plan must be triaged for itself.
  it('leave a triage stranded by a mid-change merge granting nothing', () => {
    const entries = [ev('plan_approved', { proposal: 'merged' }), ev('triaged', { treeFingerprint: 'T' }), ev('plan_approved', { proposal: 'next' })];
    expect(state(entries.slice(0, 2), { merged: 1 }).phase).toBe('open');
    expect(triageIn(epoch(entries, 1))).toBeNull();
    expect(state(entries, { merged: 1 }).phase).toBe('implementing');
  });

  // Two boundaries, and the change starts at whichever is later. A reset after
  // the merge must not resurrect the merged events, and a merge that reaches
  // past a reset must not leave the events before it live.
  it('take the later boundary when a reset is in play too', () => {
    const afterReset = [...granted, ev('reset'), ev('plan_approved', { proposal: 'new' })];
    expect(epoch(afterReset, 2)).toHaveLength(1);
    expect(epoch(afterReset, afterReset.length)).toEqual([]);
    expect(grant(epoch(afterReset, afterReset.length))).toBeNull();
  });
});

describe('declaring a change finished', () => {
  const verified = [...granted, ev('verified', { treeFingerprint: 'T' })];
  const files = { changeFiles: ['requirements/changes/x.md'], changeDigest: 'D' };

  it('is declared once the operator records this tree, before any change file', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' })];
    expect(state(entries).phase).toBe('declared');
    expect(state(entries).declaration).not.toBeNull();
  });

  it('does not count a declaration made about another tree', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'OLD' })];
    expect(declarationFor(epoch(entries), measurement('T'))).toBeNull();
    expect(state(entries, files).phase).toBe('verified');
  });

  it('stays declared while the change file has not passed the guard', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' })];
    expect(state(entries, files).phase).toBe('declared');
  });

  it('is recorded when the guard passed on these exact change files', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'D' })];
    expect(state(entries, files).phase).toBe('recorded');
  });

  it('does not count a guard pass on change files that have since been edited', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'OLD' })];
    expect(recordFor(epoch(entries), measurement('T'), 'D')).toBeNull();
    expect(state(entries, files).phase).toBe('declared');
  });

  // Git wins. The event cannot stand in for a change file git does not have.
  it('is not recorded when git shows no change file, whatever the logbook says', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: '' })];
    expect(state(entries).phase).toBe('declared');
  });

  it('cannot be declared without a receipt for the tree', () => {
    const entries = [...granted, ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'D' })];
    expect(state(entries, files).phase).toBe('converging');
  });

  it('is cleared by a reset', () => {
    const entries = [...verified, ev('declared', { treeFingerprint: 'T' }), ev('reset')];
    expect(declarationFor(epoch(entries), measurement('T'))).toBeNull();
  });

  it('tells the agent to hand verified work to the operator, and declared work to a change file', () => {
    expect(transitions('verified').join(' ')).toContain('typing `record` again on the same tree declares the change');
    expect(transitions('declared').join(' ')).toMatch(/write the change file/);
  });

  // Coming back from recorded to fix something leaves the change file in place.
  // Telling the agent to write one it already has sends it looking for a
  // problem that does not exist.
  it('does not ask for a change file that already exists', () => {
    const next = transitions('declared', { changeFiles: ['requirements/changes/x.md'] }).join(' ');
    expect(next).not.toMatch(/write the change file/);
    expect(next).toMatch(/req:guard runs on the change file/);
  });

  // The requirements folder is the rulebook's, and `init` asks for it. A
  // project that keeps it elsewhere must be sent to its own `changes/`.
  it('names the change file folder under the rulebook\'s requirements folder', () => {
    const cwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'phase-declared-'));
    try {
      writeConfig(root, { fields: { requirementsDir: 'docs/specs/' } });
      process.chdir(root);
      const next = transitions('declared').join(' ');
      expect(next).toContain('write the change file under docs/specs/changes/');
      expect(next).not.toContain('requirements/changes/');
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('transitions', () => {
  // In words any agent can follow: how a plan is presented is the agent
  // adapter's to say.
  it('points at presenting a plan for the operator to approve while the workflow is open', () => {
    expect(transitions('open').join(' ')).toMatch(/present it to the operator for approval/);
  });

  it('ends at the merge, which the machine does not model', () => {
    expect(transitions('recorded').join(' ')).toMatch(/operator/);
  });
});

describe('a record held for a second word', () => {
  const verified = [...granted, ev('verified', { treeFingerprint: 'T' })];

  it('is found for the tree it was held on, and no other', () => {
    const entries = [...verified, ev('record_held', { treeFingerprint: 'T' })];
    expect(heldFor(epoch(entries), measurement('T'))).not.toBeNull();
    expect(heldFor(epoch(entries), measurement('OTHER'))).toBeNull();
  });

  it('moves no phase', () => {
    expect(state([...verified, ev('record_held', { treeFingerprint: 'T' })]).phase).toBe('verified');
  });

  it('belongs to the plan in force', () => {
    const entries = [...verified, ev('record_held', { treeFingerprint: 'T' }), ev('plan_approved'), ev('triaged', { treeFingerprint: 'T' }), ev('verified', { treeFingerprint: 'T' })];
    expect(heldFor(epoch(entries), measurement('T'))).toBeNull();
  });
});

describe('the latest successful verify', () => {
  it('uses the latest pass across failures and cannot revive an older tree', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'A' }), ev('verify_failed', { treeFingerprint: 'bad' }), ev('verified', { treeFingerprint: 'B' })];
    expect(latestVerified(epoch(entries))?.payload.treeFingerprint).toBe('B');
    expect(receiptFor(entries, measurement('A'))).toBeNull();
    expect(state(entries, { treeFingerprint: 'A' }).phase).toBe('converging');
  });

  it('starts again with a revised plan, and is null before any pass', () => {
    const entries = [...granted, ev('verified', { treeFingerprint: 'A' }), ev('plan_approved'), ev('triaged', { treeFingerprint: 'A' })];
    expect(latestVerified(epoch(entries))).toBeNull();
    expect(latestVerified(epoch([...entries, ev('verified', { treeFingerprint: 'C' })]))?.payload.treeFingerprint).toBe('C');
  });
});

/**
 * The one reader of a triage's counts. A part the event lacks reads as
 * nothing, so an old event, or none, never prints `undefined`.
 */
/** The lines every place that shows a triage prints, so they cannot differ. */
describe('the triage, said', () => {

  it('says what the level measures in the operator\'s words', () => {
    expect(RISK_MEANS).toBe("I assessed the plan's missed predictions and test regressions.");
  });

  it('names the surprises, then the over-predictions, then the files that never ran, each once', () => {
    expect(triageNames(counts({
      surprise: { failed: 1, total: 9, failures: ['s.test.ts — broke'] },
      overPredicted: { count: 1, total: 2, tests: ['o.test.ts — passed'] },
      notRun: { predicted: ['p.test.ts'], unpredicted: ['u.test.ts'] },
    }))).toEqual([
      'surprises — the plan did not predict these:', '  s.test.ts — broke',
      'over-predicted — the plan said these would fail, and they passed:', '  o.test.ts — passed',
      'never ran, and the plan did not predict it — nothing in these was classified:', '  u.test.ts',
      'predicted, and never ran:', '  p.test.ts',
    ]);
  });

  it('names nothing when the plan missed nothing', () => {
    expect(triageNames({ surprise: { failures: [] }, overPredicted: { tests: [] }, notRun: { predicted: [], unpredicted: [] } })).toEqual([]);
  });

  it('counts on one line, the shares against the prediction', () => {
    expect(triageCountLine(counts({
      predicted: { failed: 45, total: 45 },
      surprise: { failed: 2, total: 2423 },
      overPredicted: { count: 0, total: 45, tests: [] },
    }))).toBe('2468 tests ran, 47 failed · predicted 45/45 failed · 2 surprises (4%) · 0 over-predictions (0%)');
    expect(triageCountLine(counts({ surprise: { failed: 1, total: 1 } }))).toBe('1 test ran, 1 failed · predicted 0/0 failed · 1 surprise (0%) · 0 over-predictions (0%)');
  });
});

describe('test edits since verification', () => {
  const success = (treeFingerprint, testFingerprint, implementationFingerprint = 'code') =>
    ev('verified', { treeFingerprint, testFingerprint, implementationFingerprint });

  it('compares the last two successful verifies even when the first pass matches the current tests', () => {
    const latest = success('A', 'original');
    const history = [...granted, success('A', 'original'), success('B', 'added'), ev('verify_failed', { treeFingerprint: 'bad' }), latest];
    expect(testsChangedSinceVerify(history, latest)).toBe(true);
    const repeat = success('A', 'original');
    expect(testsChangedSinceVerify([...history, repeat], repeat)).toBe(false);
    expect(heldFor([...granted, latest, ev('record_held', { treeFingerprint: 'A' }), repeat], measurement('A'))).toBeNull();
  });

  it.each([
    ['first pass', []],
    ['new approval', [success('A', 'old'), ev('plan_approved')]],
    ['different implementation', [success('A', 'old', 'other code')]],
  ])('requires evidence of changed tests for the same implementation: %s', (_, past) => {
    const latest = success('B', 'new');
    expect(testsChangedSinceVerify([...granted, ...past, latest], latest)).toBe(false);
  });

  it('requires both split fingerprints even when the tree digest matches', () => {
    const pass = success('A', 'tests');
    const history = [...granted, pass];
    const hashes = { implementationFingerprint: 'code', testFingerprint: 'tests' };
    expect(receiptFor(history, measurement('A', hashes))).toBe(pass);
    expect(receiptFor(history, measurement('A', { ...hashes, testFingerprint: 'other' }))).toBeNull();
    expect(receiptFor(history, measurement('A', { ...hashes, implementationFingerprint: 'other' }))).toBeNull();
  });
});

describe('a measurement running across workflow transitions', () => {
  const before = { branch: 'topic', grant: { seq: 1 }, triage: { seq: 2 }, ...verificationInputs,
    treeFingerprint: 'tree', implementationFingerprint: 'code', testFingerprint: 'tests' };
  it.each([
    { broken: 'broken' }, { branch: 'elsewhere' }, { grant: { seq: 5 } }, { triage: { seq: 9 } },
    { rulebookFingerprint: 'changed' }, { baseline: 'merged' }, { treeFingerprint: 'edited' }, { implementationFingerprint: 'edited' }, { testFingerprint: 'edited' },
  ])('rejects a measurement after a change to %j', difference => {
    expect(sameMeasurement(before, { ...before, ...difference })).toBe(false);
  });
});

describe('what the latest receipt authorizes', () => {
  const verified = ev('verified', { treeFingerprint: 'T', testFingerprint: 'tests', implementationFingerprint: 'code' });
  const triaged = [ev('plan_approved'), ev('triaged', { implementationFingerprint: 'code' })];
  const fold = (entries, changes = {}) => phaseOf({ entries, ...verificationInputs, treeFingerprint: 'T', testFingerprint: 'tests',
    implementationFingerprint: 'code', changeFiles: [], ...changes });

  it('identifies matching bytes, edited tests and a missing receipt separately', () => {
    const passes = [...triaged, verified];
    expect(fold(passes).phase).toBe('verified');
    expect(fold(passes, { treeFingerprint: 'U', testFingerprint: 'new tests' })).toMatchObject({
      phase: 'converging', why: expect.stringContaining('Verify the edited tests'),
    });
    expect(fold(triaged)).toMatchObject({ phase: 'converging', why: 'the working tree has no passing verification' });
    expect(fold(passes, { treeFingerprint: 'U' }).why).toBe('the working tree has no passing verification');
    expect(fold(passes, { implementationFingerprint: 'edit' })).toMatchObject({
      phase: 'converging', why: expect.stringContaining('Restore the triaged implementation or approve a revised plan'),
    });
  });

  it.each([
    ['baseline', 'e'.repeat(40), 'The baseline changed'],
    ['rulebookFingerprint', 'e'.repeat(64), 'The rulebook changed'],
  ])('drops the receipt and its decisions when only %s changes', (field, value, reason) => {
    const entries = [...triaged, verified, ev('record_held', { treeFingerprint: 'T' }),
      ev('declared', { treeFingerprint: 'T' }), ev('recorded', { treeFingerprint: 'T', changes: 'digest' })];
    const changed = { ...verified.payload, [field]: value };
    expect(fold(entries, changed)).toMatchObject({ phase: 'converging', why: expect.stringContaining(reason) });
    expect(receiptFor(entries, changed)).toBeNull();
    expect(heldFor(entries, changed)).toBeNull();
    expect(declarationFor(entries, changed)).toBeNull();
    expect(recordFor(entries, changed, 'digest')).toBeNull();
  });

  it('requires a hold or guard event for this tree after its receipt', async () => {
    vi.resetModules();
    const selectors = await import('./phase.mjs');
    const hold = ev('record_held', { treeFingerprint: 'T' });
    const record = ev('recorded', { treeFingerprint: 'T', changes: 'digest' });
    // Stored declarations may carry extra fields. Only a recorded event vouches for the change digest.
    const declaration = ev('declared', { treeFingerprint: 'T', changes: 'digest' });
    const live = [...triaged, hold, record, verified, declaration,
      ev('record_held', { treeFingerprint: 'older' }), ev('recorded', { treeFingerprint: 'older', changes: 'digest' })];
    expect(selectors.declarationFor(live, verified.payload)).toBe(declaration);
    expect(selectors.heldFor(live, verified.payload)).toBeNull();
    expect(selectors.recordFor(live, verified.payload, 'digest')).toBeNull();
    expect(selectors.heldFor([...live, hold], verified.payload)).toBe(hold);
    expect(selectors.recordFor([...live, record], verified.payload, 'digest')).toBe(record);
    expect(selectors.recordFor([...live, record], verified.payload, 'different')).toBeNull();
  });
});
