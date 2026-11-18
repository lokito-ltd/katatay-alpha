import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRulebook } from '../../tests/fixtures/workflow/adapter.mjs';
import { parseTarget, target, TargetError } from './target.mjs';

/**
 * The one setting every workflow script needs. There is no default, so each
 * way of it being missing or wrong has to be refused, and refused the same
 * way, as a `TargetError` the entry points turn into their refusal.
 */
describe('the target setting', () => {
  let repo;
  let cwd;
  const rulebook = (baseline) => JSON.stringify({ ...fixtureRulebook(), targetBranch: baseline });
  const config = (body) => {
    mkdirSync(join(repo, '.katatay'), { recursive: true });
    writeFileSync(join(repo, '.katatay/rulebook.json'), body);
  };

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'workflow-target-'));
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', join(repo, '.no-such-remote')], { cwd: repo });
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('splits origin/main into the remote and the branch, and names the remote-tracking ref', () => {
    config(rulebook('origin/main'));
    expect(target()).toEqual({ remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main', name: 'origin/main' });
  });

  // Only the first slash splits, so a branch with slashes in its name works.
  it('keeps the rest of the value as the branch, slashes included', () => {
    expect(parseTarget(rulebook('origin/release/2026')).branch).toBe('release/2026');
  });

  it('refuses when there is no config file', () => {
    expect(() => target()).toThrow(TargetError);
    expect(() => target()).toThrow(/there is no \.katatay\/rulebook\.json/);
  });

  it('refuses a config without the targetBranch key', () => {
    config(rulebook());
    expect(() => target()).toThrow(/has no "targetBranch" key/);
  });

  it('refuses a value that is not <remote>/<branch>', () => {
    for (const value of ['main', '/main', 'origin/']) {
      config(rulebook(value));
      expect(() => target()).toThrow(/is not <remote>\/<branch>/);
    }
  });

  it('refuses a config that is not JSON', () => {
    config('baseline: origin/main\n');
    expect(() => target()).toThrow(/not readable as JSON/);
  });

  // Named wrongly, the remote would surface later as a fetch that fails, which
  // the tools read as the server being down. That has a different fix.
  it('refuses a remote git does not know', () => {
    config(rulebook('upstream/main'));
    expect(() => target()).toThrow(/git has no remote by that name/);
  });

  it('says in every refusal what the operator writes to fix it', () => {
    expect(() => target()).toThrow(/\{ "version": 1, "targetBranch": "origin\/main" \}/);
  });
});
