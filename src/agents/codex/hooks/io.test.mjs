import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joined, repositoryRoot } from './io.mjs';

describe('the repository a hook works in', () => {
  it('is the nearest folder above that holds .git, a folder in a clone', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-root-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(repositoryRoot(join(root, 'a', 'b'))).toBe(root);
    expect(repositoryRoot(root)).toBe(root);
  });

  it('is found from a worktree, whose .git is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-worktree-'));
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
    mkdirSync(join(root, 'sub'));
    expect(repositoryRoot(join(root, 'sub'))).toBe(root);
  });

  it('is none outside a repository', () => {
    expect(repositoryRoot('/')).toBe(null);
  });
});

describe('joining texts into one message', () => {
  it('leaves out the missing ones, and gives nothing when all are', () => {
    expect(joined('a', undefined, '', 'b')).toBe('a\n\nb');
    expect(joined(undefined, '')).toBe(undefined);
  });
});
