/** Baseline identities come from the frozen suite at triage. Grouping by file
 * keeps the local snapshot readable and preserves the exact reporter titles. */
import type { TestRun } from './test-run.js';

export interface TestList {
  tests: { file: string; titles: string[] }[];
  unlisted: string[];
}

function titlesFor(groups: Map<string, Set<string>>, file: string): Set<string> {
  let titles = groups.get(file);
  if (!titles) {
    titles = new Set();
    groups.set(file, titles);
  }
  return titles;
}

export function testListOf(run: Pick<TestRun, 'cases' | 'leftOut'>): TestList {
  const groups = new Map<string, Set<string>>();
  for (const c of run.cases) titlesFor(groups, c.file).add(c.name);
  return {
    tests: [...groups.keys()].sort().map(file => ({ file, titles: [...groups.get(file)!].sort() })),
    unlisted: [...new Set(run.leftOut.map(f => f.file))].sort(),
  };
}

/**
 * Lines changed in one file since the baseline: a run of new lines, both ends
 * included, or a deletion that removed lines after line `after`.
 */
export type Change = { from: number; to: number } | { after: number };

/**
 * The changes in `diff`, the output of `git diff -U0` against the baseline,
 * for each file `keep` accepts.
 *
 * `touchedTargets` in `../workflow/touched.mjs` reads the same format and
 * drops a hunk that only deleted lines, because no new line is there to
 * cover or mutate. A deletion inside a test still modifies the test, so it is
 * kept here, as the line it follows.
 */
export function changedLinesOf(diff: string, keep: (file: string) => boolean): Map<string, Change[]> {
  const changes = new Map<string, Change[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : null;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || file === null || !keep(file)) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const change: Change = count === 0 ? { after: start } : { from: start, to: start + count - 1 };
    changes.set(file, [...(changes.get(file) ?? []), change]);
  }
  return changes;
}

/** Whether a change falls inside the lines `line` to `end`. A deletion after
 *  the test's last line, or before its first, does not. */
const inside = (change: Change, line: number, end: number): boolean =>
  'after' in change ? line <= change.after && change.after < end : change.from <= end && line <= change.to;

export interface TestCount {
  added: number;
  modified: number;
  removed: number;
}

/**
 * Tests added, modified and removed since the baseline.
 *
 * A test in the run and not in the list was added; one in the list and not in
 * the run was removed. One in both was modified when a line it spans changed,
 * from the reporter's line ranges. A test the reporter gave no range for is
 * counted as unmodified, since nothing says which lines are its own. A renamed
 * test reads as one removed and one added.
 *
 * A file the triage's run left out has no tests in the list. A test in it
 * counts as added only when the file is new since the baseline
 * (`existedAtBaseline`), and as modified or not by its lines otherwise.
 */
export function countTests(
  list: TestList,
  run: Pick<TestRun, 'cases'>,
  changed: Map<string, Change[]>,
  existedAtBaseline: (file: string) => boolean,
): TestCount {
  const before = new Map(list.tests.map(({ file, titles }) => [file, new Set(titles)]));
  const unlisted = new Set(list.unlisted);
  const now = new Map<string, Set<string>>();
  let added = 0;
  let modified = 0;
  for (const c of run.cases) {
    const titles = titlesFor(now, c.file);
    if (titles.has(c.name)) continue;
    titles.add(c.name);
    if (!before.get(c.file)?.delete(c.name) && !(unlisted.has(c.file) && existedAtBaseline(c.file))) {
      added += 1;
      continue;
    }
    const { line, endLine } = c;
    if (line !== undefined && endLine !== undefined && (changed.get(c.file) ?? []).some((ch) => inside(ch, line, endLine))) {
      modified += 1;
    }
  }
  const removed = [...before.values()].reduce((count, remaining) => count + remaining.size, 0);
  return { added, modified, removed };
}
