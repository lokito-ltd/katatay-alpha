/**
 * Where a change currently stands, folded from the event chain and from git.
 *
 * Git wins wherever both could answer. The chain adds evidence for the things
 * git cannot know, and nothing else: that a plan was approved, that the triage
 * ran, that verification passed on a particular tree, that the operator
 * declared the change finished, that the change file passed the guard, and that
 * the operator reset the epoch. So a tampered chain can fail to vouch for
 * progress, but it can never grant progress that git contradicts.
 *
 * Where an epoch ends is now one of the things git answers. A `reset` ends one
 * and the chain records it, but so does merging, and the chain is never told
 * about that. See `epoch` below.
 */
/** @typedef {'open'|'implementing'|'converging'|'verified'|'declared'|'recorded'} Phase */
/**
 * One event already checked by the logbook reader. Its evidence is defined
 * per event type in `event-format.mjs`.
 *
 * @typedef {{ seq: number, prev: string|null, ts: string, event: string, payload: Record<string, any> }} Event
 */

import { command } from './commands.mjs';
import { requirementsPrefix } from './rulebook.mjs';

export const PHASES = ['open', 'implementing', 'converging', 'verified', 'declared', 'recorded'];

/**
 * The change epoch: the live part of the logbook, the events that still say
 * something about where this change stands. A change epoch runs from the
 * baseline its approval pins to its last valid `recorded` event. Everything
 * before the boundary stays on disk and stays readable. It simply grants
 * nothing. A `reset` abandons the change epoch's change files too; see
 * `abandonedChangeFiles` in `state.mjs`.
 *
 * Two things end an epoch, and the boundary is whichever comes later.
 *
 * A `reset` ends one by being appended, never by deleting anything, so the logbook
 * stays whole.
 *
 * Merging ends one too, and `merged` — the count of events this branch's logbook
 * has already landed in `main` — is how that arrives here. A change finishes by
 * being merged, so the events it left behind describe something that is over.
 * Without this, a branch name used a second time inherits its predecessor's logbook
 * from `main` and folds to `converging`: a plan nobody approved for this change,
 * and a test freeze already lifted. Nothing can tell that case apart from work
 * continuing on a branch after its merge, because from git they are the same
 * situation — every event in `main`, nothing live — so both are read as a
 * finished change and both start over.
 *
 * The boundary is taken from the *last* merged event rather than a count of
 * leading ones. Merged events should always be a prefix, and if they somehow
 * are not, a prefix count would leave a merged grant on the live side.
 */
export function epoch(entries, merged = 0) {
  const afterReset = entries.map((e) => e.event).lastIndexOf('reset') + 1;
  return entries.slice(Math.max(afterReset, merged));
}

/**
 * The approved plan this change is working under. Always the latest one: a plan
 * revised and approved again mid-change replaces the one before it.
 *
 * An approval after a `recorded` event grants nothing. A branch holds one
 * change until it merges, and once that change is recorded, a new plan is a
 * second change. `post-tool.mjs` refuses to record one, and this is the same
 * rule read from the logbook, so a logbook written by older code cannot grant one
 * either. Fixing the recorded change under its own plan still works: an edit
 * after `recorded` goes back to `converging` without any new approval.
 *
 * This and the readers below take an epoch that has already been sliced, rather
 * than slicing one each. The boundary comes from git as well as from the logbook,
 * and five functions working it out separately would be five places for it to
 * be worked out differently.
 */
export function grant(live) {
  const closed = live.findIndex((e) => e.event === 'recorded');
  return (closed === -1 ? live : live.slice(0, closed)).findLast((e) => e.event === 'plan_approved') ?? null;
}

/**
 * The events that came after the plan in force. Everything the phase is folded
 * from past the grant is read from here, because an event from before the
 * latest approval describes work under a plan that has since been replaced.
 */
const sinceGrant = (live) => {
  const held = grant(live);
  return held ? live.slice(live.indexOf(held) + 1) : [];
};

