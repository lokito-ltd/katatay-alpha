import { spawnSync } from 'node:child_process';
import { readChecks } from '../workflow/rulebook.mjs';
import { invalidateOutput } from '../workflow/check-output.mjs';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import nativePath, { join } from 'node:path';
import { AdapterError, literalFolder, matchesAcceptance, matchesTests, matchesReport, readAdapter } from '../workflow/adapter.mjs';
import { gitLines } from '../workflow/git.mjs';
import { JUnitError, readJUnit, type JUnitCase } from './junit.js';
import { bareIdsIn, idsIn, scenariosIn, groupSuffixes } from './tags.js';

/**
 * The test run, read from the JUnit reports the rulebook's test command
 * writes. See "The test run" in `src/adapters/README.md`.
 *
 * This replaced two translator commands, `listTests` and `runTests`, which
 * printed the referee's own JSON. No real tool prints that, so every language
 * needed translator code. Almost every runner writes JUnit XML already. What a
 * plain report cannot say, the reporter adds as properties on a test case: `file`,
 * `scenario`, `line`, `endLine` and `inverted`.
 *
 * Two ways in:
 *
 * - `runTestCommand` deletes earlier JUnit reports and saved coverage analysis,
 *   runs the command, and reads what it wrote. Source coverage cleanup is
 *   part of the configured test command. The triage
 *   and verify use it.
 * - Standalone `req:trace` reads working reports. The change report parses
 *   the XML saved by its verification through the same reader.
 */

export interface TestCase {
  /** The test file, from the repository root. */
  file: string;
  /** The test case's name in the report, group names in front included. */
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string | null;
  /** Requirement ids it carries. A scenario tag counts toward its
   *  requirement, so `[AC0009.2]` puts `AC0009` here. */
  ids: string[];
  /** Scenario ids it carries, such as `AC0009.2`. */
  scenarios: string[];
  /** Tags that name a requirement and no scenario, such as `[INV0001]`. */
  bare: string[];
  /** 1-based, from the reporter. Both or neither. */
  line?: number;
  endLine?: number;
  /** The reporter says it passes when its body fails, as Vitest's `.fails`. */
  inverted: boolean;
}

/** A test file the report leaves out: it failed to load, or the run never
 *  reached it. For an acceptance file its tags are found by searching its whole text. */
export interface LeftOutFile {
  file: string;
  ids: string[];
  scenarios: string[];
  bare: string[];
}

export interface TestRun {
  cases: TestCase[];
  leftOut: LeftOutFile[];
  /** How the command ended: its exit code, or the signal that stopped it.
   *  `null` for a run read from its reports without running it. */
  exit: number | string | null;
}

const refuse = (problem: string) =>
  new AdapterError(`test run: ${problem}. That is the test run failing, not a result, so nothing was concluded from it.`);

/** The files git knows or would track, that exist. */
const knownFiles = (root: string): string[] =>
  [...new Set(gitLines(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root }))].filter((file) => existsSync(join(root, file)));

/** Every file under a folder, from the repository root, `.git` left out. */
function filesUnder(folder: string, root: string): string[] {
  const at = join(root, folder);
  if (!existsSync(at)) return [];
  if (!statSync(at).isDirectory()) return [folder];
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git') return [];
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path, root) : [path];
  });
}

/** The report files the rulebook's globs match now, sorted. */
export function reportFiles(root = process.cwd()): string[] {
  const { testRun } = readAdapter(root);
  const folders = [...new Set((testRun.reports as string[]).map((glob) => literalFolder(glob)))];
  return [...new Set(folders.flatMap((folder) => filesUnder(folder, root)))]
    .filter((file) => matchesReport(file, root))
    .sort();
}

/**
 * Deletes the reports an earlier run left, so they can never read as this
 * run's. Refuses first when a report glob matches a file git tracks or would
 * track: reports are output, and a glob that reaches source would delete it.
 */
