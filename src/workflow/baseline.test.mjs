import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchTarget, fetchTargetInCi, nextBaseline, pinBaseline, provedOnServer, unmergedWork } from './baseline.mjs';
import { gitCommandsDuring } from '../../tests/fixtures/workflow/trace.mjs';
import { baselinesIn } from './phase.mjs';

/**
 * Against a real repository and a real server, a bare repository on disk. What
 * is being checked is how the git calls answer together, including when the
 * server does not answer at all.
 */
describe('the baseline', () => {
  let dir;
  let repo;
  let server;
  let cwd;
  const t = { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main', name: 'origin/main' };

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (file, body) => {
    writeFileSync(join(repo, file), body);
    git('add', file);
    git('commit', '--quiet', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const serverDown = () => git('remote', 'set-url', 'origin', join(dir, 'nothing-here'));

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'workflow-baseline-'));
    repo = join(dir, 'repo');
    server = join(dir, 'server.git');
    execFileSync('git', ['init', '--quiet', '--bare', server]);
    execFileSync('git', ['init', '--quiet', '--initial-branch', 'feat', repo]);
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', server);
    commit('base.txt', 'base\n');
    git('push', '--quiet', 'origin', 'feat:main');
    git('fetch', '--quiet', 'origin');
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  describe('pinned', () => {
    it('where HEAD meets the target, from the server', () => {
      const base = git('rev-parse', 'HEAD');
      commit('work.txt', 'this change\n');
      expect(pinBaseline(t)).toEqual({ sha: base, source: 'server' });
    });

    it('from the ref as last fetched, when the server does not answer', () => {
      const base = git('rev-parse', 'HEAD');
      serverDown();
      expect(pinBaseline(t)).toEqual({ sha: base, source: 'fallback' });
    });

    it('as nothing, when the target was never fetched and the server does not answer', () => {
      git('update-ref', '-d', t.ref);
      serverDown();
      expect(pinBaseline(t)).toBeNull();
    });
  });

  describe('moved', () => {
    it('not at all while the target is fetched and not merged in', () => {
      const base = git('rev-parse', 'HEAD');
      git('checkout', '--quiet', '-b', 'other');
      commit('theirs.txt', 'theirs\n');
      git('push', '--quiet', 'origin', 'other:main');
      git('checkout', '--quiet', 'feat');
      git('fetch', '--quiet', 'origin');
      expect(nextBaseline(t, base)).toBeNull();
    });

    // A merge-base that does not descend from the baseline in force would
    // measure the change from before where it started.
    it('never backwards', () => {
      const first = git('rev-parse', 'HEAD');
      const later = commit('later.txt', 'later\n');
      git('push', '--quiet', 'origin', 'feat:main');
      git('fetch', '--quiet', 'origin');
      git('push', '--quiet', '--force', 'origin', `${first}:refs/heads/main`);
      git('update-ref', t.ref, first);
      serverDown();
      expect(nextBaseline(t, later)).toBeNull();
    });
  });

  describe('proved on the server', () => {
    it('proves every baseline extracted from commit approvals', () => {
      const base = git('rev-parse', 'HEAD');
      const approval = baseline => ({ event: 'plan_approved', payload: { baseline } });
      const entries = [approval(base), approval(base)];
      expect(baselinesIn(entries)).toEqual([base]);
      expect(provedOnServer(t, baselinesIn(entries))).toEqual({ ok: true, tip: base });
      const mine = commit('work.txt', 'this change\n');
      entries.push(approval(mine));
      expect(provedOnServer(t, baselinesIn(entries))).toEqual({ ok: false, reason: 'not-on-target', tip: base, shas: [mine] });
    });

    it('when every baseline is on the server\'s target', () => {
      const base = git('rev-parse', 'HEAD');
      expect(provedOnServer(t, [base])).toEqual({ ok: true, tip: base });
    });

    it('not, for a commit only this branch has, even when the local ref says otherwise', () => {
      const mine = commit('work.txt', 'this change\n');
      git('update-ref', t.ref, mine);
      expect(provedOnServer(t, [mine])).toMatchObject({ ok: false, reason: 'not-on-target', shas: [mine] });
    });

    it('not, and says the server is unreachable, when it does not answer', () => {
      const base = git('rev-parse', 'HEAD');
      serverDown();
      expect(provedOnServer(t, [base])).toEqual({ ok: false, reason: 'unreachable' });
    });

    // The tip has to be a commit this repository holds before ancestry can be
    // asked. A tip nobody fetched yet is fetched.
    it('after fetching a tip this repository has not seen yet', () => {
      const base = git('rev-parse', 'HEAD');
      git('checkout', '--quiet', '-b', 'other');
      commit('theirs.txt', 'theirs\n');
      git('push', '--quiet', 'origin', 'other:main');
      git('checkout', '--quiet', 'feat');
      git('branch', '--quiet', '-D', 'other');
      git('reflog', 'expire', '--expire=now', '--all');
      git('gc', '--quiet', '--prune=now');
      expect(provedOnServer(t, [base])).toMatchObject({ ok: true });
    });
  });

  describe('work already on the branch', () => {
    it('lists the files HEAD changes against the baseline', () => {
      const base = git('rev-parse', 'HEAD');
      commit('inherited.txt', 'from another branch\n');
      expect(unmergedWork(base)).toEqual(['inherited.txt']);
    });

    it('leaves out the workflow\'s own bookkeeping', () => {
      const base = git('rev-parse', 'HEAD');
      execFileSync('mkdir', ['-p', join(repo, '.katatay/state/feat')]);
      commit('.katatay/state/feat/0001__plan_approved.json', '{}\n');
      commit('FOLLOW-UPS.md', '# Follow-ups\n');
      expect(unmergedWork(base)).toEqual([]);
    });

    // The three below are in no commit, so `git diff <baseline> HEAD` never
    // listed them, and an edit made before the approval rode into the change
    // without being named.
    it('lists an edit that is not staged', () => {
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'base.txt'), 'edited before any plan\n');
      expect(unmergedWork(base)).toEqual(['base.txt']);
    });

    it('lists an edit that is staged and not committed', () => {
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'base.txt'), 'edited before any plan\n');
      git('add', 'base.txt');
      expect(unmergedWork(base)).toEqual(['base.txt']);
    });

    it('lists a file git has not been told about', () => {
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'new.txt'), 'written before any plan\n');
      expect(unmergedWork(base)).toEqual(['new.txt']);
    });

    it('leaves the bookkeeping out when it is uncommitted too', () => {
      const base = git('rev-parse', 'HEAD');
      execFileSync('mkdir', ['-p', join(repo, '.katatay/state/feat')]);
      writeFileSync(join(repo, '.katatay/state/feat/0001__plan_approved.json'), '{}\n');
      writeFileSync(join(repo, 'FOLLOW-UPS.md'), '# Follow-ups\n');
      expect(unmergedWork(base)).toEqual([]);
    });

    // The approval is in the logbook by the time this is asked. Throwing here
    // would have the hook say the approval was not recorded.
    it('answers nothing when the listing fails, and does not throw', () => {
      const base = git('rev-parse', 'HEAD');
      process.chdir(dir); // not a repository, so every git call fails
      expect(unmergedWork(base)).toEqual([]);
    });
  });

  describe('fetched in CI', () => {
    it('does nothing outside CI, so a local check works offline', () => {
      serverDown();
      expect(() => fetchTargetInCi(t, {})).not.toThrow();
    });

    it('fails in CI when the server does not answer', () => {
      serverDown();
      expect(() => fetchTargetInCi(t, { CI: 'true' })).toThrow(/could not fetch origin\/main/);
    });

    // Only `CI=true` is CI: a value such as `false` must not start a fetch.
    it('does nothing when CI is set to anything but true', () => {
      serverDown();
      for (const value of ['false', '0', '1', '']) expect(() => fetchTargetInCi(t, { CI: value }), value).not.toThrow();
    });
  });

  // A hook fetches on most turns. Housekeeping the operator's repository is not
  // its job, and the maintenance run a fetch starts was one more process each
  // time. The server has something new, so the fetch has real work to do.
  describe('fetched by a hook', () => {
    it('starts no git maintenance', () => {
      git('checkout', '--quiet', '-b', 'other');
      commit('theirs.txt', 'theirs\n');
      git('push', '--quiet', 'origin', 'other:main');
      git('checkout', '--quiet', 'feat');
      let answered;
      const started = gitCommandsDuring(() => { answered = fetchTarget(t); });
      expect(answered).toBe(true);
      expect(started.some((c) => c.startsWith('fetch'))).toBe(true);
      expect(started.filter((c) => c.startsWith('maintenance'))).toEqual([]);
    });
  });
});
