/** The lines a change touched. How the diff is read, hunk by hunk and whatever
 *  the user's git settings, is proved through `mutationTargets` and
 *  `changedTargets` in `src/evidence/mutants.test.ts`, which wrap these. Here
 *  it is the part they share: the caller decides which files count. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { touchedFiles, touchedTargets } from './touched.mjs';

const diffOf = (file, hunk) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, hunk, '+changed'].join('\n');

describe('the touched lines, filtered by the caller', () => {
  const onlyTs = (file) => file.endsWith('.ts');

  it('keeps the files the filter accepts and drops the rest', () => {
    const diff = [diffOf('a.ts', '@@ -1,0 +2,3 @@'), diffOf('b.md', '@@ -1 +1 @@')].join('\n');
    expect(touchedTargets(diff, [], onlyTs)).toEqual([{ file: 'a.ts', lines: [2, 4] }]);
  });

  it('applies the filter to untracked files, which count whole', () => {
    expect(touchedTargets('', ['new.ts', 'notes.md'], onlyTs)).toEqual([{ file: 'new.ts' }]);
  });

  // Coverage keeps a file the mutation filter skips, such as a test runner's
  // config, so the same diff must answer each its own way.
  it('gives two callers with different filters their own answers from one diff', () => {
    const diff = [diffOf('a.ts', '@@ -1 +1 @@'), diffOf('b.mjs', '@@ -1 +1 @@')].join('\n');
    expect(touchedTargets(diff, [], () => true).map((t) => t.file)).toEqual(['a.ts', 'b.mjs']);
    expect(touchedTargets(diff, [], onlyTs).map((t) => t.file)).toEqual(['a.ts']);
  });
});

describe('the touched lines of a working tree', () => {
  let root;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-touched-')));
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(root, 'notes.md'), 'old\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the diff against the base and the untracked files, through the filter', () => {
    writeFileSync(join(root, 'a.ts'), 'one\nTWO\nthree\n');
    writeFileSync(join(root, 'notes.md'), 'new\n');
    writeFileSync(join(root, 'b.ts'), 'fresh\n');
    expect(touchedFiles('HEAD', root, (file) => file.endsWith('.ts'))).toEqual([
      { file: 'a.ts', lines: [2, 2] },
      { file: 'b.ts' },
    ]);
  });
});
