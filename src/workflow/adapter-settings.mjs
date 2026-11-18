/** The rulebook's tests and code sections, read without running their commands. */
import { globToRegExp, isGlobList } from './glob.mjs';
import { checkRulebookKeys } from './rulebook-keys.mjs';
import { CONFIG, TargetError, parseExitCodes } from './rulebook-values.mjs';

/** Thrown for a missing or malformed section, and for a command that failed.
 *  A `TargetError`, so every caller that already refuses on a missing target
 *  refuses on this the same way. */
export class AdapterError extends TargetError {
  /** True when the piece was still running at its time limit and was
   *  stopped, which is a run that ran out of time rather than one that broke. */
  timedOut = false;
}

/**
 * What an exit code of the compile command can mean. See `runCompile`.
 *
 * - `clean`: it checked everything and found nothing.
 * - `errors`: it checked and found errors, which are in its output.
 * - `broken`: it could not check. A code the rulebook does not list means
 *   this too, so writing it only says out loud what a tool's crash codes are.
 */
export const COMPILE_MEANINGS = ['clean', 'errors', 'broken'];

export const NONE = 'none';

const refuse = (problem) =>
  new AdapterError(`${CONFIG}: ${problem}. The workflow refuses to run without it. The operator sets the "tests" and "code" sections. `
    + 'See src/adapters/README.md.');

const isCommand = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The section, checked, from a parsed config.
 *
 * @param {any} config the whole parsed `.katatay/rulebook.json`
 * @returns {{
 *   tests: { all: string[], acceptance: string[], slow: string[] }, testSupport: string[], code: string[],
 *   testRun: { command: string, reports: string[], tagComment: string },
 *   compile: ReturnType<typeof parseCompile>,
 * }}
 */
export function parseAdapter(config) {
  checkRulebookKeys(config, refuse);
  const tests = config?.tests?.paths;
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) {
    throw refuse('"tests.paths" must be an object with all, acceptance and support glob lists and an optional slow list');
  }
  for (const key of ['all', 'acceptance']) {
    if (!isGlobList(tests[key], { empty: false })) throw refuse(`"tests.paths.${key}" must be a non-empty list of globs`);
  }
  const { slow = [] } = tests;
  if (!isGlobList(slow, { empty: true })) throw refuse('"tests.paths.slow" must be a list of globs');
  const code = config.code?.paths;
  const testSupport = tests.support;
  if (!isGlobList(code, { empty: false })) throw refuse('"code.paths" must be a non-empty list of globs');
  if (!isGlobList(testSupport, { empty: true })) {
    throw refuse('"tests.paths.support" must be a list of globs, empty if there are none');
  }

  const testRun = parseTestRun(config.tests.run);
  const compile = parseCompile(config.code.compile);

  // Every glob compiles, so a typo is refused here rather than matching
  // nothing later, which would quietly empty the freeze.
  const globLists = {
    'tests.paths.all': tests.all, 'tests.paths.acceptance': tests.acceptance, 'tests.paths.slow': slow,
    'code.paths': code, 'tests.paths.support': testSupport, 'tests.run.reportPaths': testRun.reports,
  };
  for (const [key, globs] of Object.entries(globLists)) {
    try {
      for (const glob of globs) globToRegExp(glob);
    } catch (error) {
      throw refuse(`"${key}": a glob is malformed: ${error.message}`);
    }
  }

  return {
    tests: { all: tests.all, acceptance: tests.acceptance, slow },
    testSupport,
    code,
    testRun,
    compile,
  };
}

export const parseCompileExitCodes = (map, error = refuse) =>
  parseExitCodes(map, 'code.compile.exitCodes', COMPILE_MEANINGS, ['clean', 'errors'], error);

