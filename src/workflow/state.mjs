/** Assembles the chain, the tree and git into one answer. The hooks and the
 *  CLIs all go through here, so they cannot disagree about where a change is. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT, append, currentBranch, dirFor, fileFor, readChain, sha256 } from './chain.mjs';
import { alteredStateFiles, changeDigest, fingerprints, gitSnapshot, logbookIsCommitted, mergedEvents, newChangeFiles, stateOnTarget } from './tree.mjs';
import { baselineOf, baselinesIn, epoch, grant, pendingReplan, phaseOf, REPLAN_PENDING, transitions } from './phase.mjs';
import { frozenFileMatcher } from './adapter.mjs';
import { approvedPlans, readSnapshot } from './local-snapshot.mjs';
import { rulebookFingerprint } from './rulebook.mjs';
import { target } from './target.mjs';
import { nextBaseline } from './baseline.mjs';
import { gitText } from './git.mjs';

/**
 * How many of these events `main` already holds, as an index into `entries`.
 *
 * Counted to the *last* merged event rather than the first unmerged one. See
 * `epoch` in `phase.mjs` for why the difference matters.
 */
export function mergedCount(entries, dir, snapshot) {
  return mergedBoundary(entries, dir, new Set(mergedEvents(dir, snapshot)));
}

/** `mergedCount` for a caller that already holds the target's event files. */
export function mergedBoundary(entries, dir, onTarget) {
  let boundary = 0;
  entries.forEach((entry, index) => {
    if (onTarget.has(join(dir, fileFor(entry)))) boundary = index + 1;
  });
  return boundary;
}

const them = (files) => (files.length === 1 ? 'it' : 'them');

/**
 * One logbook, read and checked. This is the one definition of a broken
 * logbook: `current()`, `carriedGrants` and `workflow state verify` all read
 * through it, so none of them can call a logbook sound that another calls
 * broken. There used to be two definitions. The hooks checked only the chain,
 * and `state:verify` also held committed events against git, so a hand-edited
 * committed event failed `state:verify` while the turn end wrote another
 * `recorded` event on top of it.
 *
 * Broken means any of:
 *
 * - the chain does not link up (`readChain` in `chain.mjs`);
 * - an event file git holds as committed differs in the working tree, or is
 *   gone (`altered`, from `alteredStateFiles` in `tree.mjs`). The chain cannot
 *   see a rewrite that recomputed every link after it; git can;
 * - a change file named by the latest `recorded` event of the change epoch is
 *   gone. That event vouched for those files, and without them it vouches for
 *   nothing. Without this check the phase fell back to `declared` and the
 *   turn end wrote another `recorded` event over the gap.
 *
 * Each reason ends with how to fix it. Only the last can be fixed by a
 * `reset`: it abandons the change epoch, so its `recorded` event no longer
 * counts. The other two are about events every later read still sees, so a
 * reset would fix nothing, and `resetRepairs` is false for them.
 *
 * `altered` is the caller's, so a caller reading every logbook asks git once
 * for all of them. `mergedOf` gives how many of the entries the target holds;
 * it needs the entries, so it is a function.
 */
export function readLogbook(dir, { branch = null, altered = [], mergedOf = () => 0 } = {}) {
  const { entries, broken } = readChain(dir, branch);
  if (broken) return { entries, live: [], merged: 0, broken: `${broken}. Restore the event files from git.`, resetRepairs: false };
  const changed = altered.filter((file) => file.startsWith(`${dir}/`));
  if (changed.length > 0) {
    return { entries, live: [], merged: 0, resetRepairs: false,
      broken: `${changed.join(', ')}: committed as history, but the working tree disagrees with ${them(changed)}. Restore ${them(changed)} from git.` };
  }
  const merged = mergedOf(entries);
  const live = epoch(entries, merged);
  const record = live.findLast((e) => e.event === 'recorded');
  const gone = record ? record.payload.files.filter((file) => !existsSync(file)) : [];
  if (gone.length > 0) {
    return { entries, live, merged, resetRepairs: true,
      broken: `${gone.join(', ')}: named by ${join(dir, fileFor(record))}, and gone, so that recorded event is no longer valid. `
        + `Restore ${them(gone)} from git, or the operator types \`reset\` to abandon this change epoch.` };
  }
  return { entries, live, merged, broken: null, resetRepairs: false };
}

