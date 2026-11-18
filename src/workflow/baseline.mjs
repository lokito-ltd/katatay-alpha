/**
 * The baseline: the commit on the target that a change is measured from.
 *
 * It is pinned in the logbook when the operator approves the plan, and it moves
 * only forward, when the target is merged into the branch. Everything that asks
 * "what did this change alter?" — the test freeze, the high-risk areas the
 * triage scores, the review areas — diffs against it.
 *
 * It is pinned rather than worked out from git on every read. A ref is
 * something a session can move: `git branch -f main HEAD` would otherwise
 * empty the freeze in one command. A sha written into the logbook by a hook cannot
 * be moved by anyone but the hooks.
 *
 * What the logbook cannot stop is a remote-tracking ref faked before the pin or
 * before a move. That is caught at the end instead: a change reaches `recorded`
 * only once every baseline in its logbook is proved to be on the server's target
 * (`provedOnServer`), and CI checks the same against a fresh fetch for any
 * baseline that has not yet been through that proof. Checking
 * the result catches every way the ref could have been moved. A list of
 * forbidden commands would always be one form behind.
 *
 * The network calls carry a timeout. A hook that waits on a hung remote holds
 * the whole session, and an unreachable server is an ordinary answer here: the
 * baseline falls back to the remote-tracking ref, or the gate says why it is
 * waiting.
 */
import { leftOutOrDefault } from './tree.mjs';
import { changedFiles } from './frozen.mjs';
import { gitText } from './git.mjs';
import { inCi } from './ci.mjs';

const NETWORK_TIMEOUT_MS = 15_000;

const git = (args, options) => gitText(args, options).trim();

/** Whether a git command succeeds. For the questions git answers by exit code. */
const holds = (args) => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

/** `GIT_TERMINAL_PROMPT=0` so a remote asking for credentials fails at once
 *  instead of waiting for someone to type them into a hook. */
