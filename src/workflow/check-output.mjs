/**
 * Evidence written by the referee after a check. A tool's stdout may be input
 * to an analysis, as LCOV is; the output file holds the completed result.
 * Consumers never recreate evidence by running a command while displaying it.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { outputPath, readConfig, TargetError } from './rulebook.mjs';
import { gitText } from './git.mjs';
import { checkDocument } from './result-format.mjs';
import { current } from './state.mjs';

/** The existing tree and state readers use the process's repository. This
 * synchronous scope also lets standalone callers supply a fixture root. */
export function inRoot(root, read) {
  const cwd = process.cwd();
  try { process.chdir(root); return read(); } finally { process.chdir(cwd); }
}

/** No source is ever removed or overwritten, including ignored-but-tracked
 * files. Reject symlinks in any component rather than following one on write. */
export function checkedOutput(file, root = process.cwd()) {
  outputPath(file);
  const parts = file.split('/');
  let at = resolve(root);
  for (const part of parts) {
    at = join(at, part);
    try {
      const stat = lstatSync(at);
      if (stat.isSymbolicLink()) throw new TargetError(`check output ${file}: a path component is a symbolic link`);
      if (at === join(resolve(root), file) && !stat.isFile()) throw new TargetError(`check output ${file}: the destination is not a file`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (gitText(['ls-files', '--cached', '--', file], { cwd: root }).trim()) {
    throw new TargetError(`check output ${file}: git tracks this file; output must be ignored and untracked`);
  }
  try { gitText(['check-ignore', '--quiet', '--', file], { cwd: root }); }
  catch { throw new TargetError(`check output ${file}: output must be ignored by git`); }
  return join(root, file);
}

export function invalidateOutput(check, root = process.cwd()) {
  if (check.output) rmSync(checkedOutput(check.output, root), { force: true });
}

/** The rulebook is outside the tree fingerprint, so it needs its own digest.
 * A missing merge base is ordinary for a new standalone repository: folder
 * checking can work there, but touched-line evidence cannot be invented. */
export function checkIdentity(root = process.cwd()) {
  return inRoot(root, () => {
    const config = readConfig(root);
    const state = current();
    if (state.phase === 'broken') throw new TargetError('check output: the workflow logbook is broken');
    let baseline = state.baseline;
    if (!baseline) {
      try { baseline = gitText(['merge-base', 'HEAD', config.targetBranch]).trim(); }
      catch { baseline = null; }
    }
    if (!state.rulebookFingerprint) throw new TargetError('check output: the rulebook cannot be read');
    return { treeFingerprint: state.treeFingerprint, baseline, rulebook: state.rulebookFingerprint };
  });
}

const sameIdentity = (a, b) => a?.treeFingerprint === b.treeFingerprint && a?.baseline === b.baseline && a?.rulebook === b.rulebook;

/** Refuses a result about an identity that changed while the check ran. */
export function assertSameIdentity(check, identity, root = process.cwd()) {
  if (!sameIdentity(identity, checkIdentity(root))) throw new TargetError(`${check.name}: the tree, baseline or rulebook changed during the check`);
}

/** The text of a completed result: the working output file holds it, and a
 * verification's coverage analysis snapshot holds the same bytes. */
export function checkOutputDocument(check, result, measurement) {
  return JSON.stringify(checkDocument(check.name, result, measurement)) + '\n';
}

/** Publish only a complete result about the identity captured before running.
 * The temporary file is a sibling so rename is atomic on the same filesystem.
 * Nothing reads this file back as evidence: it is the working copy a person
 * or a tool may open. What a verification measured is in its snapshots. */
export function saveCheckOutput(check, result, identity, root = process.cwd(), coverage) {
  if (!check.output) return;
  assertSameIdentity(check, identity, root);
  const at = checkedOutput(check.output, root);
  mkdirSync(dirname(at), { recursive: true });
  const temporary = `${at}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, checkOutputDocument(check, result, coverage), { flag: 'wx' });
    checkedOutput(check.output, root);
    renameSync(temporary, at);
  } finally { rmSync(temporary, { force: true }); }
}
