/**
 * What counts as a test file, and which of them this branch has touched.
 *
 * The freeze exists so a triage sees what the implementation actually broke. If
 * the tests could be edited first, "the suite is green" would say nothing about
 * the code, only about how the tests were adjusted to fit it.
 *
 * The rule for *what a test is* lives here, and the evidence tools import it
 * rather than restating it. Two matchers that were supposed to agree have
 * quietly drifted apart twice in this repository already. A second copy of the
 * test-path rule would be the third time.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { isChangeFile, leftOut } from './tree.mjs';
import { gitLines, gitText } from './git.mjs';
import { target } from './target.mjs';
import { matchesCode, frozenFileMatcher, matchesTests, readAdapter } from './adapter.mjs';
import { allChecks, readChecks } from './rulebook.mjs';

/**
 * Whether a file holds tests.
 *
 * The rule is the `tests.paths.all` globs in
 * `.katatay/rulebook.json`, because which files hold tests is the language's
 * business: `*.test.ts` here, `test_*.py` or `*_test.go` elsewhere. It used to
 * be a regular expression in this file, `*.test.(ts|tsx|mjs)`. It is still
 * asked here and nowhere else, so the freeze, `req:trace` and the coverage
 * check cannot disagree about it.
 *
 * Throws an `AdapterError` when the section is missing. A freeze that guessed
 * which files are tests could guess too few.
 *
 * @param {string} file a path relative to the repository root
 */
export const isTest = (file) => matchesTests(file);

/**
 * Whether the freeze covers a file: every test file, every file the
 * rulebook's `tests.paths.support` globs name.
 *
 * Test files alone were not enough. The 2026-10-04 red-team pass edited a
 * schema fixture of the acceptance tests during implementation, and a real
 * regression went green: the triage said LOW, verify passed, and nothing asked
 * anyone to look. A fixture, a shared test helper or a test server decides
 * what a test proves as much as the test does, so editing one before the
 * triage is the same act as editing a test.
 *
 * `isTest` keeps its narrower meaning, "this file holds tests", because
 * `req:trace`, the test run and the coverage check ask that question and not
 * this one.
 *
 * A project's support globs can also cover the machine harness and hook
 * fixtures: changing what the harness sends can hide a broken hook.
 *
 * @param {string} file a path relative to the repository root
 */
export const isFrozen = (file) => frozenFileMatcher()(file);

/**
 * What the freeze covers, as one sentence for a message, from the rulebook's
 * own globs.
 *
 * The messages used to say "every file under `tests/`", which is this
 * repository's `tests.paths.support` value written into the referee. Another project
 * keeps its fixtures elsewhere, and would be told a rule that is not its own.
 * With no `tests.paths.support` globs, only the test files are named.
 */
export function describeFreeze() {
  const { tests, testSupport } = readAdapter();
  const quoted = (globs) => globs.map((glob) => `\`${glob}\``).join(', ');
  const files = `Every test file (${quoted(tests.all)})`;
  if (!testSupport.length) return `${files} is frozen until the triage has run.`;
  return `${files} and every test support file (${quoted(testSupport)}) are frozen until the triage has run.`;
}

/**
 * Whether a file is code: what coverage measures and mutation testing plants
 * bugs in. The adapter's `code` globs, JavaScript and TypeScript in any of
 * their extensions here. It used to be the regular expression `MEASURABLE`.
 *
 * @param {string} file a path relative to the repository root
 */
export const isCode = (file) => matchesCode(file);

const git = (args) => gitLines(args);

/**
 * Files this change has altered against its baseline — modified, added or
 * deleted alike, and untracked files with them.
 *
 * `base` is the baseline sha from the logbook (`baselineOf` in `phase.mjs`). Without
 * an approved change, the caller uses the target's remote-tracking ref. Measuring from the pinned sha
 * instead is what keeps tests the target gained after the branch was cut out of
 * this change, and what keeps a moved ref from emptying the freeze.
 *
 * Untracked counts. `git diff` never mentions a file git has not been told
 * about, and a brand-new test written beside the code it covers is exactly what
 * would otherwise slip past the freeze. A brand-new module is likewise part of
 * what the change altered, for the review areas.
 *
 * This used to exist twice, here and in `src/evidence/files.ts`, character for
 * character. Every caller imports it from here, the same way they import
 * `isTest`, because two tools disagreeing about what this branch changed is
 * the failure this file's header is about.
 *
 * @param {string|null} [base]
 */
export function changedFiles(base = null) {
  return branchChanges(base).changed;
}

