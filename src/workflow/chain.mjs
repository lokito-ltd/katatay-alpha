/**
 * The event chain: an append-only, per-branch, hash-linked logbook under
 * `.katatay/state/<branch>/`.
 *
 * One event per file, numbered. Using a file per event, rather than lines in one
 * logbook, makes the protection rule simple to state and so simple to enforce: no
 * write to a path that already exists. "Append but never rewrite" is a property
 * of an operation. "This file already exists" is a property of the filesystem,
 * and only the second can be checked before the write happens.
 *
 * `prev` links each file to the bytes of the one before it. It catches exactly
 * one thing: a lazy rewrite, where an event is edited or removed and the ones
 * after it are left alone. The hash is not a secret, so anyone editing event N
 * can recompute N+1 onwards. The genesis event has no predecessor and can be
 * rewritten with nothing to notice. An event appended at the end is trivially
 * well-formed. Hashing cannot fix any of that inside one user account, where
 * the hook, the tool and the agent's shell are the same principal.
 *
 * Two other things carry the weight. The agent may not write here at all
 * (`.katatay/` is one of the referee's locks, in `locks.mjs`), and these files are committed, so
 * `alteredStateFiles` in `tree.mjs` can hold the logbook against git. Any forgery
 * that survives both is a line in the diff the operator reviews.
 */
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { validateEvent, validateStoredEvent } from './event-format.mjs';
export { EVENTS } from './event-format.mjs';
import { gitText } from './git.mjs';
import { STATE_FOLDER } from './folder.mjs';

export const STATE_ROOT = `${STATE_FOLDER}/state`;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Stable stringify, so a payload hash does not depend on key insertion order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const hashPayload = (payload) => sha256(canonical(payload));

/**
 * Branch name → directory name.
 *
 * Two branch names can sanitise to the same directory: `feat/x` and `feat_x`
 * both land on `feat_x`. A hash suffix would fix that and make the directory
 * name unreadable. Instead the real branch name is recorded in the first event,
 * and `readChain` refuses a chain whose recorded branch is not the current one.
 * A collision becomes a loud error instead of two branches quietly sharing a
 * logbook.
 *
 * The same name used twice is not a collision and this check will not fire on
 * it: the branch really is the one recorded. Two changes sharing one logbook is the
 * intended shape there, and which of them is live is settled by `epoch` in
 * `phase.mjs`.
 */
export const slugFor = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, '_');

export const currentBranch = () => gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

export const dirFor = (branch) => join(STATE_ROOT, slugFor(branch));

const FILENAME_RE = /^(\d{4})__([a-z_]+)\.json$/;

/**
 * The file an event was written to, derived from the event itself.
 *
 * A caller that has entries and wants to match them against paths git reports —
 * which is how a merged event is recognised — would otherwise have to restate
 * the naming convention. Restating it puts a second copy of the rule next to
 * `append`, free to drift from the one that does the writing.
 */
export const fileFor = ({ seq, event }) => `${String(seq).padStart(4, '0')}__${event}.json`;

/** @returns {{ entries: object[], broken: string|null }} */
export function readChain(dir, branch = null) {
  if (!existsSync(dir)) return { entries: [], broken: null };

  // Something is at the logbook's path that cannot be listed: most likely a file
  // where the folder should be. That is a broken logbook, said as one. It used to
  // throw from here, so `state:show` and `state:verify` crashed on it, and the
  // gate, which then allowed whatever it could not judge, let the edit
  // through.
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
  } catch (failure) {
    return { entries: [], broken: `${dir} cannot be read as a folder (${failure.code ?? failure.message}) — something else is where the logbook should be` };
  }

  const entries = [];
  let prevHash = null;
  for (const [index, item] of names.entries()) {
    const file = item.name;
    try {
      if (!item.isFile() || !FILENAME_RE.test(file)) throw new Error('is not a numbered event file (NNNN__event.json)');
      const bytes = readFileSync(join(dir, file));
      let entry;
      try {
        entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Error('is not readable as JSON');
      }
      validateStoredEvent(entry, index + 1);
      if (fileFor(entry) !== file) throw new Error(`does not match its contents; expected ${fileFor(entry)}`);
      if (entry.prev !== prevHash) throw new Error('does not link to the event before it — history was edited or removed');
      if (index === 0) checkOwner(dir, entry.branch, branch);
      entries.push(entry);
      prevHash = sha256(bytes);
    } catch (error) {
      return { entries, broken: `${file}: ${error.message}` };
    }
  }
  return { entries, broken: null };
}

function checkOwner(dir, owner, branch) {
  if (branch !== null && owner !== branch) throw new Error(`this logbook belongs to branch ${owner}, not ${branch} — the directory names collide`);
  if (slugFor(owner) !== basename(dir)) throw new Error(`branch ${owner} belongs in ${slugFor(owner)}, not ${basename(dir)}`);
}

/**
 * The logbook directory and its two ancestors, created on demand.
 *
 * The steps are derived from the path rather than written as constants, so a
 * caller working against a temporary root — the tests — builds the same shape
 * as the repository does.
 */
function ensureDir(dir) {
  for (const step of [dirname(dirname(dir)), dirname(dir), dir]) {
    if (!existsSync(step)) mkdirSync(step);
  }
}

/**
 * Append one event. Refuses if the chain is broken, or if the file it would
 * write already exists. Those are the two ways an append could quietly become a
 * rewrite.
 *
 * @param {string} dir
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 * @param {string|null} [branch]
 * @param {number} [expectedLength]
 */
export function append(dir, event, payload = {}, branch = null, expectedLength = undefined) {
  const { entries, broken } = readChain(dir, branch);
  if (broken) throw new Error(`refusing to append to a broken chain: ${broken}`);

  if (expectedLength !== undefined && entries.length !== expectedLength) throw new Error('The logbook changed during submission. Retry with the current receipt.');
  const seq = entries.length + 1;
  const prev = entries.length === 0
    ? null
    : sha256(readFileSync(join(dir, fileFor(entries[seq - 2]))));

  const record = { version: HARNESS_SCHEMA_VERSION, seq, prev, ts: new Date().toISOString(), event, payload: structuredClone(payload) };
  if (seq === 1 && branch !== null) record.branch = branch;

  const filename = fileFor(record);
  // Strict: a field no format lists is a writer's typo. Reading ignores it.
  validateEvent(record, seq);
  if (seq === 1) checkOwner(dir, record.branch, branch);
  if (!FILENAME_RE.test(filename)) throw new Error(`cannot append ${filename}: event number exceeds four digits`);
  const bytes = JSON.stringify(record, null, 2) + '\n';
  ensureDir(dir);
  const path = join(dir, filename);
  if (existsSync(path)) throw new Error(`${path} already exists; the chain would be rewritten, not appended`);
  writeFileSync(path, bytes, { flag: 'wx' });
  return record;
}