/**
 * The compile step, checked: the command that checks the code, tests
 * included; the pattern that finds each error in its output; and what each of
 * its exit codes means. Or `"none"`, for a language with no static check. See
 * "Compile" in `src/adapters/README.md`.
 *
 * Everything is checked here, so a mistake is refused when the rulebook is
 * read rather than matching nothing later, which would read as a clean run.
 *
 * The exit codes are a map, not a list, so the rulebook says what each one
 * means. A list only said which codes were fine, and a reader could not tell
 * "found errors" from "crashed". Both `clean` and `errors` must appear: a
 * compiler with no code for "found errors" cannot be read, because a clean run
 * and a run with errors would look the same.
 *
 * @param {any} compile
 * @returns {{ command: string, pattern: string, exitCodes: Record<string, string> } | 'none'}
 */
function parseCompile(compile) {
  if (compile === NONE) return NONE;
  if (compile === null || typeof compile !== 'object' || Array.isArray(compile)) {
    throw refuse(`there is no "code.compile": the command that checks the code, the pattern for its errors and what its exit codes mean, or "${NONE}" if the language has no such step`);
  }
  if (!isCommand(compile.command)) throw refuse('"code.compile.command" must be the command that checks the code, tests included');
  if (typeof compile.pattern !== 'string' || compile.pattern === '') {
    throw refuse('"code.compile.pattern" must be a regular expression with named groups "file" and "message", and optionally "line"');
  }
  try {
    new RegExp(compile.pattern);
  } catch (error) {
    throw refuse(`"code.compile.pattern" is a malformed regular expression: ${error.message}`);
  }
  for (const group of ['file', 'message']) {
    if (!compile.pattern.includes(`(?<${group}>`)) throw refuse(`"code.compile.pattern" has no named group "${group}", written (?<${group}>...)`);
  }
  return { command: compile.command, pattern: compile.pattern, exitCodes: parseCompileExitCodes(compile.exitCodes) };
}

/**
 * The part of a glob before its first segment with a wildcard in it, such as
 * `reports/junit` for `reports/junit/*.xml`. The whole glob when it has no
 * wildcard at all.
 *
 * @param {string} glob
 */
export const literalFolder = (glob) => {
  const segments = glob.split('/');
  const wild = segments.findIndex((segment) => /[*?{]/.test(segment));
  return (wild === -1 ? segments : segments.slice(0, wild)).join('/');
};

/**
 * The test run, checked: the command that runs the tests, the JUnit reports
 * it writes and the comment that carries a tag where a test's name cannot. See "The test
 * run" in `src/adapters/README.md`.
 *
 * A report glob must start with a folder named in full, or be a path with no
 * wildcard. The referee deletes what the globs match before every run, so that
 * a report an earlier run left can never read as this one's, and a glob such
 * as `**\/*.xml` would reach into `node_modules`, which git ignores too.
 *
 * @param {any} testRun
 * @returns {{ command: string, reports: string[], tagComment: string }}
 */
function parseTestRun(testRun) {
  if (testRun === null || typeof testRun !== 'object' || Array.isArray(testRun)) {
    throw refuse('there is no "tests.run": the command that runs the tests and the JUnit reports it writes');
  }
  if (!isCommand(testRun.command)) throw refuse('"tests.run.command" must be the command that runs the tests');
  const { reportPaths: reports } = testRun;
  if (!isGlobList(reports, { empty: false })) {
    throw refuse('"tests.run.reportPaths" must be a non-empty list of globs for the JUnit reports the command writes');
  }
  for (const glob of reports) {
    if (literalFolder(glob) === '') {
      throw refuse(`"tests.run.reportPaths" holds ${JSON.stringify(glob)}, which starts with a wildcard. The referee deletes what it matches before each run, so it must start with a folder named in full`);
    }
  }
  if (typeof testRun.tagComment !== 'string' || testRun.tagComment === '') {
    throw refuse('"tests.run.tagComment" must be a regular expression for a comment line, such as "^\\\\s*//"');
  }
  try {
    new RegExp(testRun.tagComment);
  } catch (error) {
    throw refuse(`"tests.run.tagComment" is a malformed regular expression: ${error.message}`);
  }
  return { command: testRun.command, reports, tagComment: testRun.tagComment };
}
