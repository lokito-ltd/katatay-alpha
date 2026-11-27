import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterRepository, repositoryRoot } from './io.mjs';

const start = process.cwd();
afterEach(() => process.chdir(start));

const repository = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-io-')));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'packages/app'), { recursive: true });
  return root;
};

it('finds the repository from a folder inside it, and none outside one', () => {
  const root = repository();
  expect(repositoryRoot(join(root, 'packages/app'))).toBe(root);
  expect(repositoryRoot(realpathSync(tmpdir()))).toBeNull();
});

it('moves to the repository of the first workspace root, then of CURSOR_PROJECT_DIR, then of its own folder', () => {
  const root = repository();
  expect(enterRepository(['', join(root, 'packages/app')], {})).toBe(root);
  process.chdir(start);
  expect(enterRepository(undefined, { CURSOR_PROJECT_DIR: join(root, 'packages') })).toBe(root);
  process.chdir(join(root, 'packages/app'));
  expect(enterRepository('nope', {})).toBe(root);
});

it('stays put when the workspace root is gone', () => {
  expect(enterRepository(['/no/such/folder/anywhere'], {})).toBe(start);
});

it('skips a workspace root that is not a string', () => {
  const root = repository();
  expect(enterRepository([3, join(root, 'packages/app')], {})).toBe(root);
});