export function clearReports(root = process.cwd()): void {
  const known = knownFiles(root);
  const tracked = known.filter((file) => matchesReport(file, root));
  if (tracked.length > 0) {
    throw refuse(`"tests.run.reportPaths" matches ${tracked.length === 1 ? 'a file' : 'files'} git tracks or would track (${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? ', …' : ''}). Reports are output: name an ignored folder, or add the folder to .gitignore`);
  }
  // The referee owns its analysis, while the test command owns source
  // coverage cleanup. Even a failed test run invalidates earlier analysis.
  const coverage = readChecks(root).testQuality.find((check) => check.name === 'coverage');
  if (coverage) invalidateOutput(coverage, root);
  for (const file of reportFiles(root)) rmSync(join(root, file), { force: true });
}

/**
 * Runs the rulebook's test command and reads the reports it wrote.
 *
 * Its output is passed through. `shown: false` drops its stdout, for the
 * triage, which prints a report of its own. With `shown`, stdout goes to
 * stderr, as verify wants it: the failures the runner describes reach whoever
 * reads the verify output.
 *
 * A red suite is a result. So is a command that wrote no report at all: then
 * every test file is left out, and each is a failure. Decided with the
 * operator on 2026-10-07 for a run that could not start: a broken test
 * harness is something the change broke, and saying what the change broke is
 * what the triage is for.
 */
export function runTestCommand({ root = process.cwd(), shown = true, capture }: {
  root?: string;
  shown?: boolean;
  capture?: (reports: ReportBytes[]) => void;
} = {}): TestRun {
  const { testRun } = readAdapter(root);
  clearReports(root);
  const run = spawnSync(testRun.command, {
    shell: true,
    cwd: root,
    stdio: ['ignore', shown ? 2 : 'ignore', 'inherit'],
  });
  if (run.error) throw refuse(`\`${testRun.command}\` could not be started (${run.error.message})`);
  const reports = workingReports(root);
  capture?.(reports);
  return { ...parseReports(reports, root), exit: run.status ?? run.signal ?? null };
}

/**
 * The last run, read from the reports it left. No report at all is a refusal:
 * nothing has run, or what ran wrote nothing, and either way there is no
 * evidence to read.
 */
export function readTestRun(root = process.cwd()): TestRun {
  const reports = workingReports(root);
  if (!reports.length) {
    const { testRun } = readAdapter(root);
    throw refuse(`there is no test report at ${testRun.reports.join(', ')}. Run the tests first: \`workflow verify\` runs them`);
  }
  return parseReports(reports, root);
}

interface ReportBytes {
  name: string;
  bytes: Buffer;
}

function workingReports(root: string): ReportBytes[] {
  return reportFiles(root).map(name => ({ name, bytes: readFileSync(join(root, name)) }));
}

export function parseReports(reports: ReportBytes[], root: string): TestRun {
  const { testRun } = readAdapter(root);
  const comment = new RegExp(testRun.tagComment);
  const testFiles = knownFiles(root).filter((file) => matchesTests(file, root));
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    if (!texts.has(file)) texts.set(file, readFileSync(join(root, file), 'utf8'));
    return texts.get(file)!;
  };

  const raw: { report: string; testcase: JUnitCase }[] = [];
  for (const { name: report, bytes } of reports) {
    try {
      for (const testcase of readJUnit(bytes.toString('utf8'), report)) raw.push({ report, testcase });
    } catch (error) {
      if (error instanceof JUnitError) throw refuse(`a test report could not be read: ${error.message}`);
      throw error;
    }
  }

  const cases = raw.map(({ report, testcase }) => toCase(testcase, report, { root, testFiles, textOf, comment }));
  const seen = new Set(cases.map((c) => c.file));
  const leftOut = testFiles.filter((file) => !seen.has(file)).sort().map((file) => {
    const text = matchesAcceptance(file, root) ? textOf(file) : '';
    return { file, ids: idsIn(text), scenarios: scenariosIn(text), bare: bareIdsIn(text) };
  });
  return { cases, leftOut, exit: null };
}

interface Context {
  root: string;
  testFiles: string[];
  textOf: (file: string) => string;
  comment: RegExp;
}

/** One property's single value, or `undefined`. Given twice is a refusal:
 *  the referee would have to pick one. */