/** Only a request for the live approval can defer work. A resume names the
 * specific request so that an older decision cannot close a later request. */
export function pendingReplan(live, approval) {
  if (!approval) return null;
  const request = live.findLast(e => e.event === 'replan_requested' && e.payload.approval === approval.seq && e.seq > approval.seq);
  if (!request || live.some(e => e.event === 'replan_resumed' && e.payload.request === request.seq && e.seq > request.seq)) return null;
  return request;
}

export const REPLAN_PENDING = 'A plan revision is pending. Present the revision for approval. If the operator chooses the original plan, run `'
  + command('replan') + ' --resume`.';

export const RECORDED_PLAN_GUIDANCE = 'Merge it first and start the next change after the merge, or have the operator type `reset`.';

/** A receipt counts only for the exact tree it was written about. Any edit
 *  changes the fingerprint, so no receipt outlives the code it describes. */
export function latestVerified(live) {
  const measurement = sinceGrant(live).findLast(e => e.event === 'verified' || e.event === 'triaged');
  return measurement?.event === 'verified' ? measurement : null;
}

/** Once-per-plan evidence may cross trees under the same rules and baseline. */
export function sameVerificationInputs(producer, consumer) {
  const baseline = readBaseline(producer.baseline);
  return Boolean(producer.rulebookFingerprint && baseline
    && producer.rulebookFingerprint === consumer.rulebookFingerprint && baseline === consumer.baseline);
}

export function receiptFor(live, measurement) {
  const receipt = latestVerified(live);
  if (!receipt || !sameVerificationInputs(receipt.payload, measurement)) return null;
  const { treeFingerprint, implementationFingerprint, testFingerprint } = receipt.payload;
  return treeFingerprint === measurement.treeFingerprint && implementationFingerprint === measurement.implementationFingerprint
    && testFingerprint === measurement.testFingerprint ? receipt : null;
}

// Holds and declarations belong to the pass they followed, even when a later
// pass returns to bytes that were verified and declared before.
const afterReceipt = (live, measurement) => {
  const receipt = receiptFor(live, measurement);
  return receipt ? live.slice(live.indexOf(receipt) + 1) : [];
};

/**
 * The triage of the plan in force.
 *
 * A verification receipt names the bytes it was issued for, because "the tests
 * passed" is only ever true of an exact tree. A triage records that something
 * happened: the suite ran, and its failures were classified while the tests
 * still matched the baseline. Editing afterwards is the whole point of the
 * phase that follows it, so the next keystroke does not invalidate a triage.
 *
 * It belongs to the plan it follows. A triage from before the latest approval
 * classified an implementation of a different plan, and the work the new plan
 * adds has never been triaged. So a revised plan sends the change back to
 * `implementing`, and the tests are frozen again until it is triaged again.
 * Reading the first triage in the epoch instead was how a second plan on a
 * branch went straight to `converging` without one.
 */
export const triageIn = (live) => sinceGrant(live).findLast((e) => e.event === 'triaged') ?? null;

/**
 * What the triage's level measures, said before the level wherever a triage
 * is shown. A level with no stated meaning was read as a verdict on the whole
 * change, which it never was. The words are the operator's, from 2026-11-01.
 */
export const RISK_MEANS = "I assessed the plan's missed predictions and test regressions.";

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const share = (part, whole) => `${whole === 0 ? 0 : Math.round((part / whole) * 100)}%`;

/**
 * The tests a triage names, one label per file or test, unindented. Each
 * caller indents them to its own layout.
 *
 * The surprises come first, then the over-predictions: they are what the plan
 * missed, and they are what is worth reading. Predicted failures are counted
 * and never named, because the plan already named them. A file that never ran
 * is named once, on its own line, and never again among the failures.
 *
 * @param {{ surprise: { failures?: string[] }, overPredicted: { tests?: string[] }, notRun: { predicted: string[]|number, unpredicted: string[]|number } }} counts
 * @returns {string[]}
 */