/**
 * `changedFiles` and `addedFiles` together, from one diff against the baseline
 * instead of one each.
 *
 * `--name-status` gives both answers in one call: every path it lists has
 * changed, and the ones marked `A` were added. A rename line names the old path
 * and the new one, and only the new one is reported, marked `R` rather than `A`.
 * That is exactly what `--name-only` and `--diff-filter=A` gave as two calls.
 *
 * The check that the base exists runs only when the diff fails. It used to run
 * first, every time, to tell a missing base from any other failure. Asked
 * afterwards, it still tells them apart: a missing base answers empty, as it
 * did, and a diff that fails on a base that is there still throws.
 *
 * Measured on 2026-10-04, the review areas in `state:show` and the turn-end hook
 * asked for both lists in seven git calls. This takes three.
 *
 * @param {string|null} [base]
 * @returns {{ changed: string[], added: string[] }}
 */
export function branchChanges(base = null) {
  const from = base ?? target().ref;
  const status = againstBase(from);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const paths = status.map((line) => line.split('\t').at(-1));
  const added = status.filter((line) => line.startsWith('A\t')).map((line) => line.split('\t').at(-1));
  return {
    changed: [...new Set([...paths, ...git(['diff', '--name-only']), ...untracked])],
    added: [...new Set([...added, ...untracked])],
  };
}

/** `git diff` against the base, `--name-status` unless told otherwise, or
 *  nothing when there is no base to compare against. */
function againstBase(from, options = ['--name-status'], paths = []) {
  try {
    return gitLines(['diff', ...options, from, ...paths]);
  } catch (failure) {
    try {
      gitText(['rev-parse', '--verify', `${from}^{commit}`]);
    } catch {
      return []; // Nothing to compare against, so nothing can be said to have changed.
    }
    throw failure;
  }
}

/**
 * The files `changedFiles` would list that did not exist at the baseline: added
 * on the branch, or untracked. Everything else in that list was already there,
 * and has been modified, renamed or deleted.
 *
 * The review areas need the difference. A requirement file that already
 * existed and changed may have lost a promise; a new one can only add one. See
 * `REQUIREMENT_PATHS` in `areas.mjs`.
 *
 * `staged` asks the same of the index alone, for a commit message, which is
 * about what the commit holds rather than the whole branch.
 *
 * @param {string|null} [base]
 * @param {{ staged?: boolean }} [options]
 */
export function addedFiles(base = null, { staged = false } = {}) {
  if (staged) return git(['diff', '--cached', '--name-only', '--diff-filter=A']);
  return branchChanges(base).added;
}

/**
 * Files in which this change adds a line holding a coverage ignore comment.
 *
 * The coverage tool does the ignoring. This only notices that a change asked
 * it to. How the comment is spelt is the language's business, so the patterns
 * are the rulebook's `checks.testQuality.coverage.suppressions`. For Vitest those are the four
 * spellings Vitest's provider honours, `v8 ignore`, `c8 ignore`,
 * `istanbul ignore` and `node:coverage ignore`, matched on their first two
 * words so every form is caught. A list that named one spelling would be
 * passed by using another. In Python it would be `pragma: no cover`. They used
 * to be a pattern in this file, which no other language's comments matched.
 *
 * `workflow coverage` holds each folder to a minimum, and there are two
 * ways to stay above one without writing a test: measure fewer files, or mark
 * code as not to be counted. The first is an edit to the coverage tool's
 * config, which a project lists as high-risk. This is the second. It can sit in any product
 * file, in a diff that otherwise looks like ordinary work, so the review areas
 * name the file (see `reviewAreas` in `areas.mjs`).
 *
 * Code files only, and never a test file. Coverage does not measure tests, so
 * a comment in one takes nothing out of the figure. Before this rule, a test
 * that held the string `'v8 ignore'` as test data was listed under "Must look"
 * for no reason, and a list that names files for no reason teaches the
 * reviewer to skip it. This is the rule the coverage check uses for the files
 * it measures (`isCode` and not `isTest`, in `coverage.mjs`). Test support
 * files are not tests by `isTest`, and coverage still measures the code among
 * them, so they stay listed.
 *
 * Added lines only. A comment that was there at the baseline was reviewed when
 * it merged, and listing it again on every change that touches the file would
 * teach the reviewer to skip the reason.
 *
 * It reads the words, not the syntax, so a line that only mentions an ignore
 * comment is listed too. That errs toward listing too much, and the price is a
 * reviewer reading one line. Telling a real hint from a mention would take a
 * parser, and a rule that can be argued with is one that can be slipped past.
 *
 * A file added by this change is read from disk, because every line of it is
 * an added line and `git diff` never mentions an untracked file. `added` is the
 * list `branchChanges` already made, so this costs one git call, not two.
 *
 * `staged` asks the same of the index alone, for a commit message. The index
 * holds its added files, so nothing is read from disk then: the working tree
 * may differ from what the commit will hold.
 *
 * @param {{ base?: string|null, added?: string[], staged?: boolean }} [input]
 * @returns {string[]}
 */
