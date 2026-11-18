/**
 * A fingerprint of the working tree, used to decide whether a verification
 * receipt still describes the code that is actually there.
 *
 * Four things are excluded, each for its own reason.
 *
 * `.katatay/` has to be excluded. Writing the receipt would otherwise change
 * the fingerprint the receipt is about, and no receipt could ever match.
 *
 * The follow-ups file, `FOLLOW-UPS.md` unless the rulebook names another, is a
 * list of work parked for later, open to edit at any point. Noting something
 * down should not throw away a passing verification, and should not read as an
 * unapproved change.
 *
 * Plan files, the Markdown files directly in the rulebook's plans folder, when
 * that folder is inside the repository. They are written before the operator
 * approves, and during the change as it is revised, for the same reason as the
 * follow-ups. Only files directly in the folder: a subfolder of it is ordinary
 * work. The rulebook refuses a plans folder at the root (`checkGating`), which
 * would otherwise leave every root file out.
 *
 * Change files are written after the operator declares the change finished, and
 * a declaration is keyed to the tree it was made about. If writing the summary
 * moved the fingerprint, recording the change would void the declaration it
 * records. What a change file says is checked separately, by `changeDigest`
 * below and by `req:guard`, which the turn-end hook runs against it.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { target } from './target.mjs';
import { DEFAULT_FOLLOW_UPS, followUpsFile, plansDir, requirementsPrefix } from './rulebook.mjs';
import { STATE_ROOT, currentBranch, dirFor } from './chain.mjs';
import { gitLines, gitText } from './git.mjs';
import { STATE_FOLDER } from './folder.mjs';

const git = (args) => gitLines(args);

/**
 * Whether a file, from the repository root, is left out of the tree: the
 * logbook, the follow-ups file, or a plan file. See the head of this file.
 * Built once per question about many files, since it reads the rulebook.
 *
 * @param {string} [root]
 * @returns {(file: string) => boolean}
 */
export function leftOut(root = process.cwd()) {
  const followUps = followUpsFile(root);
  // Outside the repository the folder reads as `../…`, and the folder of a
  // file git lists never does, so a plans folder outside leaves nothing out.
  // At the root it would read as `''`, which no file's folder is either, and
  // the rulebook refuses it before this runs.
  const plans = relative(root, plansDir(root));
  return (file) => file.startsWith(`${STATE_FOLDER}/`)
    || file === followUps
    || (file.endsWith('.md') && dirname(file) === plans);
}

/**
 * The same, for a caller that has to answer when the rulebook cannot be read:
 * the logbook and the default follow-ups file. It leaves out less than the
 * rulebook might, so it can only name more files, never hide one.
 */
export function leftOutOrDefault(root = process.cwd()) {
  try {
    return leftOut(root);
  } catch {
    return (file) => file.startsWith(`${STATE_FOLDER}/`) || file === DEFAULT_FOLLOW_UPS;
  }
}

