/**
 * The tests that reach the code only through processes they start, which
 * mutation testing leaves out.
 *
 * A mutant cannot be caught from another process. Stryker's Vitest runner
 * switches a mutant on inside the test worker, by setting it on the worker's
 * global namespace (`inject('activeMutant')` in its `stryker-setup.js`). The
 * instrumented code would also read `__STRYKER_ACTIVE_MUTANT__` from the
 * environment, but only Stryker's command runner sets that. So a hook or a
 * command a test starts as a separate `node` process runs the original code,
 * whatever mutant is on, and only what a test does in its own process can
 * catch one. A test like that gives mutation no information, and still costs
 * its whole time in Stryker's first pass, which runs every test that reaches
 * the changed lines once, before any mutant is planted.
 *
 * Such tests can be most of a run's cost: a project whose tests drive its
 * own command-line tools as processes can spend its whole time limit in that
 * first pass. The project's mutation config says why each of its own groups
 * is left out.
 *
 * Decided from the file's imports, so a new test is sorted without anyone
 * keeping a list. A file is left out when everything it imports is Vitest, a
 * Node built-in, or test support. Which files are tests and which are test
 * support is the project's, so the project's mutation config passes both as
 * globs (`Layout`). A test file is never support.
 * Any other import is code under test, which a case in that file could call in
 * process and catch a mutant in, so the file stays in. A file that mixes both
 * kinds of case is split, so its process cases sit in a file of their own.
 *
 * The same reading also leaves out a test that imports no code at all, such
 * as one that checks a folder's contents or a fixture's own data. No mutant
 * can reach it either. Vitest never counts such a file as related to a
 * change, so it cost nothing before; leaving it out changes nothing.
 *
 * What is given up: support code that calls code under test in process could
 * let a mutant there break a test, which this rule leaves out. That code needs
 * tests of its own.
 */
import { globSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

/**
 * Where a project keeps its tests and their support, from the repository
 * root: `tests`, the globs of every test file, as the rulebook's
 * `tests.paths.all` names them; `support`, the globs of the files a test
 * may import that are not code under test, such as a harness or fixtures.
 */
export interface Layout {
  tests: string[];
  support: string[];
}

const matchesAny = (file: string, globs: string[]): boolean => globs.some((glob) => posix.matchesGlob(file, glob));

/** Folders that hold no test of ours: dependencies, build output, Stryker's
 *  sandboxes, coverage reports and git's own files. */
const NOT_OURS = /(^|\/)(node_modules|\.next[^/]*|\.stryker-tmp|\.git|coverage)(\/|$)/;

/** Every module a source file imports, static or dynamic. */
export function importsOf(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]!);
  // A bare import starts a statement. Matched anywhere, it read an argument
  // such as `'--import', TSX` as an import of `, TSX, …`.
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1]!);
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
  // A dynamic import of something computed could be anything, so it counts
  // as code under test.
  if (/\bimport\s*\(\s*[^'"\s]/.test(source)) specs.push('<computed>');
  return specs;
}

/**
 * Whether an import, made by the test file `file`, is test support by the
 * project's `layout`. Both are paths from the repository root. Only a relative
 * import inside the repository can be, and never one of a test file.
 */
export function isSupport(spec: string, file: string, layout: Layout): boolean {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), spec));
  if (target.startsWith('../')) return false;
  return matchesAny(target, layout.support) && !matchesAny(target, layout.tests);
}

/** Whether a test file, at `file` from the repository root, reaches the code
 *  only through processes it starts. */
export function processOnly(source: string, file: string, layout: Layout): boolean {
  return importsOf(source).every((spec) => spec === 'vitest' || spec.startsWith('node:') || isSupport(spec, file, layout));
}

/** The test files in the repository, from its root, that are process-only. */
export function processOnlyTests(layout: Layout, root = process.cwd()): string[] {
  const base = resolve(root);
  return globSync(layout.tests, { cwd: base, exclude: (path) => NOT_OURS.test(path) })
    .map((file) => relative(base, join(base, file)).split('\\').join('/'))
    .filter((file) => processOnly(readFileSync(join(base, file), 'utf8'), file, layout))
    .sort();
}