export function addedIgnoreHints(input = {}) {
  return reviewSuppressions(input).ignores;
}

/**
 * Files in which this change adds a line holding one of a check's
 * suppression comments, such as `// eslint-disable-next-line` or `# nosec`,
 * by check: `{ name, files }` for each check in `checks` that lists
 * `suppressions` and gained one, in the rulebook's order.
 *
 * Silencing a check in one spot is the way to weaken it without a failing
 * test, as an ignore comment is for coverage (`addedIgnoreHints`), so the
 * review areas name the file under the check (`reviewAreas` in `areas.mjs`).
 *
 * Every code file counts, tests included, unlike coverage's rule: coverage
 * does not measure tests, but a lint does, so an `eslint-disable` in a test
 * silences it there. Added lines only, read by the words and not the syntax,
 * and new files read whole, for the reasons `addedIgnoreHints` gives.
 *
 * Asks git nothing when no check lists suppressions.
 *
 * @param {{ base?: string|null, added?: string[], staged?: boolean, checks?: { name: string, suppressions: string[] }[] }} [input]
 * @returns {{ name: string, files: string[] }[]}
 */
export function addedSuppressions({ base = null, added = [], staged = false, checks = allChecks(readChecks()) } = {}) {
  const rules = checks.filter((check) => check.suppressions.length > 0).map((check) => {
    const patterns = check.suppressions.map((pattern) => new RegExp(pattern));
    return { name: check.name, measured: check.name === 'coverage' ? (file) => isCode(file) && !isTest(file) : isCode,
      matches: (text) => patterns.some((pattern) => pattern.test(text)) };
  });
  if (rules.length === 0) return [];
  const found = addedMatching({ base, added, staged, rules });
  return rules.filter(({ name }) => found.has(name)).map(({ name }) => ({ name, files: found.get(name) }));
}

/** A single diff scan for the review areas, preserving coverage's own reason
 * and its exclusion of tests. Coverage is selected from the same checks as every other suppression. */
export function reviewSuppressions(input = {}) {
  const checks = input.checks ?? allChecks(readChecks());
  const found = addedSuppressions({ ...input, checks });
  return { ignores: found.find((entry) => entry.name === 'coverage')?.files ?? [],
    suppressed: found.filter((entry) => entry.name !== 'coverage') };
}

/**
 * The files in which this change adds a line a rule matches, by rule name,
 * each list sorted. One `git diff` for every rule. A rule is
 * `{ name, measured(path), matches(text) }`: which files it reads, and what
 * it looks for in an added line.
 *
 * @returns {Map<string, string[]>}
 */
function addedMatching({ base, added, staged, rules }) {
  // Stated outright, so that a `diff.noprefix` or an external diff tool in the
  // operator's git config cannot change what the lines below look like.
  const patch = ['-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
  // Every file is diffed and the code is picked out below, by the adapter's
  // rule. It used to be a git pathspec of JavaScript and TypeScript
  // extensions, which no other language would match.
  const diff = staged
    ? git(['diff', '--cached', ...patch])
    : againstBase(base ?? target().ref, patch);

  const found = new Map(rules.map(({ name }) => [name, new Set()]));
  let reading = [];
  let file = null;
  let header = false;
  for (const line of diff) {
    // A file's header runs from `diff --git` to its first `@@`. Outside it, a
    // line starting `+++` is an added line of code that begins with `++`.
    if (line.startsWith('diff --git ')) {
      header = true;
      file = null;
      reading = [];
    } else if (header && line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      reading = rules.filter((rule) => rule.measured(file));
    } else if (line.startsWith('@@')) {
      header = false;
    } else if (!header && file && line.startsWith('+')) {
      for (const rule of reading) if (rule.matches(line)) found.get(rule.name).add(file);
    }
  }

  if (!staged) {
    for (const path of added) {
      const reading = rules.filter((rule) => rule.measured(path) && !found.get(rule.name).has(path));
      if (reading.length === 0) continue;
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue; // Listed as added and gone since, or a folder: nothing to read.
      }
      for (const rule of reading) if (rule.matches(text)) found.get(rule.name).add(path);
    }
  }
  return new Map([...found].filter(([, files]) => files.size > 0).map(([name, files]) => [name, [...files].sort()]));
}

