/**
 * Which change files the guard judges.
 *
 * Only the ones this branch is adding. A change file already on `main` is
 * merged history, and a rule written today must never turn a merged record into
 * a violation — that would break `req:guard` on every branch at once, for a
 * file nobody on that branch wrote. The `## Departures` rule made this
 * load-bearing: every change file merged before it existed lacks the section.
 *
 * A real git repository, because what counts as "on main" is a question only
 * git answers, and the answer is the whole point of the test.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNewChangeFiles } from './guard.js';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';

let repo: string;
let cwd: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

const change = (name: string, body: string) => {
  mkdirSync(join(repo, 'requirements/changes'), { recursive: true });
  writeFileSync(join(repo, 'requirements/changes', name), body);
};

const names = () => loadNewChangeFiles().map(({ path }) => path.split('/').pop()).sort();

beforeEach(() => {
  cwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), 'changes-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  configureTarget(repo);
  // A merged change file written before the departures rule existed.
  change('20260101T000000.000Z__old.md', '# Old\n\n## Why\n\nbecause\n');
  change('TEMPLATE.md', '# Template\n\n## Departures\n\nNone.\n');
  git('add', 'requirements');
  git('commit', '--quiet', '-m', 'history');
  markTarget(repo);
  git('checkout', '--quiet', '-b', 'feat');
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('the change files a branch is adding', () => {
  it('leaves a change file that is already on the target alone', () => {
    expect(names()).toEqual([]);
  });

  it('picks up one committed on this branch', () => {
    change('20260202T000000.000Z__new.md', '# New\n\n## Departures\n\nNone.\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'new change file');
    expect(names()).toEqual(['20260202T000000.000Z__new.md']);
  });

  // The usual case: the change file is written in the turn after `record` and
  // has not been committed yet when the turn-end hook runs the guard on it.
  it('picks up one that is not committed yet', () => {
    change('20260202T000000.000Z__new.md', '# New\n\n## Departures\n\nNone.\n');
    expect(names()).toEqual(['20260202T000000.000Z__new.md']);
  });

  it('never judges the template, which is tooling rather than a record', () => {
    change('TEMPLATE.md', '# Template, edited\n');
    expect(names()).toEqual([]);
  });

  it('reads the markdown of each file it returns', () => {
    change('20260202T000000.000Z__new.md', '# New\n\n## Departures\n\nNone.\n');
    expect(loadNewChangeFiles()[0]?.markdown).toContain('## Departures');
  });

  it('returns nothing when the directory does not exist', () => {
    rmSync(join(repo, 'requirements'), { recursive: true, force: true });
    expect(loadNewChangeFiles()).toEqual([]);
  });
});
