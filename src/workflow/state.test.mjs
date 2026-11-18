import { approval, recorded, snapshotGrant } from '../../tests/fixtures/workflow/events.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonedChangeFiles, carriedGrants, current, approvedPlanSummary, savedWarnings, summarise } from './state.mjs';
import { append, dirFor } from './chain.mjs';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { gitCommandsDuring } from '../../tests/fixtures/workflow/trace.mjs';
import { readBaseline } from './phase.mjs';

/**
 * `current()` has one mode. A cheaper mode used to skip the tree fingerprint
 * and report a guessed phase for every approved change, in a field that gave
 * no sign it was a guess. See the comment on `current` in `state.mjs`.
 */
describe('the state of a change', () => {
  let repo;
  let cwd;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'workflow-state-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo });
    git('init', '--quiet', '-b', 'feat/x');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(repo);
    writeFileSync(join(repo, 'source.txt'), 'original\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    markTarget(repo);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  // A caller written for the old `{ withTree: false }` must fail, not quietly
  // get a full read it did not ask for, or a cheap one somebody added back.
  it('refuses any options, so the old cheap mode cannot be asked for', () => {
    expect(() => current({ withTree: false })).toThrow('takes no options');
    expect(() => current({})).toThrow('takes no options');
  });

  it('always reads the tree, even before any plan is approved', () => {
    const state = current();

    expect(state.phase).toBe('open');
    expect(state.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toHaveProperty('treeKnown');
    expect(state).not.toHaveProperty('plan');
  });

  it('reads a commit approval baseline into normalized state', () => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const payload = approval({ baseline: commit });
    append('.katatay/state/feat_x', 'plan_approved', payload, 'feat/x');
    const state = current();
    expect(state.broken).toBeNull();
    expect(state.phase).toBe('implementing');
    expect(state.baseline).toBe(commit);
    expect(state.baselines).toEqual([commit]);
    expect(readBaseline(state.grant.payload.baseline)).toBe(commit);
  });

  it('cannot open a change by appending a retired object approval', () => {
    const payload = approval({ baseline: { sha: 'a'.repeat(40), source: 'server' } });
    expect(() => append('.katatay/state/feat_x', 'plan_approved', payload, 'feat/x')).toThrow('baseline must be a Git commit ID');
    expect(current()).toMatchObject({ phase: 'open', grant: null, entries: [], broken: null });
  });

  // Every hook reads this at least once, and the gate in `pre-tool.mjs` reads it
  // on every tool call, so what it costs is paid constantly. Nearly all of that
  // cost is starting git. It took eight processes until 2026-10-04, and these
  // counts are what keeps it from drifting back up one call at a time.
  describe('the git processes one reading takes', () => {
    // One of them asks git which committed event files changed: the chain
    // alone cannot see a rewrite that recomputed every link after it.
    it('is six while the logbook has never been committed', () => {
      expect(gitCommandsDuring(() => current())).toHaveLength(6);
    });

    // A committed logbook is asked for its count as well, which is one more.
    it('is seven once the logbook has been committed', () => {
      append('.katatay/state/feat_x', 'plan_approved', approval(), 'feat/x');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '--quiet', '-m', 'the logbook'], { cwd: repo });
      expect(gitCommandsDuring(() => current())).toHaveLength(7);
    });

    it('reads the approved state without local plan bytes or a working-plan field', () => {
      append('.katatay/state/feat_x', 'plan_approved', approval(), 'feat/x');
      const state = current();
      expect(state.phase).toBe('implementing');
      expect(state).not.toHaveProperty('plan');
      expect(approvedPlanSummary(state)).toContain('unavailable locally');
      expect(current().phase).toBe('implementing');
    });
  });

  describe('a broken logbook, as readLogbook defines it', () => {
    const logbook = '.katatay/state/feat_x';
    const changeFile = 'requirements/changes/20261109T000000.000Z__change.md';
    const commit = (message) => {
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: repo });
    };
    const writeChange = (file = changeFile) => {
      mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
      writeFileSync(join(repo, file), '# A change\n');
    };

    // The last event has nothing after it to link to it, so the chain cannot
    // see the edit. Git can, and the hooks now ask it.
    it('is broken when a committed event was edited, and a reset cannot mend it', () => {
      append(logbook, 'plan_approved', approval(), 'feat/x');
      commit('the logbook');
      const file = `${logbook}/0001__plan_approved.json`;
      writeFileSync(file, readFileSync(file, 'utf8').replace('{', '{ '));

      const state = current();
      expect(state.phase).toBe('broken');
      expect(state.broken).toBe(`${file}: committed as history, but the working tree disagrees with it. Restore it from git.`);
      expect(state.resetRepairs).toBe(false);
      expect(state.next).toEqual(['stop and tell the operator']);
      // A broken logbook hands no event to any reader.
      expect(state.live).toEqual([]);
    });

    it('is broken when a change file the recorded event names is gone, and a reset mends it', () => {
      writeChange();
      append(logbook, 'plan_approved', approval(), 'feat/x');
      append(logbook, 'recorded', { ...recorded, files: [changeFile] }, 'feat/x');
      expect(current().broken).toBeNull();
      rmSync(join(repo, changeFile));

      const state = current();
      expect(state.phase).toBe('broken');
      expect(state.broken).toBe(`${changeFile}: named by ${logbook}/0002__recorded.json, and gone, so that recorded event is no longer valid. `
        + 'Restore it from git, or the operator types `reset` to abandon this change epoch.');
      expect(state.resetRepairs).toBe(true);
      expect(state.next).toEqual(['restore the change files from git, or ask the operator to type `reset`']);

      append(logbook, 'reset', { note: null }, 'feat/x');
      expect(current()).toMatchObject({ phase: 'open', broken: null });
    });

    // Removing the last two events leaves a chain that still links, so only
    // git sees them gone.
    it('names every committed event the working tree lost, and speaks of them in the plural', () => {
      append(logbook, 'plan_approved', approval(), 'feat/x');
      append(logbook, 'plan_approved', approval(), 'feat/x');
      append(logbook, 'plan_approved', approval(), 'feat/x');
      commit('the logbook');
      const files = [`${logbook}/0002__plan_approved.json`, `${logbook}/0003__plan_approved.json`];
      for (const file of files) rmSync(join(repo, file));

      expect(current().broken).toBe(`${files[0]}, ${files[1]}: committed as history, but the working tree disagrees with them. Restore them from git.`);
    });

    it('names every gone change file, and speaks of them in the plural', () => {
      const second = 'requirements/changes/20261109T000001.000Z__second.md';
      writeChange();
      writeChange(second);
      append(logbook, 'plan_approved', approval(), 'feat/x');
      append(logbook, 'recorded', { ...recorded, files: [changeFile, second] }, 'feat/x');
      rmSync(join(repo, changeFile));
      rmSync(join(repo, second));

      expect(current().broken).toBe(`${changeFile}, ${second}: named by ${logbook}/0002__recorded.json, and gone, so that recorded event is no longer valid. `
        + 'Restore them from git, or the operator types `reset` to abandon this change epoch.');
    });

    it('leaves the change files a reset abandoned out of the change epoch', () => {
      writeChange();
      append(logbook, 'reset', { note: null, changeFiles: [changeFile] }, 'feat/x');
      const later = 'requirements/changes/20261110T000000.000Z__later.md';
      writeChange(later);

      const before = current();
      expect(before.changeFiles).toEqual([later]);
      expect(before.earlierChangeFiles).toEqual([changeFile]);
      rmSync(join(repo, changeFile));
      const after = current();
      expect(after.earlierChangeFiles).toEqual([]);
      expect(after.changeDigest).toBe(before.changeDigest);
      expect(after.broken).toBeNull();
    });
  });
});

