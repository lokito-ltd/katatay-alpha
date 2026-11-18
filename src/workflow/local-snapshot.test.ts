import { publishSnapshot, readNamedSnapshot, readSnapshot } from './local-snapshot.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
// Control just the UUID and link operation for deterministic collision and
// filesystem-error tests. All bytes and directory entries are real.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const branch = 'feat/x';
const now = new Date('2026-11-03T12:34:56.789Z');
const kind = { folder: 'triage', extension: 'json', label: 'triage' };
const bytes = Buffer.from('snapshot bytes');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'local-snapshot-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const save = () => publishSnapshot(branch, kind, bytes, root, now);
const read = (ref: string) => readSnapshot(branch, kind, ref, root);

it('publishes and reads when Git ignores, leaves untracked, or tracks the destination', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  const ref = save();
  expect(git('ls-files', '--others', '--exclude-standard')).toContain(ref);
  writeFileSync(join(root, '.gitignore'), '/.katatay/local/\n');
  expect(git('check-ignore', ref).trim()).toBe(ref);
  expect(save()).toEqual(ref);
  git('add', '-f', ref);
  expect(git('ls-files', ref).trim()).toBe(ref);
  expect(read(save())).toEqual(bytes);
});

it('rejects changed bytes and never overwrites a conflicting destination', () => {
  const ref = save();
  const path = join(root, ref);
  writeFileSync(path, 'corrupt');
  expect(() => read(ref)).toThrow('SHA-256 digest mismatch');
  expect(() => save()).toThrow('Conflicting snapshot');
  expect(readFileSync(path, 'utf8')).toBe('corrupt');
  expect(readdirSync(dirname(path))).toEqual([basename(path)]);
});

it('rejects a valid file under another branch, an escaping path and a symbolic link', () => {
  const ref = save();
  for (const invalid of [ref.replace('feat_x', 'peer_x'), '../' + ref, ref + '\n']) {
    expect(() => read(invalid)).toThrow('invalid triage reference');
  }
  const path = join(root, ref);
  const bytes = readFileSync(path);
  rmSync(path);
  writeFileSync(join(root, 'outside'), bytes);
  symlinkSync(join(root, 'outside'), path);
  expect(() => read(ref)).toThrow('not a regular file');
  expect(() => save()).toThrow('not a regular file');
});

it('does not create children through a directory symlink', () => {
  mkdirSync(join(root, '.katatay'));
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(root, '.katatay/local'), 'dir');
  expect(() => save()).toThrow('directory');
  expect(existsSync(join(root, 'outside', 'feat_x'))).toBe(false);
});

it.each(['.', '..', ''])('refuses an unsafe branch directory %j', branchName => {
  expect(() => publishSnapshot(branchName, kind, bytes, root, now)).toThrow('Invalid branch directory');
});

it('does not recreate directories when reading a missing snapshot', () => {
  const ref = save();
  rmSync(join(root, '.katatay'), { recursive: true });
  expect(() => read(ref)).toThrow();
  expect(readdirSync(root)).toEqual([]);
});

it('keeps both pre-existing temporary and bare UUID files intact', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const dir = join(root, '.katatay/local/feat_x/triage');
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, uuid + '.tmp');
  writeFileSync(temp, 'another writer');
  vi.mocked(randomUUID).mockReturnValueOnce(uuid);
  expect(save).toThrow(/EEXIST/);
  expect(readdirSync(dir)).toEqual([uuid + '.tmp']);
  expect(readFileSync(temp, 'utf8')).toBe('another writer');

  rmSync(temp);
  writeFileSync(join(dir, uuid), 'independent file');
  vi.mocked(randomUUID).mockReturnValueOnce(uuid);
  expect(read(save())).toEqual(bytes);
  expect(readFileSync(join(dir, uuid), 'utf8')).toBe('independent file');
});

it('reports a publication error and removes its temporary file', () => {
  const failure = Object.assign(new Error('links denied'), { code: 'EPERM' });
  vi.mocked(linkSync).mockImplementationOnce(() => { throw failure; });
  expect(save).toThrow(failure);
  expect(readdirSync(join(root, '.katatay/local/feat_x/triage'))).toEqual([]);
});

it('names the snapshot by its label and reference when it is altered or missing', () => {
  const ref = save();
  expect(readNamedSnapshot(branch, kind, ref, root)).toEqual(bytes);
  writeFileSync(join(root, ref), 'corrupt');
  expect(() => readNamedSnapshot(branch, kind, ref, root)).toThrow(new Error(`triage (${ref}): SHA-256 digest mismatch`));
  rmSync(join(root, ref));
  expect(() => readNamedSnapshot(branch, kind, ref, root)).toThrow(`triage (${ref}): ENOENT`);
});
