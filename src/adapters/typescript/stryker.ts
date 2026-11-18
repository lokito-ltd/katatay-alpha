/**
 * The mutation command for TypeScript: Stryker, run over Vitest.
 *
 * The referee decides which lines to mutate and how long the run may take (see
 * `src/evidence/mutants.ts`), and reads how the run ended from the exit code.
 * This file answers the rest: what became of each mutant planted in those
 * lines, said as text for the reader, and which exit code that is under the
 * contract in `src/adapters/README.md`. The referee reads the standard report
 * for individual mutants and their counts.
 *
 * `stryker-mutate.ts` starts it, and `mutate-plugins.mjs` adapts Stryker to
 * Vitest 5.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROGRESS } from './progress.mjs';
import { DEFAULT_REPORT, writePartialReport } from './stryker-report.js';
import type { Run } from './stryker-process.js';

/** Where Stryker copies the code to. Gitignored; see `tempDirName` below. */
export const SANDBOXES = '.stryker-tmp';

/** One range of lines to mutate, or a whole file when `lines` is absent. */
export interface Target {
  file: string;
  lines?: [number, number];
}

/** What the referee asks, on stdin. `budget` is seconds, or null for no limit. */
export interface Request {
  targets: Target[];
  budget: number | null;
  verbose?: boolean;
}

/** What became of one mutant. */
export interface Mutant {
  file: string;
  line: number;
  mutator: string;
  replacement: string;
  status: 'caught' | 'survived' | 'unreached' | 'broke' | 'notRun' | 'skipped';
  reason?: string;
}

/** What a run found, before it is said as text and an exit code. */
export interface Answer {
  planned: number;
  stopped: boolean;
  noTests: boolean;
  mutants: Mutant[];
}

const isLine = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

/**
 * The request, checked. A request the referee did not send is a crash: the
 * contract says a crash is a refusal, and a guessed target list could mutate
 * the wrong code.
 */
export function readRequest(text: string): Request {
  const request = JSON.parse(text) as Partial<Request>;
  const targets = request?.targets;
  if (!Array.isArray(targets)) throw new Error('mutate: the request has no "targets" list');
  for (const target of targets) {
    const ok = target !== null && typeof target === 'object' && typeof target.file === 'string' && target.file !== ''
      && (target.lines === undefined
        || (Array.isArray(target.lines) && target.lines.length === 2 && isLine(target.lines[0]) && isLine(target.lines[1])
          && target.lines[1] >= target.lines[0]));
    if (!ok) throw new Error(`mutate: a target is not { file, lines?: [start, end] }: ${JSON.stringify(target)}`);
  }
  const budget = request.budget;
  if (!(budget === null || (typeof budget === 'number' && Number.isFinite(budget) && budget > 0))) {
    throw new Error('mutate: "budget" must be a positive number of seconds, or null');
  }
  return { targets, budget, verbose: request.verbose === true };
}

/**
 * A path made literal for Stryker. Stryker reads each `mutate` entry as a
 * glob, and Next's route folders are named like `[id]` and `(group)`, which a
 * glob reads as "one of the characters i or d" and as part of a pattern. It
 * also refuses a range on any path that looks like a glob, so a change to a
 * page was refused outright before this.
 *
 * Each such character goes in a class of its own: `[[]` matches a `[` and
 * nothing else, and minimatch, the glob library Stryker uses, does not count a
 * one-character class as a glob. A backslash would be the usual escape, and
 * does not survive: Stryker turns every backslash in a path into a slash,
 * for Windows. `+`, `@` and `!` mean something only before a `(`, which is
 * already made literal here.
 */
export function literal(path: string): string {
  return path.replace(/[[\]*?{}()]/g, '[$&]');
}

/** A target in Stryker's `mutate` syntax: `file:start-end`, or the bare path
 *  for a whole file. */
export const strykerTarget = ({ file, lines }: Target): string =>
  lines === undefined ? literal(file) : `${literal(file)}:${lines[0]}-${lines[1]}`;

