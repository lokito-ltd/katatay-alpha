import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alteredStateFiles, changeDigest, fingerprint, fingerprints, gitSnapshot, ignoredByGit, isChangeFile, isDirty, leftOut, leftOutOrDefault, logbookIsCommitted, mergedEvents, newChangeFiles, trackedFiles,
} from './tree.mjs';
import { frozenFileMatcher } from './adapter.mjs';
import { TARGET_REF, configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { gitCommandsDuring } from '../../tests/fixtures/workflow/trace.mjs';

let repo;
let cwd;

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const event = (name, body) => writeFileSync(join(repo, '.katatay/state/branch', name), body);

beforeEach(() => {
  cwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), 'workflow-git-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  configureTarget(repo);
  mkdirSync(join(repo, '.katatay/state/branch'), { recursive: true });
  event('0001__verified.json', '{"seq":1,"prev":null,"event":"verified"}\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'record');
  // Not part of any case's history: each case says for itself what the target
  // holds.
  git('rm', '--cached', '--quiet', '.katatay/rulebook.json');
  git('commit', '--quiet', '-m', 'config is untracked');
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('the tree fingerprint', () => {
  const write = (file, body) => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), body);
  };

  it('distinguishes path bytes, content bytes and the start of the next file', () => {
    const measure = () => fingerprints(gitSnapshot(), () => true).testFingerprint;
    write('a', 'bc');
    const first = measure();
    renameSync('a', 'ab');
    write('ab', 'c');
    expect(measure()).not.toBe(first);

    unlinkSync('ab');
    write('a', 'xb\0y');
    const combined = measure();
    write('a', 'x');
    write('b', 'y');
    expect(measure()).not.toBe(combined);
  });

  it('uses the requested repository for ignore rules and propagates fatal Git errors', () => {
    write('.gitignore', 'generated.txt\n');
    process.chdir(tmpdir());
    expect(ignoredByGit('generated.txt', repo)).toBe(true);
    expect(ignoredByGit('source.txt', repo)).toBe(false);
    expect(() => ignoredByGit('source.txt', tmpdir())).toThrow(/not a git repository/i);
  });

  it('measures content and paths separately for tests, test helpers and implementation', async () => {
    vi.resetModules();
    const fresh = await import('./tree.mjs');
    const measure = () => fingerprints(gitSnapshot(), frozenFileMatcher());
    const initial = measure();
    write('source.mjs', 'original');
    const implemented = measure();
    expect(implemented.treeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh.fingerprint()).toBe(implemented.treeFingerprint);
    expect(implemented.implementationFingerprint).not.toBe(initial.implementationFingerprint);
    expect(implemented.testFingerprint).toBe(initial.testFingerprint);
    for (const file of ['one.test.mjs', 'tests/helpers/fixture.mjs']) {
      write(file, 'first');
      const added = measure();
      expect(added.implementationFingerprint).toBe(implemented.implementationFingerprint);
      expect(added.testFingerprint).not.toBe(implemented.testFingerprint);
      write(file, 'second');
      const edited = measure();
      expect(edited.testFingerprint).not.toBe(added.testFingerprint);
      renameSync(file, 'renamed.test.mjs');
      expect(measure().testFingerprint).not.toBe(edited.testFingerprint);
      unlinkSync('renamed.test.mjs');
      expect(measure()).toEqual(implemented);
    }
    write('source.mjs', 'edited');
    const edited = measure();
    expect(edited.implementationFingerprint).not.toBe(implemented.implementationFingerprint);
    renameSync('source.mjs', 'renamed.mjs');
    expect(measure().implementationFingerprint).not.toBe(edited.implementationFingerprint);
    unlinkSync('renamed.mjs');
    write('FOLLOW-UPS.md', 'parked');
    write('requirements/changes/20260101T000000.000Z__x.md', 'recorded');
    event('bookkeeping', 'excluded');
    expect(measure()).toEqual(initial);
  });

  // The change file is written after the operator's `record`, which is keyed to
  // the fingerprint. If writing it moved the fingerprint, recording the change
  // would void the declaration it records.
  it('does not move when a change file is written or edited', () => {
    const before = fingerprint();
    write('requirements/changes/20260101T000000.000Z__x.md', '# X\n');
    expect(fingerprint()).toBe(before);
    write('requirements/changes/20260101T000000.000Z__x.md', '# X, reworded\n');
    expect(fingerprint()).toBe(before);
  });

  it('still moves when the change-file template is edited, because it is tooling', () => {
    const before = fingerprint();
    write('requirements/changes/TEMPLATE.md', '# Template\n');
    expect(fingerprint()).not.toBe(before);
  });

  it('digests change files by content, so an edit to one is visible', () => {
    const file = 'requirements/changes/20260101T000000.000Z__x.md';
    write(file, '# X\n');
    const first = changeDigest([file]);
    write(file, '# X, reworded\n');
    expect(changeDigest([file])).not.toBe(first);
    expect(isChangeFile(file)).toBe(true);
    expect(isChangeFile('requirements/changes/TEMPLATE.md')).toBe(false);
  });
});