export function triageNames({ surprise, overPredicted, notRun }) {
  if (typeof notRun.predicted === 'number') {
    return [`Files that never ran: ${notRun.predicted} predicted, ${notRun.unpredicted} unpredicted.`];
  }
  const lines = [];
  const group = (title, items) => {
    if (items.length === 0) return;
    lines.push(title, ...items.map((item) => `  ${item}`));
  };
  group('surprises — the plan did not predict these:', surprise.failures);
  group('over-predicted — the plan said these would fail, and they passed:', overPredicted.tests);
  group('never ran, and the plan did not predict it — nothing in these was classified:', notRun.unpredicted);
  group('predicted, and never ran:', notRun.predicted);
  return lines;
}

/**
 * The triage's counts on one line. Every test is in exactly one bucket, so
 * the two totals add up to the tests that ran.
 *
 * @param {{ predicted: { failed: number, total: number }, surprise: { failed: number, total: number }, overPredicted: { count: number, total: number } }} counts
 */
export function triageCountLine(counts) {
  return triageCounts(counts).join(' · ');
}

/**
 * The parts of the count line, for a layout that cannot keep them on one
 * line: joined, they run to about 90 columns.
 *
 * @param {Parameters<typeof triageCountLine>[0]} counts
 * @returns {string[]}
 */
export function triageCounts({ predicted, surprise, overPredicted }) {
  const ran = predicted.total + surprise.total;
  const failed = predicted.failed + surprise.failed;
  const p = overPredicted.total;
  return [
    `${plural(ran, 'test')} ran, ${failed} failed`,
    `predicted ${predicted.failed}/${p} failed`,
    `${plural(surprise.failed, 'surprise')} (${share(surprise.failed, p)})`,
    `${plural(overPredicted.count, 'over-prediction')} (${share(overPredicted.count, p)})`,
  ];
}

/**
 * The triage as the operator reads it, unindented: what the level measures,
 * the level, the counts, then the names. The counts come before the names so
 * the size of what follows is known before reading it.
 *
 * @param {Parameters<typeof triageNames>[0] & Parameters<typeof triageCountLine>[0] & { level: string }} counts
 * @returns {string[]}
 */
export function triageBlock(counts) {
  const names = triageNames(counts);
  return [
    RISK_MEANS,
    '',
    `risk: ${counts.level}`,
    '',
    triageCountLine(counts),
    ...(names.length > 0 ? ['', ...names] : []),
  ];
}


/** The commit a stored baseline names, or null when absent. Event validation
 * checks the commit's format; the reader never extracts an old object shape.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export const readBaseline = (value) => typeof value === 'string' ? value : null;

/**
 * The baseline in force: the sha this change is measured from.
 *
 * The latest of the two places one is written. The approval pins it, and a
 * merge of the target into the branch moves it forward. `null` before approval.
 */
export function baselineOf(live, through = Infinity) {
  for (const e of [...live].reverse()) {
    if (e.seq > through) continue;
    if (e.event === 'baseline_moved') return readBaseline(e.payload.to);
    if (e.event === 'plan_approved') return readBaseline(e.payload.baseline);
  }
  return null;
}

/**
 * Every baseline the live epoch records, in order. The recorded gate proves
 * each of them on the server rather than only the latest: a faked one that was
 * later moved past still shaped what the freeze and the triage saw.
 */
export const baselinesIn = (live) => [
  ...new Set(live.flatMap((e) => {
    if (e.event === 'baseline_moved') return [readBaseline(e.payload.to)];
    if (e.event === 'plan_approved') return [readBaseline(e.payload.baseline)];
    return [];
  })),
];

/**
 * The baselines a `recorded` event vouches for: those pinned before the last
 * one. The `Stop` hook writes `recorded` only after it has asked the server
 * whether every baseline in the logbook is on the target, so each of these was
 * proved there. A baseline moved after the last `recorded` was not.
 */
