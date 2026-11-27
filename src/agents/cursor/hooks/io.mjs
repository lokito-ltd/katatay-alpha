/**
 * Stdin and stdout for the Cursor hooks.
 *
 * Cursor reads one JSON object from a hook's stdout. Each hook builds that
 * object and hands it to `leave`, which adds any drift warning, writes it in
 * full and exits.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { drift, hasDrift } from './drift.mjs';

export async function input() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

/**
 * The repository a directory is in: the nearest folder at or above it that
 * holds a `.git`, a folder in a clone and a file in a worktree. Null when
 * there is none.
 *
 * Found by looking, not by running `git rev-parse`. Every git call in
 * `src/` goes through the referee's `git.mjs`, and these hooks may not import
 * the referee. Looking needs no process at all.
 *
 * @param {string} from absolute
 */
export function repositoryRoot(from) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Moves the hook to the repository Cursor is working in, and returns its root.
 *
 * Cursor starts project hooks in the project root, and names it in
 * `workspace_roots` and `CURSOR_PROJECT_DIR`. A workspace opened on a
 * subfolder of a repository still has its logbook at the git root, so the
 * hook moves there. Outside a repository the directory is kept, and the
 * referee says what it makes of that.
 *
 * @param {unknown} workspaceRoots the payload's `workspace_roots`
 */
export function enterRepository(workspaceRoots, env = process.env) {
  const first = Array.isArray(workspaceRoots) ? workspaceRoots.find((root) => typeof root === 'string' && root !== '') : undefined;
  const from = first ?? (env.CURSOR_PROJECT_DIR || process.cwd());
  try {
    process.chdir(repositoryRoot(from) ?? from);
  } catch {
    // A directory that is gone. Staying put lets the referee report it.
  }
  return process.cwd();
}

/**
 * Writes `output` as the hook's answer and exits with 0, once it has all gone
 * out.
 *
 * Cursor reads a hook's stdout through a pipe, and Node finishes a write to a
 * pipe in the background, so exiting straight after it would keep only what
 * fit in the pipe. A turn-end follow-up carries the verify report and can be
 * longer.
 *
 * `carry` puts a drift warning where the event's answer can hold it. Each
 * Cursor event takes different fields.
 *
 * @param {object} output
 * @param {(out: object, warning: string) => object} carry
 * @returns {Promise<never>}
 */
export async function leave(output, carry) {
  const out = hasDrift() ? carry(output, drift()) : output;
  await new Promise((resolve) => { process.stdout.write(JSON.stringify(out), () => resolve()); });
  process.exit(0);
}