/**
 * The change files a `reset` abandoned: every one it listed as new on the
 * branch when it was typed. A reset abandons the change epoch before it, and
 * its change files with it. They stay on the branch and can be committed, but
 * the phase, the digest and the `recorded` event leave them out, so deleting
 * one afterwards changes nothing.
 *
 * Read from the reset rather than from git, because a reset is usually not yet
 * committed when the next change starts, so git cannot say which change files
 * came before it. A hand-edited reset could list a live change file. That only
 * takes progress away: the phase stops counting the file, and a `recorded`
 * event needs at least one. `req:guard` still reads every change file from
 * git, and once the reset is committed `readLogbook` catches the edit.
 *
 * Only resets after the last merged event count. One the target holds belongs
 * to a change already delivered, and its files are on the target already.
 */
export function abandonedChangeFiles(entries, merged = 0) {
  return new Set(entries.slice(merged).filter((e) => e.event === 'reset').flatMap((e) => e.payload.changeFiles ?? []));
}

/**
 * The plan approvals of the other changes this branch carries.
 *
 * A branch that gathers several changes before they reach the target carries
 * each one's logbook with it. Each logbook holds the plan the operator approved for
 * that change, and the requirement changes it listed. Without these, the
 * guard read approvals only from the current branch's plan, so a batch branch
 * that carried an approved rewording could be neither verified nor committed
 * against the target, although the operator had approved the rewording word
 * for word.
 *
 * Each logbook is read the way `current()` reads the current branch's:
 *
 * - The grant is the one `grant` in `phase.mjs` picks: the latest plan
 *   approval, and none from after a `recorded`.
 * - Only the live epoch counts: after the last `reset`, and after the last
 *   event the target already holds. A change already in the target carries
 *   nothing in, because its result is in the target's catalogue already.
 * - A broken logbook grants nothing, broken as `readLogbook` defines it.
 *
 * The current branch's logbook is left out. Its grant is `current().grant`, which
 * may also stand in for a change file. These may not; see `evaluate` in
 * `src/requirements/guard.ts`.
 *
 * All of the target's event files are listed in one git call, rather than one
 * call per logbook.
 */
export function carriedGrants(snapshot = gitSnapshot(target())) {
  if (!existsSync(STATE_ROOT)) return [];
  const onTarget = new Set(stateOnTarget(snapshot));
  const altered = alteredStateFiles(STATE_ROOT, snapshot);
  return readdirSync(STATE_ROOT)
    .map((name) => join(STATE_ROOT, name))
    .filter((dir) => dir !== snapshot.dir)
    .flatMap((dir) => {
      const { live, broken } = readLogbook(dir, { altered, mergedOf: (entries) => mergedBoundary(entries, dir, onTarget) });
      if (broken) return [];
      const held = grant(live);
      return held ? [held] : [];
    });
}

const UNBORN = 'this branch has no commit yet, so there is nothing to measure a change from';

/**
 * The branch name on a repository with no commit yet.
 *
 * `HEAD` names a branch that does not exist until the first commit, so
 * `currentBranch` throws there: `rev-parse` has no commit to resolve.
 * `symbolic-ref` reads the name `HEAD` points at without resolving it.
 *
 * `current()` used to let that throw. The gate allowed whatever it could not
 * judge, so on a branch with no commit every edit went through with no plan
 * approved. A branch with no commit is phase `open`, for a stated reason: a
 * change is measured from a baseline, and with no commit there is none.
 */