function single(testcase: JUnitCase, name: string, where: string): string | undefined {
  const values = testcase.properties[name];
  if (values === undefined) return undefined;
  if (values.length > 1) throw refuse(`${where}: "${testcase.name}" has the property "${name}" ${values.length} times`);
  return values[0];
}

const SCENARIO = /^(?:AC|INV)\d{4}(?:\.\d+)?$/;

function toCase(testcase: JUnitCase, report: string, context: Context): TestCase {
  const where = `the test report ${report}`;
  const named = single(testcase, 'file', where) ?? testcase.file;
  const file = named === null ? fileByName(testcase.name, context) : fileFromReport(named, testcase.name, where, context);

  const lineText = single(testcase, 'line', where);
  const endText = single(testcase, 'endLine', where);
  const isLine = (value: string) => /^[1-9][0-9]*$/.test(value);
  if ((lineText === undefined) !== (endText === undefined)) {
    throw refuse(`${where}: "${testcase.name}" has ${lineText === undefined ? '"endLine"' : '"line"'} without ${lineText === undefined ? '"line"' : '"endLine"'}`);
  }
  if (lineText !== undefined && !(isLine(lineText) && isLine(endText!) && Number(endText) >= Number(lineText))) {
    throw refuse(`${where}: "${testcase.name}" has line ${JSON.stringify(lineText)} to ${JSON.stringify(endText)}, which is not a range of lines`);
  }
  const invertedText = single(testcase, 'inverted', where);
  if (invertedText !== undefined && invertedText !== 'true' && invertedText !== 'false') {
    throw refuse(`${where}: "${testcase.name}" has "inverted" ${JSON.stringify(invertedText)}, which is neither true nor false`);
  }
  const line = lineText === undefined ? undefined : Number(lineText);
  const tagText = matchesAcceptance(file, context.root) ? tagSource(testcase, file, line, where, context) : '';
  return {
    file,
    name: testcase.name,
    status: testcase.status,
    message: testcase.message,
    ids: idsIn(tagText),
    scenarios: scenariosIn(tagText),
    bare: bareIdsIn(tagText),
    ...(line === undefined ? {} : { line, endLine: Number(endText) }),
    inverted: invertedText === 'true',
  };
}

/**
 * Where a test's tags are read from: its name when the name holds one, as a
 * Vitest title or a Go subtest name does; else the reporter's `scenario`
 * properties; else the comment lines directly above the test, the ones that
 * match `tagComment`, as a pytest or Rust function carries them.
 */
function tagSource(testcase: JUnitCase, file: string, line: number | undefined, where: string, context: Context): string {
  const { name } = testcase;
  const scenarios = testcase.properties.scenario ?? [];
  const malformed = scenarios.find((value) => !SCENARIO.test(value));
  if (malformed !== undefined) {
    throw refuse(`${where}: "${name}" has "scenario" ${JSON.stringify(malformed)}, which is not a requirement or scenario id such as AC0001.1`);
  }
  if (idsIn(name).length > 0) return name;
  if (scenarios.length > 0) return scenarios.map((id) => `[${id}]`).join(' ');
  const at = line ?? lineOfName(name, context.textOf(file));
  if (at === undefined) return '';
  const lines = context.textOf(file).split('\n');
  const above: string[] = [];
  for (let i = at - 2; i >= 0 && context.comment.test(lines[i]!); i--) above.push(lines[i]!);
  return above.join('\n');
}

/** The one line of a file that holds the test's name, 1-based, or
 *  `undefined` when none does or several do. Never a guess. */