describe('holding the logbook against git', () => {
  it('sees nothing wrong with a logbook that matches its commit', () => {
    expect(alteredStateFiles()).toEqual([]);
  });

  it('catches a rewritten genesis event, which the hash chain cannot', () => {
    event('0001__verified.json', '{"seq":1,"prev":null,"event":"verified","payload":{"treeFingerprint":"forged"}}\n');
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0001__verified.json']);
  });

  it('catches a deleted event', () => {
    unlinkSync(join(repo, '.katatay/state/branch/0001__verified.json'));
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0001__verified.json']);
  });

  it('accepts an event appended since the last commit', () => {
    event('0002__verified.json', '{"seq":2,"prev":"x","event":"verified"}\n');
    expect(alteredStateFiles()).toEqual([]);
  });

  // The config sits beside the logbook and is not part of it. The operator edits
  // it, and an edit not yet committed used to fail `state:verify` as a
  // rewritten event.
  it('does not take an edit to .katatay/rulebook.json for an altered event', () => {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('add', '-f', '.katatay/rulebook.json');
    git('commit', '--quiet', '-m', 'the config, committed');
    writeConfig(repo, { fields: { followUpsFile: 'LATER.md' } });
    expect(git('diff', '--name-only', 'HEAD')).toBe('.katatay/rulebook.json\n');
    expect(alteredStateFiles()).toEqual([]);
  });

  it('still catches an altered event when the config was edited as well', () => {
    writeConfig(repo, { fields: { followUpsFile: 'LATER.md' } });
    event('0001__verified.json', '{"seq":1,"prev":null,"event":"verified","payload":{"treeFingerprint":"forged"}}\n');
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0001__verified.json']);
  });
});

/**
 * Staging is not a violation, and it used to read as one.
 *
 * `git diff HEAD` compares against the index as well as the working tree. From
 * git's point of view every case here looks identical to the unstaged version
 * above, except that an appended event acquires a diff it did not have before.
 * Staging the whole tree before committing is the ordinary flow, so the false
 * alarm fired on almost every change.
 */
describe('holding the logbook against git, with the change staged', () => {
  const stage = () => git('add', '-A');

  it('does not flag an appended event merely because it is staged', () => {
    event('0002__verified.json', '{"seq":2,"prev":"x","event":"verified"}\n');
    stage();
    expect(alteredStateFiles()).toEqual([]);
  });

  it('catches a rewritten event that has been staged', () => {
    event('0001__verified.json', '{"seq":1,"prev":null,"event":"verified","payload":{"treeFingerprint":"forged"}}\n');
    stage();
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0001__verified.json']);
  });

  it('catches a deleted event that has been staged', () => {
    unlinkSync(join(repo, '.katatay/state/branch/0001__verified.json'));
    stage();
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0001__verified.json']);
  });

  // Renaming an event unlinks it from the chain exactly as deleting it does.
  // It is also the case a filter written as `DM` would wave through.
  it('catches a committed event renamed out of the chain', () => {
    git('mv', '.katatay/state/branch/0001__verified.json', '.katatay/state/branch/0009__verified.json');
    expect(alteredStateFiles()).toEqual(['.katatay/state/branch/0009__verified.json']);
  });
});

/**
 * One reading of git, shared by the callers that used to ask separately.
 *
 * `state:show` runs on every prompt, and its cost was almost all git process
 * startup: ten of them for one answer. These cases are the ones that would
 * catch the reduction having changed the answer rather than only the cost, so
 * each compares the snapshot path against the same call made on its own.
 */
