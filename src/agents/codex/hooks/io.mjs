/**
 * Stdin and stdout for the Codex hooks.
 *
 * Codex reads one JSON object from a hook's stdout. Each hook builds that
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
 * `src/` goes through the referee's `git.mjs`, so that git's errors are
 * handled one way (see `src/workflow/git.test.mjs`), and these hooks may
 * not import the referee. Looking needs no process at all.
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
 * Moves the hook to the repository Codex is working in, and returns its root.
 *
 * Codex starts a hook in the session's working directory, which may be a
 * subfolder. The referee and the files the hooks read (`.katatay/`,
 * `.codex/hooks.json`) are found from the root, as they are for Claude
 * Code, which always starts its hooks there. Outside a repository the
 * directory is kept, and the referee says what it makes of that.
 *
 * @param {string|undefined} cwd the payload's `cwd`
 */
export function enterRepository(cwd) {
  const from = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  try {
    process.chdir(repositoryRoot(from) ?? from);
  } catch {
    // A directory that is gone. Staying put lets the referee report it.
  }
  return process.cwd();
}

/** Texts joined into one message, the ones that are missing left out. */
export const joined = (...texts) => {
  const present = texts.filter((text) => typeof text === 'string' && text !== '');
  return present.length === 0 ? undefined : present.join('\n\n');
};

/**
 * Writes `output` as the hook's answer and exits with 0, once it has all gone
 * out.
 *
 * A drift warning goes to the operator, at the front of `systemMessage`: a
 * hook that has just noticed Codex changed its payload is reporting on itself,
 * and that outranks what it was going to say. Codex reads a hook's stdout
 * through a pipe, and Node finishes a write to a pipe in the background, so
 * exiting straight after it would keep only what fit in the pipe. A turn-end
 * answer carries the verify tail and can be longer.
 *
 * `null` writes nothing, which Codex reads as "carry on" where an event allows
 * it. Stop does not: it needs JSON, so the turn end passes `{}`.
 *
 * `carry` puts the drift warning somewhere else, for an event that takes no
 * `systemMessage`. Codex fails a hook whose answer has a field its event does
 * not support, and lets the tool call through, so the pre-tool hook must not
 * add one to a denial.
 *
 * @param {object|null} output
 * @param {(out: object|null, warning: string) => object} [carry]
 * @returns {Promise<never>}
 */
export async function leave(output, carry = (out, warning) => ({ ...(out ?? {}), systemMessage: joined(warning, out?.systemMessage) })) {
  const out = hasDrift() ? carry(output, drift()) : output;
  if (out !== null) await new Promise((resolve) => { process.stdout.write(JSON.stringify(out), () => resolve()); });
  process.exit(0);
}