/**
 * Stryker's options. `vitestConfig` is the project's Vitest config for
 * mutation runs, which the command is given as `--vitest-config`: which tests
 * run, and which are left out, is the project's call, not this adapter's.
 *
 * - `testRunner` is the wrapper in `mutate-plugins.mjs`, loaded by `plugins`.
 *   Stryker's own Vitest runner skips every test inside a `describe` under
 *   Vitest 5; see that file. `ignorers` skips inline styles, from the same
 *   file.
 * - `vitest.related` runs only the tests that import a mutated file, and
 *   `perTest` coverage then picks, per mutant, the tests that reach its line.
 *   So only the tests around the change run.
 * - `tsconfigFile` names a file that does not exist, on purpose. Stryker
 *   rewrites the paths in a tsconfig's `extends` and `references` using
 *   TypeScript's JavaScript API, and TypeScript 7 has none, so the step throws.
 *   With no tsconfig it is skipped. Ours has neither field, so nothing is lost.
 * - `tempDirName` is inside the repository, and gitignored. Stryker never
 *   copies `.git` into its sandbox, so a sandbox elsewhere would leave every
 *   test that runs git with no repository at all. Inside, git still finds this
 *   one. Being ignored keeps it out of `git status` and the tree fingerprint.
 * - `ignoreStatic` skips mutants in code that runs when a file is imported,
 *   such as a top-level constant. Stryker cannot tell which test depends on
 *   one, so for each it reloads everything and runs every related test. On
 *   the change that measured it, on 2026-10-18, 103 of 436 mutants were static
 *   and did 80% of the test runs. They are reported as `skipped`, so nobody
 *   reads them as checked. Coverage and review still see that code.
 * - The JSON reporter writes the standard report for a completed run. The
 *   progress reporter in `mutate-plugins.mjs` writes each result as it lands,
 *   so the wrapper can publish a partial report at its time limit.
 * - `logLevel` is `error`, so the reason a run failed reaches the reader. With
 *   logging off, a failed first test pass said only "Something went wrong in
 *   the initial test run", while the reason, such as "Initial test run timed
 *   out!", went nowhere. Stryker runs in a process of its own
 *   (`stryker-process.ts`), whose output goes to stderr, so its log never
 *   lands in the answer on stdout.
 */
export function strykerOptions(targets: string[], plugins: string, vitestConfig: string, reportFile = DEFAULT_REPORT): Record<string, unknown> {
  return {
    testRunner: 'vitest-describe',
    plugins: [plugins],
    ignorers: ['inline-styles'],
    vitest: { configFile: vitestConfig, related: true },
    mutate: targets,
    coverageAnalysis: 'perTest',
    ignoreStatic: true,
    tsconfigFile: 'src/adapters/typescript/no-tsconfig-on-purpose.json',
    tempDirName: SANDBOXES,
    cleanTempDir: true,
    reporters: ['progress-file', 'json'],
    jsonReporter: { fileName: reportFile },
    logLevel: 'error',
    fileLogLevel: 'off',
  };
}

/** The fields of a Stryker `MutantResult` this file reads. */
export interface StrykerResult {
  fileName: string;
  location: { start: { line: number } };
  mutatorName: string;
  replacement?: string;
  status: string;
  testsCompleted?: number;
  statusReason?: string;
}

/** How Stryker marks a static mutant it skipped, as against one an ignorer
 *  skipped. */
const STATIC = /^Static mutant/;

/** What the report says of a static mutant. */
export const STATIC_REASON = 'code that runs when a file loads';

/**
 * One Stryker result in the contract's words, or `null` for a mutant left out
 * on purpose.
 *
 * - An inline style an ignorer skipped is left out: it changes how a page
 *   looks, which no behaviour test checks. See `mutate-plugins.mjs`.
 * - A static mutant is `skipped`, because unlike an inline style it is code a
 *   test could have checked.
 * - A timeout is `caught`, as Stryker counts it: the mutant made a test hang,
 *   which a test run notices.
 * - **A survivor no test ran against is `notRun`.** Stryker reports
 *   "Survived" whenever no test failed, including when no test ran. The first
 *   trial run reported 59 of 62 mutants as survived with zero tests run,
 *   because its Vitest runner skipped every test inside a `describe`.
 * - A status this file does not know is a crash, never a guess.
 *
 * `root` is stripped from the file names, which Stryker gives as absolute.
 */
export function toMutant(result: StrykerResult, root: string): Mutant | null {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const base = {
    file: result.fileName.startsWith(prefix) ? result.fileName.slice(prefix.length) : result.fileName,
    line: result.location.start.line,
    mutator: result.mutatorName,
    replacement: result.replacement ?? '',
  };
  switch (result.status) {
    case 'Ignored':
      return STATIC.test(result.statusReason ?? '') ? { ...base, status: 'skipped', reason: STATIC_REASON } : null;
    case 'Killed':
    case 'Timeout':
      return { ...base, status: 'caught' };
    case 'NoCoverage':
      return { ...base, status: 'unreached' };
    case 'CompileError':
    case 'RuntimeError':
      return { ...base, status: 'broke' };
    case 'Survived':
      return { ...base, status: (result.testsCompleted ?? 0) === 0 ? 'notRun' : 'survived' };
    default:
      throw new Error(`mutate: Stryker gave a status this adapter does not know: ${result.status}`);
  }
}