describe('the git snapshot', () => {
  it('gives trackedFiles the same answer as fetching for itself', () => {
    writeFileSync(join(repo, 'source.txt'), 'untracked\n');
    expect(trackedFiles(gitSnapshot())).toEqual(trackedFiles());
    expect(trackedFiles()).toContain('source.txt');
  });

  it('gives fingerprint the same answer as fetching for itself', () => {
    expect(fingerprint(gitSnapshot())).toBe(fingerprint());
  });

  it('still excludes ignored paths and change files when given a snapshot', () => {
    mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(repo, 'requirements/changes/20260101T000000.000Z__x.md'), '# X\n');
    writeFileSync(join(repo, 'FOLLOW-UPS.md'), '# Follow-ups\n');
    const files = trackedFiles(gitSnapshot());
    expect(files).not.toContain('FOLLOW-UPS.md');
    expect(files.some((f) => f.startsWith('requirements/changes/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.katatay/'))).toBe(false);
  });

  // The rulebook names both, so a project that keeps them elsewhere still gets
  // a receipt that survives noting something down or revising a plan.
  it('leaves out the rulebook\'s follow-ups file and the plans directly in its plans folder', () => {
    writeConfig(repo, { fields: { plans: { dir: 'plans/' }, followUpsFile: 'docs/LATER.md' } });
    mkdirSync(join(repo, 'plans/drafts'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    for (const file of ['docs/LATER.md', 'FOLLOW-UPS.md', 'plans/a-plan.md', 'plans/drafts/old.md', 'plans/notes.txt']) {
      writeFileSync(join(repo, file), 'x\n');
    }
    const files = trackedFiles();
    expect(files).not.toContain('docs/LATER.md');
    expect(files).not.toContain('plans/a-plan.md');
    expect(files).toContain('FOLLOW-UPS.md');
    expect(files).toContain('plans/drafts/old.md');
    expect(files).toContain('plans/notes.txt');
  });

  it('does not count a plan or a follow-up as an edit to the tree', () => {
    writeConfig(repo, { fields: { plans: { dir: 'plans/' } } });
    git('add', '-A');
    git('commit', '--quiet', '-m', 'clean');
    mkdirSync(join(repo, 'plans'), { recursive: true });
    writeFileSync(join(repo, 'plans/a-plan.md'), '# Plan\n');
    writeFileSync(join(repo, 'FOLLOW-UPS.md'), '# Follow-ups\n');
    expect(isDirty()).toBe(false);
    writeFileSync(join(repo, 'source.txt'), 'work\n');
    expect(isDirty()).toBe(true);
  });

  it('leaves out nothing for a plans folder outside the repository', () => {
    const ignored = leftOut(repo);
    expect(ignored('a-plan.md')).toBe(false);
    expect(ignored('.katatay/state/x.json')).toBe(true);
    expect(ignored('FOLLOW-UPS.md')).toBe(true);
  });

  // It may name more files than the rulebook would, never fewer.
  it('falls back to the logbook and FOLLOW-UPS.md when the rulebook cannot be read', () => {
    writeConfig(repo, { fields: { plans: { dir: '.' } } });
    expect(() => leftOut(repo)).toThrow(/the repository root/);
    const ignored = leftOutOrDefault(repo);
    expect(ignored('FOLLOW-UPS.md')).toBe(true);
    expect(ignored('.katatay/state/x.json')).toBe(true);
    expect(ignored('CLAUDE.md')).toBe(false);
  });

  it('finds the same change files with a snapshot as without', () => {
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'feat');
    mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(repo, 'requirements/changes/20260101T000000.000Z__x.md'), '# X\n');
    expect(newChangeFiles(gitSnapshot())).toEqual(newChangeFiles());
    expect(newChangeFiles()).toEqual(['requirements/changes/20260101T000000.000Z__x.md']);
  });

  // The branch comes from the same `rev-parse` that checks the refs. Asked on
  // its own, it was one more process on every reading of the state.
  describe('the branch, read with the refs', () => {
    const revParses = (run) => gitCommandsDuring(run).filter((c) => c.startsWith('rev-parse'));

    it('names the branch and its logbook, in one call', () => {
      markTarget(repo);
      git('checkout', '--quiet', '-b', 'feat/y');
      let snapshot;
      expect(revParses(() => { snapshot = gitSnapshot(); })).toHaveLength(1);
      expect(snapshot.branch).toBe('feat/y');
      expect(snapshot.dir).toBe('.katatay/state/feat_y');
    });

    it('names HEAD when it is detached, as currentBranch does', () => {
      markTarget(repo);
      git('checkout', '--quiet', '--detach');
      expect(gitSnapshot().branch).toBe('HEAD');
    });

    // git stops at the ref it cannot resolve, so the branch is not in that
    // call's output and is asked for separately.
    it('still names the branch when the target has never been fetched', () => {
      git('checkout', '--quiet', '-b', 'feat/y');
      let snapshot;
      expect(revParses(() => { snapshot = gitSnapshot(); })).toHaveLength(2);
      expect(snapshot.refs.target).toBe(false);
      expect(snapshot.branch).toBe('feat/y');
    });

    it('still names the branch with a file called main in the tree', () => {
      writeFileSync(join(repo, 'main'), 'not a branch\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'a file called main');
      git('checkout', '--quiet', '-b', 'feat/y');
      expect(gitSnapshot().branch).toBe('feat/y');
    });

    // `current()` asks `currentBranch` itself then, which throws there as it
    // always has. The snapshot does not decide that for it.
    it('names no branch on a repository with no commit yet', () => {
      const empty = mkdtempSync(join(tmpdir(), 'workflow-git-empty-'));
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: empty });
        process.chdir(empty);
        const snapshot = gitSnapshot({ ref: TARGET_REF });
        expect(snapshot.branch).toBeNull();
        expect(snapshot.refs).toEqual({ head: false, target: false });
      } finally {
        process.chdir(repo);
        rmSync(empty, { recursive: true, force: true });
      }
    });

    // The fallback to `currentBranch` above is where
    // `fatal: ambiguous argument 'HEAD'` reached the top of every triage.
    it('says nothing on stderr on a repository with no commit yet', () => {
      const empty = mkdtempSync(join(tmpdir(), 'workflow-git-empty-'));
      const noise = [];
      const real = process.stderr.write;
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: empty });
        process.chdir(empty);
        process.stderr.write = function (chunk, ...rest) { noise.push(String(chunk)); return real.call(this, chunk, ...rest); };
        gitSnapshot({ ref: TARGET_REF });
      } finally {
        process.stderr.write = real;
        process.chdir(repo);
        rmSync(empty, { recursive: true, force: true });
      }
      expect(noise.join('')).toBe('');
    });
  });

  // The change files and this branch's logbook are both asked of the target. One
  // listing answers both, where it used to take one call each.
  describe('the target, listed once', () => {
    const dir = '.katatay/state/branch';
    const listings = (run) => gitCommandsDuring(run).filter((c) => c.startsWith('ls-tree'));

    const merged = () => {
      mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
      writeFileSync(join(repo, 'requirements/changes/20260101T000000.000Z__old.md'), '# Old\n');
      mkdirSync(join(repo, '.katatay/state/branchy'), { recursive: true });
      writeFileSync(join(repo, '.katatay/state/branchy/0001__verified.json'), '{"seq":1,"prev":null,"event":"verified"}\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'merged earlier');
      markTarget(repo);
      // A branch whose logbook is the one the fixture committed.
      git('checkout', '--quiet', '-b', 'branch');
      writeFileSync(join(repo, 'requirements/changes/20260102T000000.000Z__new.md'), '# New\n');
    };

    it('in one call', () => {
      merged();
      expect(listings(() => gitSnapshot())).toHaveLength(1);
    });

    it('gives newChangeFiles the same answer as asking for itself', () => {
      merged();
      expect(newChangeFiles(gitSnapshot())).toEqual(['requirements/changes/20260102T000000.000Z__new.md']);
      expect(newChangeFiles(gitSnapshot())).toEqual(newChangeFiles());
    });

    it('gives mergedEvents the same answer as asking for itself, and no other branch\'s events', () => {
      merged();
      const snapshot = gitSnapshot();
      expect(snapshot.dir).toBe(dir);
      expect(mergedEvents(dir, snapshot)).toEqual([`${dir}/0001__verified.json`]);
      expect(mergedEvents(dir, snapshot)).toEqual(mergedEvents(dir));
    });

    // The snapshot holds the current branch's logbook only. Asked about another,
    // mergedEvents asks git, rather than answering from a listing that never
    // included it.
    it('still answers for a logbook that is not the current branch\'s', () => {
      merged();
      const snapshot = gitSnapshot();
      let answer;
      expect(listings(() => { answer = mergedEvents('.katatay/state/branchy', snapshot); })).toHaveLength(1);
      expect(answer).toEqual(['.katatay/state/branchy/0001__verified.json']);
    });
  });
});