const unbornBranch = () => gitText(['symbolic-ref', '--short', 'HEAD']).trim();

/**
 * Where the change stands, read in full every time.
 *
 * There used to be a cheaper mode that skipped the tree fingerprint. Without a
 * fingerprint no verification receipt can match, so that mode reported every
 * approved change as `implementing`, including ones that were really
 * `converging`, `verified` or `recorded`. Its callers only asked whether a plan
 * existed, so nothing went wrong, but the result still had a field called
 * `phase` holding a guess. The next caller to read it would have trusted it,
 * and no test would have noticed.
 *
 * It saved too little to keep. Measured, the fingerprint costs about 6ms over
 * this repository. The full read costs about 45ms more than the cheap one did,
 * and that is the git processes below, not the hashing. The gate in
 * `pre-tool.mjs` pays it on every tool call, which was judged worth an answer
 * that is never a guess.
 *
 * It takes no options, and refuses any, so a caller written for the old
 * `{ withTree: false }` fails loudly instead of getting an answer it did not
 * expect.
 */
export function current(...options) {
  if (options.length > 0) {
    throw new Error('current() takes no options. It always reads the tree, so every phase it reports is exact.');
  }
  // First, so that nothing below runs in a repository nobody configured. It
  // throws a `TargetError`, which every entry point turns into a refusal.
  const t = target();
  // One reading of git for the answers below, rather than one each. See
  // `gitSnapshot` in `tree.mjs` for why it is threaded instead of cached. It
  // reads the branch too.
  const snapshot = gitSnapshot(t);
  // No commit yet, so git gives no branch name the usual way. See
  // `unbornBranch`.
  const born = snapshot.refs.head;
  const branch = born ? snapshot.branch ?? currentBranch() : unbornBranch();
  const dir = dirFor(branch);
  // The logbook is not read on a branch with no commit. Whatever is in the folder,
  // nothing in it can grant anything there.
  const book = born
    ? readLogbook(dir, { branch, altered: alteredStateFiles(dir, snapshot), mergedOf: (read) => mergedCount(read, dir, snapshot) })
    : { entries: [], live: [], merged: 0, broken: null, resetRepairs: false };
  const { entries, broken, merged, resetRepairs } = book;
  // Every change file the branch adds, split by change epoch: the ones a
  // reset abandoned count for nothing here. See `abandonedChangeFiles`.
  const abandoned = abandonedChangeFiles(entries, merged);
  const branchFiles = newChangeFiles(snapshot);
  const changeFiles = branchFiles.filter((file) => !abandoned.has(file));
  const earlierChangeFiles = branchFiles.filter((file) => abandoned.has(file));
  const saved = logbookIsCommitted(dir, snapshot);
  const digest = changeDigest(changeFiles);
  const live = broken ? [] : book.live;
  const hashes = fingerprints(snapshot, grant(live) ? frozenFileMatcher() : null);
  const measurement = { ...hashes, rulebookFingerprint: rulebookFingerprint(), baseline: baselineOf(live) };
  const folded = phaseOf({ entries: broken ? [] : entries, ...measurement, changeFiles, changeDigest: digest, merged });
  // An empty logbook folds to `open`. Only the reason differs: "no plan has been
  // approved" would send the agent to plan mode, where the approval cannot be
  // recorded either, because there is no commit to pin a baseline to.
  const state = born ? folded : { ...folded, why: UNBORN };
  // Do not fold a phase from a broken chain: its events are exactly the ones
  // that cannot be trusted. Reporting `implementing` from a partial read would
  // describe the tampering as progress.
  const phase = broken ? 'broken' : state.phase;
  const replan = pendingReplan(live, state.grant);
  return {
    branch, dir, entries, broken, resetRepairs, ...measurement, saved, changeFiles, earlierChangeFiles, changeDigest: digest,
    // `live` is what callers outside this module should read an event out of.
    // Passing them `entries` would hand them the merged history too, and a
    // receipt found in there vouches for a change that is already over.
    merged, live, replan,
    // The sha this change is measured from, and every one it has been measured
    // from. No approval means no baseline.
    target: t, baselines: baselinesIn(live),
    ...state, phase, why: broken ?? state.why,
    next: broken
      ? (resetRepairs ? ['restore the change files from git, or ask the operator to type `reset`'] : ['stop and tell the operator'])
      : replan ? [REPLAN_PENDING] : transitions(state.phase, { changeFiles, drift: state.drift }),
  };
}

