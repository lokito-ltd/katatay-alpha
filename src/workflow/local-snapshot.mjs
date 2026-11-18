import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugFor } from './chain.mjs';
import { STATE_FOLDER } from './folder.mjs';

export const approvedPlans = { folder: 'plans', extension: 'md', label: 'approved plan' };
/** The agent's full checks analysis, with the evidence list the referee
 * appends. The logbook keeps only its summary and this file's reference. */
export const checksAnalyses = { folder: 'checks-analysis', extension: 'txt', label: 'checks analysis' };
/** The full change report a `record` decision was made on. The `declared`
 * and `record_held` events keep only this file's reference. */
export const changeReports = { folder: 'change-report', extension: 'json', label: 'change report' };

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('base64url');
function folderFor(branch, kind) {
  const slug = slugFor(branch);
  if (!slug || slug === '.' || slug === '..') throw new Error('Invalid branch directory');
  return `${STATE_FOLDER}/local/${slug}/${kind.folder}`;
}

/** Check each component before using it. In particular, recursive mkdir on
 * an existing symlink could otherwise create directories outside the repo. */
function directory(root, folder, create) {
  let at = root;
  for (const part of folder.split('/')) {
    at = join(at, part);
    if (create) mkdirSync(at, { recursive: true });
    if (!lstatSync(at).isDirectory()) throw new Error(`${at} is not a directory or is a symbolic link`);
  }
  return at;
}

function readRegular(path) {
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
  return readFileSync(path);
}

export function publishSnapshot(branch, kind, bytes, root = process.cwd(), now = new Date()) {
  const folder = folderFor(branch, kind);
  const dir = directory(root, folder, true);
  const stamp = now.toISOString().replace(/[-:]/g, '');
  const name = `${stamp}_${digestOf(bytes)}.${kind.extension}`;
  const path = join(dir, name);
  const temp = join(dir, randomUUID() + '.tmp');
  // Publishing a hard link exposes all bytes at once and never replaces an
  // existing snapshot, even if another writer finishes in the same ms.
  writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    try { linkSync(temp, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!readRegular(path).equals(bytes)) throw new Error(`Conflicting snapshot at ${path}`);
    }
  } finally { unlinkSync(temp); }
  return folder + '/' + name;
}

export function readSnapshot(branch, kind, reference, root = process.cwd()) {
  const folder = folderFor(branch, kind);
  const name = reference.slice(folder.length + 1);
  const match = /^(\d{8}T\d{6}\.\d{3}Z)_([\w-]{43})\.(\w+)$/.exec(name);
  if (reference !== folder + '/' + name || !match || match[0] !== name || match[3] !== kind.extension) {
    throw new Error(`invalid ${kind.label} reference`);
  }
  const bytes = readRegular(join(directory(root, folder, false), name));
  if (digestOf(bytes) !== match[2]) throw new Error('SHA-256 digest mismatch');
  return bytes;
}

/** `readSnapshot`, with a failure naming the snapshot as `label (reference)`,
 * so the operator knows which file to restore. A digest mismatch says nothing
 * about where the file is. */
export function readNamedSnapshot(branch, kind, reference, root = process.cwd()) {
  try { return readSnapshot(branch, kind, reference, root); }
  catch (error) { throw new Error(`${kind.label} (${reference}): ${error.message}`); }
}
