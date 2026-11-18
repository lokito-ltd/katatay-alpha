import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextBaseline } from '../../../src/workflow/baseline.mjs';

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

  describe('moved', () => {
    it('forward, to the target merged into the branch', () => {
      const base = git('rev-parse', 'HEAD');
      git('checkout', '--quiet', '-b', 'other');
      const theirs = commit('theirs.txt', 'theirs\n');
      git('push', '--quiet', 'origin', 'other:main');
      git('checkout', '--quiet', 'feat');
      git('fetch', '--quiet', 'origin');
      git('merge', '--quiet', '--no-edit', 'origin/main');
      expect(nextBaseline(t, base)).toEqual({ to: theirs, source: 'server' });
    });
  });
});