function lineOfName(name: string, text: string): number | undefined {
  const lines = text.split('\n');
  for (const candidate of groupSuffixes(name)) {
    const hits = lines.flatMap((content, i) => (content.includes(candidate) ? [i + 1] : []));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

/** Normalize a runner's path to repository slashes, or reject it if it resolves outside the root. */
export function reportedPathInRepo(named: string, root: string, paths = nativePath): string | null {
  const path = named.split('\\').join('/');
  const file = paths.relative(root, paths.resolve(root, path)).split('\\').join('/');
  if (!file || file === '..' || file.startsWith('../') || paths.isAbsolute(file)) return null;
  return file;
}

/**
 * The file a report names, from the repository root. An absolute path is
 * taken relative to the root. One outside the repository, or one that does
 * not exist, is a refusal, because a test case that cannot be placed cannot
 * be told apart from one that was made up.
 */
function fileFromReport(named: string, name: string, where: string, { root }: Context): string {
  const file = reportedPathInRepo(named, root);
  if (file === null) {
    throw refuse(`${where}: "${name}" names the file ${named}, which is outside the repository`);
  }
  if (!existsSync(join(root, file))) throw refuse(`${where}: "${name}" names the file ${named}, which does not exist`);
  if (!matchesTests(file, root)) throw refuse(`${where}: "${name}" names ${file}, which is outside "tests.paths.all"`);
  return file;
}

/**
 * The test file that holds a test's name, when the report names no file. The
 * name is looked for whole first, then with its group names in front taken
 * off one at a time. The first form any file holds decides: exactly one file
 * is the answer, and none or several is a refusal that names the test. The
 * referee never guesses which file a test came from.
 */
function fileByName(name: string, { testFiles, textOf }: Context): string {
  for (const candidate of groupSuffixes(name)) {
    const holding = testFiles.filter((file) => textOf(file).includes(candidate));
    if (holding.length === 1) return holding[0]!;
    if (holding.length > 1) {
      throw refuse(`the report names no file for "${name}", and ${holding.length} test files hold its name (${holding.slice(0, 5).join(', ')}${holding.length > 5 ? ', …' : ''}). Have the report name its file`);
    }
  }
  throw refuse(`the report names no file for "${name}", and no test file holds its name. Have the report name its file`);
}

/** The file of the outcome that stands for a run that failed outside any
 *  test. No prediction can name it: it is not a test. */
export const TEST_RUN = '(the test run)';

/** A run's outcomes, as the triage and verify sort them. See `outcomesOf`. */
export interface RunOutcome {
  file: string;
  title: string;
  ids: string[];
  /** Scenario ids, such as `AC0009.2`, which a prediction can name. */
  scenarios: string[];
  failed: boolean;
  /** Set when the outcome stands for a whole file rather than one test. */
  wholeFile?: boolean;
  line?: number;
  endLine?: number;
  reason?: string;
  didNotRun?: boolean;
}

/**
 * A run's outcomes: one per test case, then one failed whole-file outcome per
 * test file the report left out, carrying the tags of an acceptance file,
 * because any of its tests could be the one that no longer runs.
 *
 * A command that exited non-zero, while nothing in the report failed and
 * nothing was left out, failed outside any test, such as an unhandled error
 * after the last test. That is one more failed outcome, so a failed run never
 * reads as green. Every runner says a run failed with its exit code, so this
 * needs no reporter.
 */
export function outcomesOf(run: TestRun): RunOutcome[] {
  const outcomes: RunOutcome[] = run.cases.map((c) => ({
    file: c.file,
    title: c.name,
    ids: c.ids,
    scenarios: c.scenarios,
    failed: c.status === 'failed',
    ...(c.line === undefined ? {} : { line: c.line, endLine: c.endLine }),
    ...(c.status === 'failed' && c.message ? { reason: c.message } : {}),
  }));
  for (const file of run.leftOut) {
    outcomes.push({
      file: file.file,
      title: '(the whole file)',
      ids: file.ids,
      scenarios: file.scenarios,
      failed: true,
      wholeFile: true,
      reason: 'the test report leaves it out: it failed to load, or the run never reached it',
      didNotRun: true,
    });
  }
  if (run.exit !== null && run.exit !== 0 && !outcomes.some((o) => o.failed)) {
    outcomes.push({
      file: TEST_RUN,
      title: 'the test command failed outside any test',
      ids: [],
      scenarios: [],
      failed: true,
      reason: typeof run.exit === 'string' ? `stopped by ${run.exit}, and no test in the report failed`
        : `it exited ${run.exit}, and no test in the report failed`,
    });
  }
  return outcomes;
}
