/**
 * The files an `apply_patch` call writes, read from the patch's headers.
 *
 * Codex sends the whole patch as `tool_input.command`. A captured call on
 * 2026-10-29 (see `tests/fixtures/codex/README.md`) looked like this:
 *
 *     *** Begin Patch
 *     *** Update File: a.txt
 *     @@
 *     -one
 *     +uno
 *     *** Update File: b.txt
 *     *** Move to: c.txt
 *     @@
 *     -two
 *     +two
 *     *** Delete File: notes.md
 *     *** End Patch
 *
 * One call can touch several files, so it becomes one write per file. Only the
 * headers matter here. The hunks say what changes inside a file, and the
 * referee decides on files.
 *
 * A move is two writes: the new path, and a delete of the old one. Moving a
 * requirement file out of the requirements folder removes it from there, and
 * the referee refuses a delete under that folder. Reported as an update, the
 * move would get past that rule.
 */
import { isAbsolute, resolve } from 'node:path';

/** A header line: its kind, then the path. Codex writes one space after the colon. */
const HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/;

/**
 * The writes in a patch, in the order the patch names them, each
 * `{ path, delete }` with the path absolute.
 *
 * Returns an empty list when the patch names no file. The caller denies that,
 * because a patch the gate cannot read is not one it can allow.
 *
 * @param {string} patch the patch, as `tool_input.command` holds it
 * @param {string} cwd the directory Codex resolves relative paths against, the payload's `cwd`
 * @returns {{ path: string, delete: boolean }[]}
 */
export function patchWrites(patch, cwd) {
  const writes = [];
  const at = (path) => (isAbsolute(path) ? path : resolve(cwd, path));
  for (const line of patch.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header === null) continue;
    const [, kind, raw] = header;
    const path = at(raw.trim());
    if (kind === 'Move to') {
      // The file being moved is the update just before this header. It is no
      // longer written where it was: it leaves that path.
      const moved = writes.at(-1);
      if (moved !== undefined) moved.delete = true;
      writes.push({ path, delete: false });
    } else {
      writes.push({ path, delete: kind === 'Delete File' });
    }
  }
  return writes;
}