export const provedBaselines = (live) => {
  const last = live.findLastIndex((e) => e.event === 'recorded');
  return last === -1 ? [] : baselinesIn(live.slice(0, last));
};

/**
 * The operator's `record`, for this exact tree. It is keyed like a receipt,
 * because "I am happy with this" is a statement about the code in front of
 * them. After another edit it would be a statement about code they never saw.
 */
export const declarationFor = (live, measurement) =>
  afterReceipt(live, measurement).findLast((e) => e.event === 'declared' && e.payload.treeFingerprint === measurement.treeFingerprint) ?? null;

/**
 * The operator's first `record` on this tree, held because the change report
 * found gaps the agent did not act on (see `record.mjs`). A second `record` on
 * the same tree declares. Keyed to the tree like a declaration: after an edit
 * the operator is looking at different code, so the next `record` shows the
 * report and decides again.
 */
export const heldFor = (live, measurement) =>
  afterReceipt(live, measurement).findLast((e) => e.event === 'record_held' && e.payload.treeFingerprint === measurement.treeFingerprint) ?? null;

/** Compare successive successful passes under this approval. */
export function testsChangedSinceVerify(live, receipt) {
  const previous = latestVerified(live.slice(0, live.indexOf(receipt)))?.payload;
  const now = receipt.payload;
  return Boolean(previous
    && previous.implementationFingerprint === now.implementationFingerprint
    && previous.testFingerprint !== now.testFingerprint);
}

/** A long-running check may finish on another tree or under another approval. */
export function sameMeasurement(before, after) {
  return !after.broken && before.branch === after.branch && before.grant?.seq === after.grant?.seq
    && before.rulebookFingerprint === after.rulebookFingerprint && before.baseline === after.baseline
    && before.triage?.seq === after.triage?.seq
    && before.treeFingerprint === after.treeFingerprint && before.testFingerprint === after.testFingerprint
    && before.implementationFingerprint === after.implementationFingerprint;
}

export const RESTORE_IMPLEMENTATION = 'The implementation changed after triage. Restore the triaged implementation or approve a revised plan and triage it again.';

export function verificationMismatch(last, hashes) {
  if (!last) return null;
  if (hashes.implementationFingerprint !== last.implementationFingerprint) {
    return 'The implementation changed since the latest successful verification. Verify the current implementation before recording.';
  }
  if (hashes.testFingerprint !== last.testFingerprint) {
    return 'Tests changed since the latest successful verification. The implementation still matches. Verify the edited tests before recording.';
  }
  if (hashes.rulebookFingerprint !== last.rulebookFingerprint) {
    return 'The rulebook changed since the latest successful verification. Verify under the current rulebook.';
  }
  if (hashes.baseline !== readBaseline(last.baseline)) {
    return 'The baseline changed since the latest successful verification. Verify against the current baseline.';
  }
  return null;
}


/**
 * The turn-end hook's record that `req:guard` passed on these exact change
 * files, for this exact tree. Change files sit outside the tree fingerprint, so
 * the digest of their contents is what makes an edit to one count.
 */
export const recordFor = (live, measurement, digest) =>
  afterReceipt(live, measurement).findLast((e) => e.event === 'recorded' && e.payload.treeFingerprint === measurement.treeFingerprint && e.payload.changes === digest) ?? null;

/**
 * @param {{ entries: object[], treeFingerprint: string, implementationFingerprint?: string, testFingerprint?: string, rulebookFingerprint: string|null, baseline: string|null, changeFiles: string[], changeDigest?: string, merged?: number }} input
 *   `merged` is how many of `entries` the target already holds. See `epoch`.
 * @returns {{ phase: Phase, grant: Event|null, triage: Event|null, declaration: Event|null, why: string, drift?: boolean }}
 */