/**
 * The plan approvals of the other changes a branch carries, which `req:guard`
 * accepts as well as the current branch's own. See `carriedGrants`.
 */
describe('the change files a reset abandoned', () => {
  const reset = (changeFiles) => ({ event: 'reset', payload: { note: null, ...(changeFiles ? { changeFiles } : {}) } });

  it('counts only the resets after the last merged event', () => {
    expect([...abandonedChangeFiles([reset(['a.md']), reset(['b.md'])], 1)]).toEqual(['b.md']);
  });

  it('reads a reset that names no change files as abandoning none', () => {
    expect([...abandonedChangeFiles([reset(['a.md']), reset()])]).toEqual(['a.md']);
  });
});

describe('the plan approvals other changes carry in', () => {
  let repo;
  let cwd;
  const git = (...args) => execFileSync('git', args, { cwd: repo });
  const approve = (branch, id) =>
    append(dirFor(branch), 'plan_approved', approval({ requirementChanges: [{ id, status: 'active', statement: `${id} as approved.`, scenarios: [] }] }), branch);
  const approvedIds = () => carriedGrants().flatMap((held) => held.payload.requirementChanges.map((r) => r.id));
  const commitAll = (message) => {
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
  };
  const writeChangeFile = (file) => {
    mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(repo, file), '# A change\n');
  };

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'workflow-carried-'));
    git('init', '--quiet', '-b', 'batch');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(repo);
    writeFileSync(join(repo, 'source.txt'), 'original\n');
    commitAll('base');
    markTarget(repo);
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('gives the approval in each other change\'s logbook', () => {
    approve('feat/a', 'AC0001');
    approve('feat/b', 'AC0002');
    expect(approvedIds().sort()).toEqual(['AC0001', 'AC0002']);
  });

  // Its grant is `current().grant`, which can also stand in for a change file.
  it('leaves out the current branch\'s own logbook', () => {
    approve('batch', 'AC0001');
    approve('feat/a', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  it('gives nothing from a change the target already holds', () => {
    approve('feat/a', 'AC0001');
    commitAll('feat/a merged');
    markTarget(repo);
    approve('feat/b', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  it('gives nothing from before a reset', () => {
    approve('feat/a', 'AC0001');
    append(dirFor('feat/a'), 'reset', { note: null }, 'feat/a');
    expect(approvedIds()).toEqual([]);
    approve('feat/a', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  // The same rule `grant` applies to the current branch: a revised plan
  // replaces the one before it, and a plan after `recorded` is a second change.
  it('gives the latest approval, and none made after the change was recorded', () => {
    approve('feat/a', 'AC0001');
    approve('feat/a', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
    // The change file the `recorded` event names has to exist, or the logbook
    // is broken and grants nothing at all.
    writeChangeFile(recorded.files[0]);
    append(dirFor('feat/a'), 'recorded', recorded, 'feat/a');
    approve('feat/a', 'AC0003');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  // Broken as `readLogbook` defines it, for every logbook alike.
  it('gives nothing from a logbook whose recorded change file is gone', () => {
    approve('feat/a', 'AC0001');
    append(dirFor('feat/a'), 'recorded', recorded, 'feat/a');
    approve('feat/b', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  it('gives nothing from a logbook whose committed events were edited', () => {
    approve('feat/a', 'AC0001');
    commitAll('the logbook');
    const file = join(repo, dirFor('feat/a'), '0001__plan_approved.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('AC0001 as approved.', 'AC0001 as never approved.'));
    approve('feat/b', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  // The break comes after the approval, so the events read before it still
  // hold a grant. The logbook as a whole is what is not trusted.
  it('gives nothing from a logbook that does not link up', () => {
    approve('feat/a', 'AC0001');
    const dir = dirFor('feat/a');
    writeFileSync(join(repo, dir, '0002__triaged.json'), '{ "seq": 2, "prev": "not the event before", "event": "triaged", "payload": {} }\n');
    approve('feat/b', 'AC0002');
    expect(approvedIds()).toEqual(['AC0002']);
  });

  // A target that was never fetched holds nothing, so every logbook is live.
  // Asking git about a ref that does not exist would throw instead.
  it('gives every approval when the target has never been fetched', () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    approve('feat/a', 'AC0001');
    expect(approvedIds()).toEqual(['AC0001']);
  });

  it('gives nothing when there are no logbooks at all', () => {
    expect(carriedGrants()).toEqual([]);
  });

  // There are dozens of logbooks on a long-lived repository. Asking the target
  // about each one would start a git process per logbook.
  it('starts as many git processes for many logbooks as for one', () => {
    approve('feat/a', 'AC0001');
    const forOne = gitCommandsDuring(() => carriedGrants()).length;
    for (const branch of ['feat/b', 'feat/c', 'feat/d']) approve(branch, 'AC0001');
    expect(gitCommandsDuring(() => carriedGrants())).toHaveLength(forOne);
  });
});

/**
 * `git init` and nothing else. `HEAD` names a branch that does not exist yet,
 * so `rev-parse` cannot give its name and `current()` used to throw. The gate
 * allowed whatever it could not judge, so every edit went through here with no
 * plan approved.
 */
describe('the state of a branch with no commit yet', () => {
  let repo;
  let cwd;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'workflow-unborn-'));
    execFileSync('git', ['init', '--quiet', '-b', 'feat/x'], { cwd: repo });
    configureTarget(repo);
    writeFileSync(join(repo, 'source.txt'), 'original\n');
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('is open, and says there is nothing to measure a change from', () => {
    const state = current();

    expect(state.phase).toBe('open');
    expect(state.why).toBe('this branch has no commit yet, so there is nothing to measure a change from');
    expect(state.grant).toBeNull();
    expect(state.broken).toBeNull();
  });

  // The name the branch will have once it has a commit, so the logbook folder and
  // the summary are the ones the first commit will keep using.
  it('names the branch HEAD points at', () => {
    const state = current();

    expect(state.branch).toBe('feat/x');
    expect(state.dir).toBe('.katatay/state/feat_x');
    expect(summarise(state)).toMatch(/^workflow: open on feat\/x — this branch has no commit yet/);
  });

  // Whatever is in the folder, nothing in it can grant anything without a
  // commit to pin a baseline to. So it is not read, and an approval found
  // there does not open the gate.
  it('does not read a plan approval out of a logbook left in the folder', () => {
    append('.katatay/state/feat_x', 'plan_approved', approval(), 'feat/x');

    const state = current();

    expect(state.phase).toBe('open');
    expect(state.entries).toEqual([]);
    expect(state.live).toEqual([]);
  });
});

/**
 * The two warnings count different things: missing events over the whole logbook,
 * uncommitted ones over this change's own. See `savedWarnings`.
 */
describe('what is said about whether the logbook is committed', () => {
  const merged = { seq: 1 };
  const own = { seq: 2 };

  // The reused branch name: one merged event, one new one, and no commit of
  // this change's. Counting every entry against every committed file made
  // this look like a logbook that matched its commit.
  it('warns that this change\'s events are uncommitted, whatever the merged ones are', () => {
    const warnings = savedWarnings({ entries: [merged, own], live: [own], saved: { committed: false, sha: null, count: 1 } });
    expect(warnings).toEqual(['this change has 1 event(s) in the logbook and none are committed yet — deleting them now would leave no trace']);
  });

  it('stays quiet when every event is one the target already holds', () => {
    expect(savedWarnings({ entries: [merged], live: [], saved: { committed: false, sha: null, count: 1 } })).toEqual([]);
  });

  it('stays quiet when this change\'s events are committed', () => {
    expect(savedWarnings({ entries: [merged, own], live: [own], saved: { committed: true, sha: 'abc1234', count: 2 } })).toEqual([]);
  });

  // A merged event deleted from the folder is missing like any other, and
  // nothing of this change's needs to be committed for that to be said.
  it('warns that a committed event is missing, a merged one included', () => {
    const warnings = savedWarnings({ entries: [], live: [], saved: { committed: false, sha: null, count: 1 } });
    expect(warnings).toEqual(['1 event(s) are committed but missing from the logbook. Stop and tell the operator.']);
  });
});

/**
 * The summary each turn starts with. The agent's setup warnings are not in it:
 * they are `warning` messages of their own in `on prompt`, so an adapter can
 * show them to the operator apart from the state (`setupMessages` in
 * `agent.mjs`, tested in `agent.test.mjs`).
 */
describe('the summary injected each turn', () => {
  const state = { phase: 'open', branch: 'feat/x', why: 'no plan has been approved', next: ['present the plan'] };

  it('says nothing about settings when there is nothing to say', () => {
    expect(summarise(state)).toBe('workflow: open on feat/x — no plan has been approved\nnext: present the plan');
  });
});

describe('where the agent reads the approved plan', () => {
  let root, cwd, state;
  const text = '# Approved plan\n\nKeep these exact bytes.\n';
  const snapshotPath = () => join(root, state.grant.payload.planSnapshot);
  const available = () => `approved plan: ${state.grant.payload.planSnapshot} — read the approved plan from this snapshot.`;

  beforeEach(() => {
    cwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'approved-plan-summary-'));
    process.chdir(root);
    state = { branch: 'feat/x', phase: 'implementing', why: 'approved', next: ['run triage'],
      grant: snapshotGrant('feat/x', text, root) };
  });
  afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });

  it('names the exact snapshot on every prompt, including its instruction to read it', () => {
    expect(approvedPlanSummary(state)).toBe(available());
    expect(summarise(state)).toBe(`workflow: implementing on feat/x — approved\n${available()}\nnext: run triage`);
    expect(summarise(state)).toContain(available());
    expect(readFileSync(snapshotPath(), 'utf8')).toBe(text);
  });

  it('uses an explicit repository root without depending on the current directory', () => {
    process.chdir(cwd);
    expect(approvedPlanSummary(state, root)).toBe(available());
  });

  it('says nothing when there is no current grant, even if a retired plan field remains', () => {
    state.grant = null;
    state.plan = { kind: 'changed', file: '/old/working.md' };
    expect(approvedPlanSummary(state)).toBeNull();
    expect(summarise(state)).toBe('workflow: implementing on feat/x — approved\nnext: run triage');
  });

  it.each([
    ['missing', 'ENOENT'],
    ['directory', 'not a regular file'],
    ['symlink', 'not a regular file'],
    ['corrupt', 'SHA-256 digest mismatch'],
    ['wrong branch', 'invalid approved plan reference'],
    ['wrong approval hash', 'snapshot differs from the approved plan hash'],
  ])('reports a %s snapshot without changing the phase or directing the agent to read invalid bytes', (damage, reason) => {
    if (['missing', 'directory', 'symlink'].includes(damage)) rmSync(snapshotPath());
    if (damage === 'directory') mkdirSync(snapshotPath());
    if (damage === 'symlink') {
      writeFileSync(join(root, 'elsewhere.md'), text);
      symlinkSync(join(root, 'elsewhere.md'), snapshotPath());
    }
    if (damage === 'corrupt') writeFileSync(snapshotPath(), text + '\n');
    if (damage === 'wrong branch') state.grant.payload.planSnapshot = snapshotGrant('other', text, root).payload.planSnapshot;
    if (damage === 'wrong approval hash') state.grant.payload.planSnapshot = snapshotGrant('feat/x', '# Another plan', root).payload.planSnapshot;
    const before = structuredClone(state);
    const result = approvedPlanSummary(state);
    expect(result).toContain(`approved plan: ${state.grant.payload.planSnapshot} — unavailable locally (`);
    expect(result).toContain(reason);
    expect(result).toContain('Restore the exact approved snapshot at the recorded path and retry.');
    expect(result).not.toContain('read the approved plan from this snapshot');
    expect(summarise(state)).toContain(result);
    expect(summarise(state)).toContain('workflow: implementing');
    expect(state).toEqual(before);
  });

  it('recognizes the restored approved bytes at the recorded path', () => {
    const path = snapshotPath();
    rmSync(path);
    expect(approvedPlanSummary(state)).toContain('unavailable locally');
    writeFileSync(path, text);
    expect(approvedPlanSummary(state)).toBe(available());
  });
});
