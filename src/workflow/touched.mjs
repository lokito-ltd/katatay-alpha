/**
 * The lines a change touched: added or changed since its baseline.
 *
 * Both halves of the test-quality report ask about these lines and no others.
 * Mutation plants its bugs in them (`../evidence/mutants.ts`), and coverage
 * says which of them no test runs (`./coverage.mjs`). Old code is not asked
 * about, so the report follows the size of the change and asks for no
 * clean-up, the way the coverage minimums leave old code alone.
 *
 * The lines come from the diff against the pinned baseline, never from the
 * plan, because the diff is what happened.
 *
 * `.mjs` and in the workflow folder, so the turn-end moment can call it in
 * process; `mutants.ts` imports it from the TypeScript side.
 */
import { gitLines, gitText } from './git.mjs';

/**
 * A run of touched lines, `[start, end]` and both included, or a whole file
 * when `lines` is absent.
 *
 * @typedef {{ file: string, lines?: [number, number] }} Target
 */

/**
 * The touched ranges in `diff`, the output of `git diff -U0` against the
 * baseline, for each file `keep` accepts.
 *
 * With no context lines, every hunk header names exactly the lines that are
 * new on this side. A hunk with a count of zero only deleted lines. Nothing
 * new is there, so it gives nothing. A deleted file's header reads
 * `+++ /dev/null`, which no path matches.
 *
 * `untracked` are files git has not been told about. `git diff` never mentions
 * them, and a brand-new module is exactly the code that most needs its tests
 * checked, so each counts whole.
 *
 * @param {string} diff
 * @param {string[]} untracked
 * @param {(file: string) => boolean} keep
 * @returns {Target[]}
 */
export function touchedTargets(diff, untracked, keep) {
  const targets = [];
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : null;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || file === null || !keep(file)) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    targets.push({ file, lines: [start, start + count - 1] });
  }
  return [...targets, ...untracked.filter(keep).map((file) => ({ file }))];
}

/**
 * `touchedTargets` for the working tree under `cwd` against `base`, the
 * baseline sha the logbook pins. A file deleted since then gives nothing, and git
 * lists only untracked files that exist, so every target is on disk.
 *
 * `--no-color`, `--no-ext-diff` and the two prefixes because the parser reads
 * git's own format, and a user's `color.diff = always`, a diff driver, or
 * `diff.noprefix` or `diff.mnemonicPrefix` would each change it.
 *
 * @param {string} base
 * @param {string} cwd
 * @param {(file: string) => boolean} keep
 * @returns {Target[]}
 */
export function touchedFiles(base, cwd, keep) {
  const diff = gitText(['diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base], { cwd });
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'], { cwd });
  return touchedTargets(diff, untracked, keep);
}