/**
 * Files under the freeze that this branch has changed. See `isFrozen`.
 *
 * Added counts. Writing a new test during implementation is the thing being
 * prevented, not a loophole in it: a test written next to the code it covers,
 * before anyone has seen what broke, is the same act as editing one.
 *
 * A file is listed when `git diff` says it changed or when its contents say
 * so. See `frozenByContent` for why git's word alone was not enough.
 * @param {string | null} [base] the pinned commit, or the configured target
 */
export const frozenChanges = (base = null) =>
  [...new Set([...changedFiles(base).filter(isFrozen), ...frozenByContent(base ?? target().ref)])].sort();

/** A symbolic link, as `git ls-tree` prints its mode. */
const LINK_MODE = '120000';

/**
 * Frozen files whose contents differ from the baseline, found by reading the
 * files and not by asking `git diff`.
 *
 * `git diff` compares the baseline with the working tree as the index
 * describes it, and the index can be told to stop looking.
 * `git update-index --skip-worktree <file>` marks a file as one git should act
 * as if it had not changed, and `--assume-unchanged` does the same for another
 * purpose. A test marked either way could be edited during implementation and
 * every diff would leave it out, so the freeze saw nothing and the triage ran
 * on a suite that had been adjusted first. Neither flag shows in `git status`.
 *
 * So the question is put to the contents. `ls-tree` gives the blob id of every
 * frozen file at the baseline, and `hash-object` gives the id the file on disk
 * would have, with the same clean filters and line-ending rules git would
 * apply when adding it. A path whose ids differ, or that is on only one side,
 * has changed, whatever the index was told.
 *
 * The diff is still asked, and the two lists are joined. It reports what
 * contents cannot: a file made executable, and a symbolic link, which this
 * leaves alone because hashing a link's path reads the file it points at.
 *
 * Two git processes more than the diff, whatever the number of files. They are
 * paid by the `Stop` hook while a change is `implementing` and by the triage,
 * and not by `state:show`, which never asks for the freeze.
 *
 * A baseline that does not exist answers empty, as `againstBase` does: there
 * is nothing to compare against, so nothing can be said to have changed.
 *
 * @param {string} from the baseline: a sha, or the target's ref
 * @returns {string[]}
 */
function frozenByContent(from) {
  let listed;
  try {
    listed = gitText(['ls-tree', '-r', '-z', from]);
  } catch {
    return [];
  }
  // One entry per file: `<mode> <type> <id>\t<path>`. `-z` ends each with a
  // NUL and leaves the path as it is, where a newline would have it quoted.
  const atBase = new Map();
  const links = new Set();
  for (const entry of listed.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (!isFrozen(path)) continue;
    if (mode === LINK_MODE) links.add(path);
    else if (type === 'blob') atBase.set(path, id);
  }

  // Everything git knows of on disk: index entries, which is where a flagged
  // file still appears, and untracked files that are not ignored.
  const onDisk = [...new Set(gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter((path) => path !== '' && isFrozen(path) && !links.has(path))
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false; // in the index and gone from disk: deleted, counted below
      }
    });

  const ids = onDisk.length === 0
    ? []
    : gitLines(['hash-object', '--stdin-paths'], { input: `${onDisk.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  const now = new Map(onDisk.map((path, index) => [path, ids[index]]));

  const differing = new Set();
  for (const [path, id] of atBase) if (now.get(path) !== id) differing.add(path);
  for (const path of now.keys()) if (!atBase.has(path)) differing.add(path);
  return [...differing];
}

/**
 * The changed files that are implementation: nothing under the freeze, and not
 * the machine's own bookkeeping.
 *
 * "Nothing was implemented" and "nothing broke" print the same numbers, and
 * telling them apart is the whole reason this exists. The bookkeeping has to
 * come out or the answer is always "something changed": the workflow logbook grows
 * by an event every time a hook runs, and the change file is written after the
 * work is over.
 *
 * `leftOut` and `isChangeFile` come from `tree.mjs`, which already draws this
 * line for the tree fingerprint and for the same reason. A second list of paths
 * that mean "not part of the change" would be a third place for it to drift.
 */
export const implementationChanges = (files) => {
  const ignored = leftOut();
  return files.filter((file) => !isFrozen(file) && !ignored(file) && !isChangeFile(file)).sort();
};