/**
 * What is worth saying about whether the logbook has been committed. Stays silent
 * in the ordinary cases: an empty logbook on a fresh branch needs no commentary,
 * and a committed logbook that matches is the expected state.
 *
 * The two warnings count different things. Missing events are counted over the
 * whole logbook, merged events included, because a committed event that is gone
 * from the folder is missing whichever change it belonged to. Uncommitted
 * events are counted over `live`, this change's own, because those are the
 * only ones git may not hold yet. Counting every entry there kept the warning
 * quiet on a branch name used before: see `logbookIsCommitted` in `tree.mjs`.
 */
export function savedWarnings({ entries, saved, live = entries }) {
  if (!saved) return [];
  if (entries.length < saved.count) {
    return [`${saved.count - entries.length} event(s) are committed but missing from the logbook. Stop and tell the operator.`];
  }
  if (!saved.committed && live.length > 0) {
    return [`this change has ${live.length} event(s) in the logbook and none are committed yet — deleting them now would leave no trace`];
  }
  return [];
}

/**
 * The snapshot is the approved plan, whichever agent handed over its bytes.
 * Repeat its location so a new or compacted session knows where to read it.
 * Local evidence does not travel with the logbook: report unavailable bytes
 * without changing the phase. Only rendering reads them; ordinary state reads
 * and structural logbook checks do not require a local snapshot.
 */
export function approvedPlanSummary({ branch, grant }, root = process.cwd()) {
  if (!grant) return null;
  const { planSnapshot, proposal } = grant.payload;
  try {
    const bytes = readSnapshot(branch, approvedPlans, planSnapshot, root);
    if (sha256(bytes) !== proposal) throw new Error('snapshot differs from the approved plan hash');
  } catch (error) {
    return `approved plan: ${planSnapshot} — unavailable locally (${error.message}). Restore the exact approved snapshot at the recorded path and retry.`;
  }
  return `approved plan: ${planSnapshot} — read the approved plan from this snapshot.`;
}

/**
 * The one-screen summary injected into the agent's context each turn.
 *
 * What the agent adapter's check found is not in it. Those warnings are
 * messages of their own in `on prompt` (`setupMessages` in `agent.mjs`), so an
 * adapter can show them to the operator apart from the state.
 */
export function summarise(s) {
  const lines = [`workflow: ${s.phase} on ${s.branch} — ${s.why}`];
  if (s.broken) lines.push(`STATE CHAIN BROKEN: ${s.broken}. Stop and tell the operator.`);
  for (const line of savedWarnings(s)) lines.push(line);
  const plan = approvedPlanSummary(s);
  if (plan) lines.push(plan);
  for (const n of s.next) lines.push(`next: ${n}`);
  return lines.join('\n');
}

/**
 * Moves the baseline forward if the target has been merged into the branch
 * since it was pinned, and records the move. Returns whether it moved.
 *
 * Called at the start of every turn and at its end, so the logbook catches up with
 * a sync on the same turn the operator made it. Without a plan in force there is no baseline to move.
 */
export function followTarget(state) {
  if (state.broken || !state.grant) return false;
  const next = nextBaseline(state.target, state.baseline);
  if (!next) return false;
  append(state.dir, 'baseline_moved', { from: state.baseline, to: next.to }, state.branch);
  return true;
}