export function phaseOf(input) {
  const { entries, implementationFingerprint, changeFiles, changeDigest = '', merged = 0 } = input;
  const live = epoch(entries, merged);
  const held = grant(live);

  if (!held) {
    // Said differently when the logbook is not empty but all of it is merged, so a
    // folder full of events reporting `open` reads as the answer rather than as
    // something having gone wrong.
    const why = entries.length > 0 && merged === entries.length
      ? 'this branch name\'s last change was merged, so work here is a new change and needs a new plan'
      : 'no plan has been approved';
    return { phase: 'open', grant: null, triage: null, declaration: null, why };
  }
  const triage = triageIn(live);
  if (!triage) {
    return {
      phase: 'implementing',
      grant: held,
      triage: null,
      declaration: null,
      // Said differently after a revision, because the tests written under the
      // old plan now differ from the baseline and have to be reverted, and an
      // agent told only "nothing has been triaged" would not know why.
      why: live.slice(0, live.indexOf(held)).some((e) => e.event === 'triaged')
        ? 'the plan was approved again after the last triage, so this plan has not been triaged: the tests are frozen again, and tests written since the baseline must be reverted before `' + command('triage') + '`'
        : 'nothing has been triaged, so the tests are frozen and only the implementation may change',
    };
  }
  if (implementationFingerprint !== triage.payload.implementationFingerprint) {
    return { phase: 'converging', grant: held, triage, declaration: null, drift: true, why: RESTORE_IMPLEMENTATION };
  }
  if (!receiptFor(live, input)) {
    const why = verificationMismatch(latestVerified(live)?.payload, input);
    return { phase: 'converging', grant: held, triage, declaration: null, why: why ?? 'the working tree has no passing verification' };
  }
  // A change file written before the operator's word does not skip it. The
  // agent writes that file, and it does not get to declare its own work done.
  const declaration = declarationFor(live, input);
  if (!declaration) {
    return { phase: 'verified', grant: held, triage, declaration: null, why: 'verified, and waiting for the operator to declare it finished' };
  }
  // Git wins: a `recorded` event cannot stand in for a change file git does not have.
  if (changeFiles.length === 0) {
    return { phase: 'declared', grant: held, triage, declaration, why: 'the operator declared it finished, and no change file records it yet' };
  }
  if (!recordFor(live, input, changeDigest)) {
    return { phase: 'declared', grant: held, triage, declaration, why: 'the change file has not passed req:guard as it now stands' };
  }
  return { phase: 'recorded', grant: held, triage, declaration, why: `recorded by ${changeFiles.join(', ')}` };
}

/** What can happen from here. Shown to the agent every turn, so knowing where
 *  it is never depends on it having remembered.
 *  `changeFiles` matters only in `declared`, where a change file may already
 *  exist — usually when coming back from `recorded` to fix something. */
export function transitions(phase, { changeFiles = [], drift = false } = {}) {
  switch (phase) {
    case 'open':
      return ['write the plan and present it to the operator for approval; their approval is recorded when they give it'];
    case 'implementing':
      return [
        'the implementation may change and the tests are frozen; run `' + command('triage') + '` once the implementation is complete',
      ];
    case 'converging':
      return [drift ? RESTORE_IMPLEMENTATION : 'write the tests the triage showed missing. Verification runs when the turn ends'];
    case 'verified':
      return ['tell the operator the change is verified; they type `record` when they are happy for it to be finished. If the first `record` holds, typing `record` again on the same tree declares the change'];
    case 'declared':
      return changeFiles.length === 0
        // The folder is the rulebook's, read only here, so no other phase
        // depends on reading the rulebook.
        ? [`write the change file under ${requirementsPrefix()}changes/ — see TEMPLATE.md. req:guard runs on it when the turn ends`]
        : ['req:guard runs on the change file when the turn ends; update it if this work changed what it should say, and fix it if the guard fails'];
    case 'recorded':
      return ['operator reviews, merges and pushes — the machine ends here'];
    default:
      return [];
  }
}
