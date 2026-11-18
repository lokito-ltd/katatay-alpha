import type { TestRun } from './test-run.js';

export interface TaggedTest {
  file: string;
  title: string;
  /**
   * Requirement ids named in the title, in order of appearance. A scenario tag
   * counts toward its requirement, so `[AC0009.2]` puts `AC0009` here. Every
   * caller that thinks in requirements, such as the risk report, reads this
   * and never has to know scenarios exist.
   */
  ids: string[];
  /** Scenario ids named in the title, such as `AC0009.2`. */
  scenarios: string[];
  /** Tags that name a requirement and no scenario, such as `[AC0009]`. */
  bare: string[];
  /**
   * Why the test is not evidence, or `null` when it is. Its title and tags are
   * read either way, so a test that does not count still cannot carry a
   * mismatch. See `NotEvidence`.
   */
  notEvidence: NotEvidence | null;
}

/**
 * The reasons a tagged test proves nothing, each with its own message in
 * `req:trace`, so the person reading it looks for the right thing.
 *
 * - `skipped`: the report says it was skipped, as `it.skip` or `it.todo` in
 *   Vitest, or a test that a failing `beforeAll` kept from running.
 * - `inverted`: the reporter says it passes only when its body fails, as Vitest's
 *   `.fails`, so it proves the opposite of its title.
 *
 * A test file the report leaves out is not a reason here: it has no test
 * cases to carry one. `req:trace` reports its tags on their own. See
 * `LeftOutFile` in `test-run.ts`.
 */
export type NotEvidence = 'skipped' | 'inverted';

const TAG = /\[((?:AC|INV)\d{4})(\.\d+)?\]/g;

export const idsIn = (text: string): string[] =>
  [...new Set([...text.matchAll(TAG)].map((m) => m[1]!))];

export const scenariosIn = (text: string): string[] =>
  [...text.matchAll(TAG)].filter((m) => m[2]).map((m) => `${m[1]}${m[2]}`);

export const bareIdsIn = (text: string): string[] =>
  [...text.matchAll(TAG)].filter((m) => !m[2]).map((m) => m[1]!);

/** A title with its tags taken out: the words a scenario's text must match. */
export const withoutTags = (title: string): string => title.replace(TAG, '');

/** The separators in front of which a report puts the names of the groups
 *  around a test: `>` in Vitest and Jest, `/` in Go, `::` in pytest and Rust. */
const GROUP_SEPARATOR = /\s*(?:>|\/|::)\s*/g;

/**
 * A test's name, then the same name with the group names in front taken off
 * one at a time, as `a > b > title` gives `a > b > title`, `b > title` and
 * `title`. Only whole groups fall away, at a separator, so the leading words
 * of the title itself never do.
 */
export function groupSuffixes(name: string): string[] {
  const forms = [name.trim()];
  for (const match of name.matchAll(GROUP_SEPARATOR)) {
    const rest = name.slice(match.index! + match[0].length).trim();
    if (rest !== '') forms.push(rest);
  }
  return [...new Set(forms)];
}

/**
 * Text as the words it holds, for comparing a test's name with its scenario.
 * Case is ignored. Apostrophes are dropped, so `proposal's` and `proposals`
 * are the same word. Any other character that is not a letter or a digit, `_`
 * included, counts as a space, so punctuation and backticks are ignored.
 * camelCase is not split, because a scenario may hold a camelCase word of its
 * own: `startProject` stays one word, and so does `startproject`.
 */
export const words = (text: string): string =>
  text.toLowerCase().replace(/['\u2018\u2019]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether a test's name says its scenario's text, word for word, compared by
 * `words`. Its tags are taken out first, and the group names in front of it
 * may fall away (`groupSuffixes`), so `area > A rejected proposal is gone`
 * matches `A rejected proposal is gone`, and `Not a rejected proposal is gone`
 * never does.
 *
 * Looser than the rule before it, which compared the text with only
 * whitespace and backticks evened out. A test name is written in a language's
 * strings, and a runner may add to it: Go turns spaces into `_`, pytest names
 * are identifiers. Comparing words keeps the point, the same claim at both
 * ends, without holding a scenario to one language's spelling.
 */
export function sameWords(name: string, scenario: string): boolean {
  const target = words(scenario);
  return groupSuffixes(withoutTags(name)).some((form) => words(form) === target);
}

/**
 * The tagged tests in a run: every test case that carries a tag, read from its
 * name, the reporter's `scenario` property or the comment above it. See `TestCase`
 * in `test-run.ts`.
 */
export function taggedTests(run: TestRun): TaggedTest[] {
  return run.cases.flatMap((c) => {
    if (c.ids.length === 0) return [];
    return [{
      file: c.file,
      title: c.name,
      ids: c.ids,
      scenarios: c.scenarios,
      bare: c.bare,
      notEvidence: c.status === 'skipped' ? 'skipped' : c.inverted ? 'inverted' : null,
    }];
  });
}

/**
 * Every requirement id a file's tests carry, in the run: from its test cases,
 * or from its whole text when the report left the file out. A failure that
 * stands for the whole file carries these, because any of its tests could be
 * the one that no longer runs. That decides its bucket in the triage.
 */
export const tagsOfFile = (run: TestRun, file: string): string[] => [...new Set([
  ...run.cases.filter((c) => c.file === file).flatMap((c) => c.ids),
  ...run.leftOut.filter((f) => f.file === file).flatMap((f) => f.ids),
])];

/** Every scenario id a file's tests carry, in the run, read as `tagsOfFile`
 *  reads requirement ids. A prediction by scenario matches a whole-file
 *  failure through these. */
export const scenariosOfFile = (run: TestRun, file: string): string[] => [...new Set([
  ...run.cases.filter((c) => c.file === file).flatMap((c) => c.scenarios),
  ...run.leftOut.filter((f) => f.file === file).flatMap((f) => f.scenarios),
])];