// Where change files live is the rulebook's `requirementsDir`.
describe('the change files of the folder the rulebook names', () => {
  const inSpecs = () => writeConfig(repo, { fields: { requirementsDir: 'specs/' } });

  it('are the records under its changes/ folder, and not the template', () => {
    inSpecs();
    expect(isChangeFile('specs/changes/20260101T000000.000Z__a.md')).toBe(true);
    expect(isChangeFile('specs/changes/TEMPLATE.md')).toBe(false);
  });

  it('are not the records under the default folder once the rulebook names another', () => {
    inSpecs();
    expect(isChangeFile('requirements/changes/20260101T000000.000Z__a.md')).toBe(false);
    expect(isChangeFile('specs/acceptance/AC0001__a.md')).toBe(false);
  });

  it('are the records under requirements/changes/ when the rulebook says nothing', () => {
    expect(isChangeFile('requirements/changes/20260101T000000.000Z__a.md')).toBe(true);
    expect(isChangeFile('specs/changes/20260101T000000.000Z__a.md')).toBe(false);
  });

  // The snapshot lists what the target holds under the folder, and under this
  // branch's logbook, in one call.
  it('are listed from the target by the snapshot, with this branch\'s logbook, and the new ones found against it', () => {
    inSpecs();
    mkdirSync(join(repo, 'specs/changes'), { recursive: true });
    mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(repo, 'specs/changes/20260101T000000.000Z__old.md'), '# Old\n');
    writeFileSync(join(repo, 'requirements/changes/20260101T000000.000Z__other.md'), '# Other\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'merged earlier');
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'branch');
    writeFileSync(join(repo, 'specs/changes/20260102T000000.000Z__new.md'), '# New\n');
    writeFileSync(join(repo, 'requirements/changes/20260102T000000.000Z__elsewhere.md'), '# Elsewhere\n');

    const snapshot = gitSnapshot();
    expect([...snapshot.onTarget].sort()).toEqual(['.katatay/state/branch/0001__verified.json', 'specs/changes/20260101T000000.000Z__old.md']);
    expect(newChangeFiles(snapshot)).toEqual(['specs/changes/20260102T000000.000Z__new.md']);
    expect(newChangeFiles()).toEqual(['specs/changes/20260102T000000.000Z__new.md']);
  });
});