const toMutants = (results: StrykerResult[], root: string): Mutant[] =>
  results.map((result) => toMutant(result, root)).filter((m): m is Mutant => m !== null);

/** How many mutants a list plans to check: every one but those skipped. */
const plannedIn = (mutants: Mutant[]): number => mutants.filter((m) => m.status !== 'skipped').length;

/** Stryker's words when its first pass found no test to run. */
const NO_TESTS = /No tests were executed/;

/**
 * The common ways a run fails, in plain words, each matched on Stryker's
 * error or its log. All three happen in Stryker's first pass, which runs every
 * related test once, before any mutant is planted, to see which test reaches
 * which line.
 */
const PLAIN: [RegExp, string][] = [
  [/Initial test run timed out/,
    "Stryker's first pass over the tests, before any mutant is planted, ran past Stryker's own time limit. "
      + 'It runs every fast test that reaches the changed lines, so one slow test there stops the whole run.'],
  [/There were failed tests in the initial test run/,
    "A test failed in Stryker's first pass, before any mutant was planted, so nothing could be measured. "
      + "Stryker's log above names the test. A test that passes under the rulebook's test command and fails here usually needs "
      + "something Stryker's sandbox copy of the repository lacks."],
  [/One or more tests resulted in an error/,
    "A test file could not run in Stryker's first pass, before any mutant was planted. Stryker's log above gives the error."],
];

/**
 * What a failed run says: the plain words for a known case first, then
 * Stryker's own message, so neither hides the other.
 */
export function plainReason(message: string, log: string): string {
  const known = PLAIN.find(([pattern]) => pattern.test(message) || pattern.test(log));
  return known === undefined ? message : `${known[1]}\n(Stryker: ${message})`;
}

/**
 * What the run found, short of reading stdin and printing, so a test can run
 * it in process. `run` starts Stryker, given the targets in its syntax;
 * `stryker-mutate.ts` passes the real one, from `stryker-process.ts`.
 *
 * With a budget, the answer comes when the run finishes or the budget runs
 * out, whichever is first. Past it, the run is stopped and waited for, every
 * worker with it, and only then is the progress file read (see `PROGRESS`):
 * the answer is what it holds, marked `stopped`. The referee is told the budget
 * and trusts this to keep it, because a process stopped from outside may
 * leave those workers running.
 *
 * Stryker stops when no test imports any of the changed files. That is an
 * answer, `noTests`, and not a failure. Any other failure is thrown: a crash.
 * The referee is told none of this directly: `exitFor` and `render` say it.
 */