/** Git excludes ignored, untracked paths from the measured tree. */
export function ignoredByGit(file, root) {
  try {
    gitText(['check-ignore', '--quiet', '--', file], { cwd: root });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/** The folder change files live in: `changes/` under the rulebook's requirements folder. */
const changesFolder = () => `${requirementsPrefix()}changes/`;

/** A change file: a record under the requirements folder's `changes/`, but not
 *  the template. The template is tooling like any other file, and does move the
 *  fingerprint. */
export const isChangeFile = (f) => f.startsWith(changesFolder()) && !f.endsWith('TEMPLATE.md');

/**
 * One reading of git, taken once and passed down.
 *
 * `state:show` runs on every prompt, and what it cost was almost entirely the
 * starting of git processes rather than any work they did: measured here, `git
 * --version` costs 13.7ms and `git ls-files` over 143 files costs 16.2ms. So
 * the lever is the number of child processes, and the functions below used to
 * make ten between them for one answer.
 *
 * Four of those were `ls-files` asking overlapping questions, and two were `git
 * rev-parse` asking whether a ref exists. Both collapse into a single call, and
 * the result is handed to whoever needs it.
 *
 * The same reasoning took two more out on 2026-10-04. The branch name now comes
 * from the `rev-parse` that checks the refs, and the target is listed once for
 * both the change files and the state directory, where it used to be asked
 * twice. A `current()` makes six git calls on the ordinary path, down from
 * eight. Measured from node, each one costs 9–12ms to start, and running them
 * through one `sh -c` was no faster: the cost is starting git, not starting a
 * process from node.
 *
 * Passed rather than memoised, deliberately. A module-level cache would be
 * correct here only by accident: `user-prompt.mjs` calls `current()` twice with
 * an append to `.katatay/` in between, and that happens to be an ignored path.
 * A cache whose correctness rests on what a caller happens not to touch is a
 * trap for whoever writes the next caller. A parameter cannot go stale.
 *
 * Each function below takes the snapshot as an optional argument and falls back
 * to fetching only the part it needs, so calling one on its own — which the
 * tests do — still costs one process rather than the whole snapshot.
 */
export function gitSnapshot(t = target()) {
  const { refs, branch } = gitHead(t.ref);
  const dir = branch === null ? null : dirFor(branch);
  const listing = gitListing();
  const onTarget = refs.target ? targetListing(t.ref, [changesFolder(), ...(dir === null ? [] : [`${dir}/`])]) : [];
  return { listing, refs, ref: t.ref, branch, dir, onTarget };
}

/** What the target holds under the given directories, in one call. Each
 *  directory ends in a slash, so it names a directory and not a prefix. */
const targetListing = (ref, dirs) => git(['ls-tree', '-r', '--name-only', ref, '--', ...dirs]);

/** Every path git knows about: index entries and untracked files that are not
 *  ignored. One call where there were two, and its result serves every caller
 *  below that used to ask git again with a narrower pathspec. */
const gitListing = () => [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard']))];

const RESOLVED = /^[0-9a-f]{40}$/;

/**
 * Whether `HEAD` and the target's remote-tracking ref exist, in one call
 * instead of two.
 *
 * The exit status is not the answer, and using it would have been a quiet bug.
 * `git rev-parse HEAD main` exits 0 in a repository that has a *file* called
 * `main` and no branch of that name — it echoes the unresolved argument on
 * stdout and carries on. So the output is read instead: a resolved ref is forty
 * hex characters, and anything else is the argument coming back unchanged.
 * Reading stdout also covers the failing case, where git prints what it could
 * resolve and exits non-zero.
 *
 * Nothing is printed, as with every call through `git.mjs`. A repository whose
 * target has never been fetched is an ordinary state here — the fixtures are
 * built that way — and git says `fatal: ambiguous argument` about it every
 * time. The calls that asked this question were silent, and this one has to
 * stay silent, or every fixture run prints a fatal error about nothing being
 * wrong.
 */
function gitRefs(ref) {
  return parseRefs(revParse(['HEAD', ref]).lines);
}

const parseRefs = (lines) => ({ head: RESOLVED.test(lines[0] ?? ''), target: RESOLVED.test(lines[1] ?? '') });

/** `git rev-parse` read from stdout whatever it exits with. See `gitRefs`. */
function revParse(args) {
  try {
    const out = gitText(['rev-parse', ...args]);
    return { ok: true, lines: out.split('\n').filter(Boolean) };
  } catch (failure) {
    return { ok: false, lines: String(failure.stdout ?? '').split('\n').filter(Boolean) };
  }
}

/**
 * The refs and the branch name, in one call where both refs resolve.
 *
 * `--abbrev-ref` placed last applies only to the `HEAD` after it, so the first
 * two lines are still shas and the third is the branch, or `HEAD` when it is
 * detached. That is exactly what `currentBranch` prints.
 *
 * When either ref does not resolve, git stops at it, and what comes after is
 * missing or is the flag echoed back as if it were an argument. So the branch is
 * read from this call only when it exits 0, and asked separately otherwise. A
 * target that was never fetched costs the one extra call it always did. An
 * unborn `HEAD` has no branch to read, and `branch` is null then; `current()`
 * sees that `refs.head` did not resolve and reports phase `open` (see `UNBORN`
 * in `state.mjs`).
 */
function gitHead(ref) {
  const { ok, lines } = revParse(['HEAD', ref, '--abbrev-ref', 'HEAD']);
  const refs = parseRefs(lines);
  if (ok && lines.length === 3) return { refs, branch: lines[2] };
  let branch = null;
  try {
    branch = currentBranch();
  } catch {
    // No commit yet, so no branch name git will give. See above.
  }
  return { refs, branch };
}

/** The snapshot's ref, or the configured one for a caller that took none. */
const refOf = (snapshot) => snapshot?.ref ?? target().ref;
const refsOf = (snapshot) => snapshot?.refs ?? gitRefs(refOf(snapshot));

/** Tracked and untracked files, ignored ones and change files excluded. */
export function trackedFiles(snapshot) {
  const ignored = leftOut();
  return (snapshot?.listing ?? gitListing())
    .filter((f) => !ignored(f) && !isChangeFile(f))
    .sort();
}

/** One hash over the change files' paths and contents. A check made against
 *  them stops counting the moment any of them is edited. */
export function changeDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    let contents;
    try {
      contents = readFileSync(file);
    } catch {
      continue;
    }
    hash.update(file).update('\0').update(contents).update('\0');
  }
  return hash.digest('hex');
}

/** Hashes content, not mtime. A checkout, a stash round-trip or a rebuild must
 *  not invalidate a receipt that still describes the same code. */
export function fingerprints(snapshot, isFrozen) {
  const hash = createHash('sha256');
  const tests = createHash('sha256');
  const implementation = createHash('sha256');
  for (const file of trackedFiles(snapshot)) {
    let contents;
    try {
      if (!statSync(file).isFile()) continue;
      contents = readFileSync(file);
    } catch {
      continue; // raced with a delete; the next fingerprint will see it gone
    }
    hash.update(file).update('\0').update(contents).update('\0');
    if (isFrozen) {
      const part = isFrozen(file) ? tests : implementation;
      part.update(file).update('\0').update(contents).update('\0');
    }
  }
  return { treeFingerprint: hash.digest('hex'), ...(isFrozen ? {
    testFingerprint: tests.digest('hex'), implementationFingerprint: implementation.digest('hex'),
  } : {}) };
}

export const fingerprint = (snapshot) => fingerprints(snapshot, null).treeFingerprint;

/**
 * Whether the tree holds anything uncommitted that is part of the change.
 *
 * `--untracked-files=all` lists each new file on its own line. Without it git
 * folds a new folder into one line, `?? plans/`, and a plan file in a plans
 * folder nobody had committed read as an edit to the tree.
 */
export const isDirty = () => {
  const ignored = leftOut();
  return git(['status', '--porcelain', '--untracked-files=all']).some((line) => !ignored(line.slice(3)));
};

/**
 * Change files that are new on this branch. Derived from git rather than the
 * chain, because things can be claimed in the chain, and in git they have to be
 * true.
 */
export function newChangeFiles(snapshot) {
  if (!refsOf(snapshot).target) return [];
  // The snapshot's listing also holds this branch's logbook. That is harmless
  // here: the set is only asked about change files.
  const onMain = new Set(snapshot ? snapshot.onTarget : targetListing(refOf(snapshot), [changesFolder()]));
  // Filtered out of the listing that was already fetched, rather than asked of
  // git again with a pathspec. `isChangeFile` carries the same restriction the
  // pathspec did, so the set is identical for two fewer processes.
  return (snapshot?.listing ?? gitListing()).filter((f) => !onMain.has(f) && isChangeFile(f));
}

/**
 * Event files in this branch's logbook that the target already holds.
 *
 * A change ends by being merged, so its events arriving in `main` is what makes
 * them finished history. That is the one signal git can give without being told
 * anything: the event files in a working tree got there either from `main`, in
 * which case `main` has them, or from this branch's own commits, in which case
 * it does not. A rebase replays those commits and carries their event files
 * along, so the answer survives one, where anything keyed to a commit id would
 * not.
 *
 * Asked by name rather than by content. Whether a merged event's bytes were
 * altered afterwards is `alteredStateFiles`' question, and answering it here
 * too would put two answers in the repository for the same question.
 */
export function mergedEvents(dir, snapshot) {
  if (!refsOf(snapshot).target) return [];
  // The snapshot listed the current branch's logbook. Any other directory is asked
  // for on its own, so a caller naming a different logbook still gets its answer.
  if (snapshot && snapshot.dir === dir) return snapshot.onTarget.filter((f) => f.startsWith(`${dir}/`));
  return targetListing(refOf(snapshot), [`${dir}/`]);
}

/**
 * Every event file the target holds, across all the logbooks, in one call.
 *
 * `mergedEvents` asks about one logbook. A reader that walks every logbook would pay
 * one git process per directory that way, and there are dozens of them. Event
 * files are named by their logbook's directory, so one listing answers for all of
 * them.
 */
export function stateOnTarget(snapshot) {
  if (!refsOf(snapshot).target) return [];
  return targetListing(refOf(snapshot), [`${STATE_ROOT}/`]);
}

/**
 * Committed event files that the working tree no longer agrees with.
 *
 * This is the check that actually catches a rewritten logbook. The hash chain only
 * catches a lazy rewrite. `prev` links each file to the bytes of the one before
 * it, and the hash is not a secret, so anyone who edits event N can recompute
 * N+1 onwards and the chain will link up perfectly. The genesis event has no
 * predecessor at all, and can be rewritten with nothing to notice.
 *
 * Git is what anchors it. Once an event is committed, its bytes are held
 * somewhere the working tree cannot quietly restate, so a modified or deleted
 * event file shows up as a diff. That is also why these files are committed at
 * all rather than ignored.
 *
 * Uncommitted event files are not violations. Appending is how the logbook grows,
 * and the events from this turn have not been committed yet. `git diff HEAD`
 * reads the index as well as the working tree, so without `--diff-filter` a
 * newly appended event would become a violation the moment it was staged — that
 * is, on every ordinary `git add -A` before a commit. People learn to skip past
 * a check that cries wolf on the normal flow.
 *
 * The filter excludes additions rather than listing the failure modes it wants
 * to catch. Lowercase `a` means *not* added. Spelling it out as `DM` instead
 * would let a committed event be renamed out of the chain unnoticed, which
 * unlinks it just as thoroughly as deleting it. Enumerating what to catch means
 * being wrong about anything left off the list.
 *
 * It looks under `.katatay/state/`, where the events are, and not at all of
 * `.katatay/`. The folder also holds `rulebook.json`, which is a setting and
 * not an event: the operator edits it, to move the target, raise a coverage
 * minimum or acknowledge a hook. While this read the whole folder, such an
 * edit was reported as "an event was edited or removed" until it was
 * committed, and `workflow verify` failed on it. That went unseen while the
 * file held one key that never changed. It was found on 2026-10-12, the first
 * time the operator applied a patch to it in the middle of a change. An edit
 * to the config is still shown to review: it is a guardrail path, so it lists
 * under "Must look" (`areas.mjs`).
 */
export function alteredStateFiles(root = STATE_ROOT, snapshot) {
  // no commits yet: nothing is anchored, and nothing claims to be
  if (!refsOf(snapshot).head) return [];
  return git(['diff', '--name-only', '--diff-filter=a', 'HEAD', '--', root]);
}

/**
 * Whether this branch's logbook has been committed yet, and how much of it.
 *
 * This exists to stop the tools implying a safety they do not have. Once the
 * event files are committed, git holds their bytes and `alteredStateFiles`
 * catches an edit or a deletion. Before that first commit, nothing does. An
 * emptied logbook folder looks exactly like a logbook that was never started, and no
 * amount of reading the folder can tell them apart.
 *
 * So the tools say which of the two situations they are in, rather than
 * printing `0 events` and letting the reader assume the safe one.
 *
 * `committed` and `sha` are about this change's own events: the ones on `HEAD`
 * that the target does not hold. It used to ask whether any commit had ever
 * touched the folder. On a branch name used before, the last change's merged
 * events answered yes, so the report read "committed at 7a76931" while every
 * event of the change in hand was still untracked, and the warning that they
 * could be deleted without trace stayed silent in the one case it exists for.
 * Events the target holds are a finished change (see `mergedEvents`), and say
 * nothing about whether this one's are safe.
 *
 * `count` is every event file on `HEAD`, merged or not. The check that events
 * have gone missing compares it with the files in the folder, and a merged
 * event deleted from the folder is missing as much as any other.
 */
export function logbookIsCommitted(dir, snapshot) {
  if (!refsOf(snapshot).head) return { committed: false, sha: null, count: 0 };
  const onHead = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', dir]);
  const merged = new Set(mergedEvents(dir, snapshot));
  const own = onHead.filter((f) => !merged.has(f));
  const sha = own.length === 0 ? null : git(['log', '-1', '--format=%h', '--', ...own])[0] ?? null;
  return { committed: sha !== null, sha, count: onHead.length };
}