/**
 * Which of a logbook's events the target already holds — the signal that a change
 * is over, and so that the events it left behind grant nothing.
 */
describe('events the target already holds', () => {
  const dir = '.katatay/state/branch';
  const first = `${dir}/0001__verified.json`;

  it('finds none when there is no target to compare against', () => {
    expect(mergedEvents(dir)).toEqual([]);
  });

  it('finds the whole logbook of a change that has been merged', () => {
    markTarget(repo);
    expect(mergedEvents(dir)).toEqual([first]);
  });

  it('leaves out the events this branch has and the target does not', () => {
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'feat');
    event('0002__plan_approved.json', '{"seq":2,"prev":null,"event":"plan_approved"}\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a live event');
    expect(mergedEvents(dir)).toEqual([first]);
  });

  // An event appended this turn is the ordinary state of a change in progress.
  // Counting it as merged would end the epoch the moment it started.
  it('leaves out an event that has been written but not committed', () => {
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'feat');
    event('0002__triaged.json', '{"seq":2,"prev":null,"event":"triaged"}\n');
    expect(mergedEvents(dir)).toEqual([first]);
  });

  // The pathspec ends in a slash so it names a directory. Without one, a logbook
  // for `branch` would swallow the events of a branch called `branchy`.
  it('does not count another branch name\'s events', () => {
    mkdirSync(join(repo, '.katatay/state/branchy'), { recursive: true });
    writeFileSync(join(repo, '.katatay/state/branchy/0001__verified.json'), '{"seq":1,"prev":null,"event":"verified"}\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'another branch');
    markTarget(repo);
    expect(mergedEvents(dir)).toEqual([first]);
  });

  it('gives the same answer with a snapshot as without', () => {
    markTarget(repo);
    expect(mergedEvents(dir, gitSnapshot())).toEqual(mergedEvents(dir));
  });
});