const networked = (args) =>
  git(args, { timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/**
 * Brings the remote-tracking ref up to the server's target. The refspec is
 * spelled out rather than left to `remote.<name>.fetch`, so the ref this
 * updates is the one the setting names whatever the repository's config says.
 *
 * `--no-auto-maintenance`, because a fetch otherwise starts `git maintenance
 * run --auto` after it. A hook fetches on most turns, and housekeeping the
 * operator's repository is not its job: their own git commands still start it.
 * Measured on 2026-10-04, these fetches started 80 of the 162 maintenance
 * runs in the machine suite.
 *
 * @returns {boolean} whether the server answered
 */
export function fetchTarget({ remote, branch, ref }) {
  try {
    networked(['fetch', '--quiet', '--no-tags', '--no-auto-maintenance', remote, `+refs/heads/${branch}:${ref}`]);
    return true;
  } catch {
    return false;
  }
}

export const isAncestor = (older, newer) => holds(['merge-base', '--is-ancestor', older, newer]);

const mergeBase = (a, b) => {
  try {
    return git(['merge-base', a, b]);
  } catch {
    return null;
  }
};

/**
 * The baseline for a plan being approved now: where `HEAD` meets the target.
 *
 * The server is asked first. When it answers, the remote-tracking ref is the
 * server's target and the source is `server`. When it does not, the ref is used
 * as it stands and the source is `fallback`. Either way `provedOnServer` checks
 * it again before the change can be recorded.
 *
 * @returns {{ sha: string, source: 'server'|'fallback' } | null} null when the
 *   target has never been fetched and the server cannot be reached, so there is
 *   nothing to measure from.
 */
export function pinBaseline(t) {
  const fetched = fetchTarget(t);
  const sha = mergeBase('HEAD', t.ref);
  return sha ? { sha, source: fetched ? 'server' : 'fallback' } : null;
}

/**
 * Where the baseline should move to, if the target has been merged into the
 * branch since it was pinned. `null` when it should stay.
 *
 * Asked every turn, so the first check costs no network: the merge-base of
 * `HEAD` and the remote-tracking ref as it stands. Only when that has moved is
 * the server asked, and the merge-base taken again against what it says.
 *
 * Forward only. A merge-base that does not descend from the current baseline
 * would measure the change from somewhere before where it started, and would
 * count work already on the target as this change's.
 *
 * @param {string} current the baseline sha in force
 * @returns {{ to: string, source: 'server'|'fallback' } | null}
 */
export function nextBaseline(t, current) {
  const local = mergeBase('HEAD', t.ref);
  if (!local || local === current) return null;
  const fetched = fetchTarget(t);
  const to = fetched ? mergeBase('HEAD', t.ref) : local;
  if (!to || to === current || !isAncestor(current, to)) return null;
  return { to, source: fetched ? 'server' : 'fallback' };
}

/**
 * Whether every baseline is on the server's target. The condition for
 * `recorded`.
 *
 * The tip comes from `ls-remote`, which asks the server directly. It cannot be
 * answered from a local ref, and that is the point: a remote-tracking ref is a
 * file a session can rewrite, and the server's protected branch is not. The tip
 * object is fetched if this repository does not have it yet, because ancestry
 * can only be checked against a commit git holds.
 *
 * @param {string[]} shas every baseline the live epoch records
 * @returns {{ ok: true, tip: string } | { ok: false, reason: 'unreachable' } | { ok: false, reason: 'not-on-target', tip: string, shas: string[] }}
 */
export function provedOnServer(t, shas) {
  let tip;
  try {
    tip = networked(['ls-remote', t.remote, `refs/heads/${t.branch}`]).split(/\s+/)[0];
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!tip) return { ok: false, reason: 'unreachable' };
  if (!holds(['cat-file', '-e', `${tip}^{commit}`]) && !fetchTarget(t)) return { ok: false, reason: 'unreachable' };
  const unproved = shas.filter((sha) => !isAncestor(sha, tip));
  return unproved.length === 0 ? { ok: true, tip } : { ok: false, reason: 'not-on-target', tip, shas: unproved };
}

/**
 * Files the working tree already changes against the target when a change
 * starts.
 *
 * A change is one branch. Work already there when its first plan is approved
 * came from somewhere else: another branch it was cut from, or edits made
 * before anyone approved anything. The freeze will count that work as this
 * change's, which is correct, and the operator is told so at approval rather
 * than finding out when the triage refuses. The workflow's own bookkeeping is
 * left out, because it changes on every branch.
 *
 * It reads the working tree, through `changedFiles`, and not `HEAD`. It used
 * to run `git diff <baseline> HEAD`, which compares two commits. An edit still
 * sitting in the working tree, or a file git had not been told about, is in no
 * commit, so it rode into the change without being named. That is the usual
 * shape of an edit made through the shell before approval, and when the edit
 * and the approval fall in one turn no turn-end hook runs between them to warn
 * about the dirty tree either. `changedFiles` is what the freeze and the
 * triage measure with, so the approval now names the same files they will
 * count.
 *
 * A listing that fails answers nothing. The approval is in the logbook by the time
 * this is asked, and a hook that threw here would tell the operator the
 * approval had not been recorded.
 */
export function unmergedWork(baselineSha) {
  if (!baselineSha) return [];
  const ignored = leftOutOrDefault();
  try {
    return changedFiles(baselineSha).filter((f) => !ignored(f));
  } catch {
    return [];
  }
}

/**
 * In CI, brings the target's remote-tracking ref up to the server before a
 * check compares against it, and fails if it cannot. Outside CI it does
 * nothing: a local check must work offline, and the ref as last fetched is
 * what the rest of the local tools use.
 *
 * Done inside the checks rather than as a step of its own in the pipeline,
 * because the same checks run locally in `workflow verify`, and a fetch there
 * would make local verification fail whenever the network does. CI systems set
 * `CI` on every job, and only `CI=true` counts (`ci.mjs`).
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function fetchTargetInCi(t, env = process.env) {
  if (!inCi(env)) return;
  if (!fetchTarget(t)) throw new Error(`could not fetch ${t.name} from the server, so nothing here can be compared against it`);
}