export async function answer({ request, cwd, run }: {
  request: Request;
  cwd: string;
  run: (targets: string[]) => Run;
}): Promise<Answer> {
  rmSync(join(cwd, PROGRESS), { force: true });
  const started = run(request.targets.map(strykerTarget));
  const finished = started.done.then(
    (results): Answer => {
      const mutants = toMutants(results, cwd);
      return { planned: plannedIn(mutants), stopped: false, noTests: false, mutants };
    },
    (error: unknown): Answer => {
      const message = error instanceof Error ? error.message : String(error);
      if (NO_TESTS.test(message)) return { planned: 0, stopped: false, noTests: true, mutants: [] };
      throw error;
    },
  );
  if (request.budget === null) return finished;

  // Once the budget has run out, the cut-off alone answers. Stopping the run
  // kills it, and a killed run ends with no answer, so `finished` rejects as
  // soon as the kill lands, before `stop` has settled. Raced as equals, that
  // rejection won, and a run cut at its budget read as a crash; on 2026-10-23
  // it threw away what a whole time limit had checked. So whatever `finished` does
  // after the cut-off starts is ignored. Its handlers below are still
  // attached, so a late failure is never an unhandled rejection.
  let timer: NodeJS.Timeout | undefined;
  let cut = false;
  try {
    return await new Promise<Answer>((resolve, reject) => {
      timer = setTimeout(() => {
        cut = true;
        started.stop().then(() => resolve(partial(cwd)), reject);
      }, request.budget! * 1000);
      finished.then(
        (said) => { if (!cut) resolve(said); },
        (error: unknown) => { if (!cut) reject(error); },
      );
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a run cut off at its budget found by then, read from the file the
 * progress reporter writes in `cwd`: a line for the plan, with the number of
 * mutants not skipped, then a line per mutant. With nothing checked yet, which
 * is the case while Stryker's first pass over the tests is still going, the
 * list is empty, and the referee says the run showed nothing.
 */
export function partial(cwd: string): Answer {
  let planned = 0;
  const results: StrykerResult[] = [];
  const progress = join(cwd, PROGRESS);
  const text = existsSync(progress) ? readFileSync(progress, 'utf8') : '';
  for (const line of text.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as { planned?: number; result?: StrykerResult };
    if (entry.planned !== undefined) planned = entry.planned;
    if (entry.result !== undefined) results.push(entry.result);
  }
  return { planned, stopped: true, noTests: false, mutants: toMutants(results, cwd) };
}

/**
 * Removes Stryker's folder, or says why it could not: a sentence for stderr,
 * or null when it is gone.
 *
 * Retried, because a process that has just exited can still hold a file open
 * for a moment. A delete that still fails is a warning
 * and nothing more. The folder is gitignored, the next run replaces it, and
 * the answer is already written by then. On 2026-10-22 a failed delete here
 * exited 1 after a run cut off at its budget, and the referee threw away the
 * answer it had already been given.
 */
export function removeSandboxes(cwd: string, rm: typeof rmSync = rmSync): string | null {
  try {
    rm(join(cwd, SANDBOXES), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return null;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `mutate: could not remove ${SANDBOXES}/ (${why}). It is gitignored, and the next run replaces it.`;
  }
}

// ---------------------------------------------------------------------------
// What the run says: text for the reader, and an exit code for the referee
// ---------------------------------------------------------------------------

export interface Survivor {
  file: string;
  line: number;
  mutator: string;
  replacement: string;
}

export interface Summary {
  total: number;
  caught: number;
  survived: Survivor[];
  unreached: number;
  errors: number;
  /** Mutants tests reach that no test ran against. */
  unproven: number;
  /** Mutants the tool chose not to try, counted by the reason it gave. */
  skipped: Record<string, number>;
}

/**
 * The mutants counted.
 *
 * A skipped mutant is counted apart, by its reason, and left out of the total:
 * it is code a test could have checked, and nobody should read it as checked.
 *
 * **A mutant no test ran against is not a survivor.** It is counted as
 * `unproven`, and one of them makes the whole run prove nothing (`exitFor`). A
 * list that is mostly false alarms is a list nobody reads.
 */
export function summarise(mutants: Mutant[]): Summary {
  const summary: Summary = { total: 0, caught: 0, survived: [], unreached: 0, errors: 0, unproven: 0, skipped: {} };
  for (const mutant of mutants) {
    if (mutant.status === 'skipped') {
      const reason = mutant.reason ?? 'no reason given';
      summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
      continue;
    }
    summary.total += 1;
    if (mutant.status === 'caught') summary.caught += 1;
    else if (mutant.status === 'unreached') summary.unreached += 1;
    else if (mutant.status === 'broke') summary.errors += 1;
    else if (mutant.status === 'notRun') summary.unproven += 1;
    else {
      summary.survived.push({
        file: mutant.file,
        line: mutant.line,
        mutator: mutant.mutator,
        replacement: oneLine(mutant.replacement),
      });
    }
  }
  summary.survived.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return summary;
}

/** A replacement on one short line. Some span a whole block. */
function oneLine(text: string, width = 50): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The exit code for what a run found, by the contract in
 * `src/adapters/README.md`:
 *
 * - 1 when any mutant survived, the run cut off at its budget included: the
 *   survivors it found are real whatever it did not reach.
 * - 2 when the run proves nothing: no test imports the changed code, a mutant
 *   tests reach ran no test, or no mutant was caught at all, which covers a run
 *   cut off before it checked one and a run whose every mutant no test
 *   reaches. A run that tested nothing must not read as clean.
 * - 2 too for a run cut off with no survivor among what it checked: it found
 *   none, and says nothing of the rest.
 * - 0 otherwise.
 */
export function exitFor(answer: Answer): 0 | 1 | 2 {
  if (answer.noTests) return 2;
  const summary = summarise(answer.mutants);
  if (summary.unproven > 0) return 2;
  if (summary.survived.length > 0) return 1;
  if (summary.caught === 0 || answer.stopped) return 2;
  return 0;
}

/**
 * What a run found, as lines for the reader. The referee puts a heading and
 * its own reading of the exit code above them, and passes them on unread.
 *
 * Mutants no test reaches are counted and not listed. Coverage already
 * reports that code. `seconds` is the budget, said when the run stopped at it,
 * so a partial report never reads as a whole one.
 *
 * Lines are kept under 70 characters, so that indented they still read in a
 * terminal.
 */
export function render(answer: Answer, seconds: number | null): string[] {
  if (answer.noTests) {
    return [
      'No test imports the code this change added or changed, so no',
      'mutant could be caught. Coverage reports the same code.',
    ];
  }
  const summary = summarise(answer.mutants);
  if (summary.unproven > 0) {
    return [
      `No test ran against ${plural(summary.unproven, 'mutant')} that tests reach, so this`,
      'run shows nothing. Run it with --verbose to see why.',
    ];
  }
  if (answer.stopped && summary.total === 0) {
    return [
      `It did not finish within ${seconds ?? 0} seconds, before any mutant was`,
      'checked, so it shows nothing this time. Run it by hand to see more.',
    ];
  }
  const parts = [`${summary.caught} caught`, `${summary.survived.length} survived`];
  if (summary.unreached > 0) parts.push(`${summary.unreached} reached by no test`);
  if (summary.errors > 0) parts.push(`${summary.errors} broke the code outright`);
  const lines = answer.stopped ? [`Stopped at its ${seconds ?? 0}-second limit, so this covers part of them.`] : [];
  const counted = answer.stopped ? `${summary.total} of ${plural(answer.planned, 'mutant')}` : plural(summary.total, 'mutant');
  lines.push(`${counted}: ${parts.join(', ')}.`);
  for (const [reason, count] of Object.entries(summary.skipped).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${count} more skipped: ${reason}.`);
  }
  if (summary.caught === 0 && summary.survived.length === 0) {
    lines.push('No test caught or let through any of them, so this run proves nothing.');
  }
  if (summary.survived.length > 0) {
    lines.push('Survived:');
    for (const s of summary.survived) lines.push(`- ${s.file}:${s.line} ${s.mutator} → ${s.replacement}`);
  }
  return lines;
}

/** The argument that names the project's Vitest config for mutation runs. */
export const VITEST_CONFIG_FLAG = '--vitest-config';

/**
 * The project's Vitest config, from the command's arguments, or a reason it
 * is missing. Required: which tests a mutation run uses is the project's
 * call, and a default here would be one project's layout.
 */
export function vitestConfigOf(argv: string[]): string {
  const at = argv.indexOf(VITEST_CONFIG_FLAG);
  const path = at === -1 ? undefined : argv[at + 1];
  if (path === undefined || path === '' || path.startsWith('--')) {
    throw new Error(`mutate: name the project's Vitest config for mutation runs, as ${VITEST_CONFIG_FLAG} <path>`);
  }
  return path;
}

/**
 * The whole of the mutation command, short of the process: reads the request
 * in `input`, asks `run` (Stryker, given the targets in its syntax and whether
 * to log), writes what it found as text through `write`, waiting until it is
 * written, and returns the exit code `exitFor` gives. A request that cannot be
 * read, or a run that fails, is a crash: its message goes to `fail`, nothing
 * is written, and the code is 3, which the referee counts as the command
 * failing. Not 1, which means mutants survived.
 *
 * Stryker removes its sandbox after a run that finishes, and keeps it after one
 * that fails, for debugging. Nobody debugs from here, and each one is a copy of
 * the repository, so it is removed either way, once the run has stopped. A
 * delete that fails goes to `warn`, and changes neither the text nor the
 * exit code.
 */
export async function respond({ input, cwd, run, write, fail, warn, rm = rmSync, reportFile }: {
  input: string;
  cwd: string;
  run: (targets: string[], verbose: boolean) => Run;
  write: (text: string) => void | Promise<void>;
  fail: (message: string) => void;
  warn: (message: string) => void;
  rm?: typeof rmSync;
  /** The executable requests a report. In-process text/exit callers may omit it. */
  reportFile?: string;
}): Promise<0 | 1 | 2 | 3> {
  let code: 0 | 1 | 2 | 3;
  try {
    const request = readRequest(input);
    if (reportFile !== undefined) rmSync(join(cwd, reportFile), { force: true });
    const said = await answer({ request, cwd, run: (targets) => run(targets, request.verbose === true) });
    if (reportFile !== undefined && (said.stopped || said.noTests)) writePartialReport(cwd, reportFile, said.noTests);
    await write(`${render(said, request.budget).join('\n')}\n`);
    code = exitFor(said);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    code = 3;
  }
  const kept = removeSandboxes(cwd, rm);
  if (kept !== null) warn(kept);
  return code;
}