/**
 * Whether this change's own events are committed. The fixture's first event is
 * committed in every case, so what each case decides is whether the target
 * holds it: if it does, it belongs to a change that is over.
 */
describe('whether the logbook is committed', () => {
  const dir = '.katatay/state/branch';
  const head = () => git('log', '-1', '--format=%h').trim();

  // The fixture commits once more after the event, so the commit named is the
  // one that holds the event, not wherever `HEAD` is.
  it('says so, with the commit, when this change\'s events are committed', () => {
    const recorded = git('log', '-1', '--format=%h', '--', dir).trim();
    expect(logbookIsCommitted(dir)).toEqual({ committed: true, sha: recorded, count: 1 });
    expect(recorded).not.toBe(head());
  });

  // The reused branch name. Every commit that touched the folder belongs to
  // the last change, so none of them makes this change's events safe.
  it('does not count events the target already holds as this change\'s', () => {
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'feat');
    event('0002__plan_approved.json', '{"seq":2,"prev":null,"event":"plan_approved"}\n');
    expect(logbookIsCommitted(dir)).toEqual({ committed: false, sha: null, count: 1 });
  });

  it('names the commit of this change\'s events, not the merged ones\'', () => {
    markTarget(repo);
    const merged = head();
    git('checkout', '--quiet', '-b', 'feat');
    event('0002__plan_approved.json', '{"seq":2,"prev":null,"event":"plan_approved"}\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a live event');
    expect(logbookIsCommitted(dir)).toEqual({ committed: true, sha: head(), count: 2 });
    expect(head()).not.toBe(merged);
  });

  // `count` still covers the merged events: one deleted from the folder is
  // missing, whichever change it belonged to.
  it('still counts every committed event, merged or not', () => {
    markTarget(repo);
    expect(logbookIsCommitted(dir)).toEqual({ committed: false, sha: null, count: 1 });
  });

  it('gives the same answer with a snapshot as without', () => {
    markTarget(repo);
    git('checkout', '--quiet', '-b', 'feat');
    event('0002__plan_approved.json', '{"seq":2,"prev":null,"event":"plan_approved"}\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a live event');
    expect(logbookIsCommitted(dir, gitSnapshot())).toEqual(logbookIsCommitted(dir));
  });
});

/**
 * Whether `HEAD` and the target's remote-tracking ref exist, asked once instead
 * of twice.
 *
 * The exit status cannot answer it. `git rev-parse HEAD main` exits 0 in a
 * repository holding a *file* called `main` and no branch of that name: it
 * echoes the unresolved argument on stdout and carries on. So the output is
 * read, and this case is the reason.
 */
describe('which refs exist', () => {
  it('reports both when both exist', () => {
    markTarget(repo);
    expect(gitSnapshot().refs).toEqual({ head: true, target: true });
  });

  it('reports the target missing on a repository that has never fetched it', () => {
    expect(gitSnapshot().refs).toEqual({ head: true, target: false });
  });

  it('is not fooled by a file called main', () => {
    writeFileSync(join(repo, 'main'), 'not a branch\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a file called main');
    expect(gitSnapshot().refs.target).toBe(false);
  });

  // No target ref is an ordinary state, not an error, and git says
  // `fatal: ambiguous argument` about it. The calls this replaced discarded
  // that, and it has to stay discarded, or every run prints a fatal error
  // about nothing being wrong.
  it('says nothing on stderr when a ref is missing', () => {
    const noise = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { noise.push(String(chunk)); return real(chunk, ...rest); };
    try {
      expect(gitSnapshot().refs.target).toBe(false);
    } finally {
      process.stderr.write = real;
    }
    expect(noise.join('')).not.toMatch(/fatal/);
  });

  it('reports newChangeFiles as empty when there is no target to compare against', () => {
    mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(repo, 'requirements/changes/20260101T000000.000Z__x.md'), '# X\n');
    expect(newChangeFiles()).toEqual([]);
  });
});
