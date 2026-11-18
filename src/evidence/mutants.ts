/**
 * Mutation testing on the lines a change added or changed.
 *
 * Coverage says a line ran. It does not say a test would notice if the line
 * were wrong: a test whose assertions became `expect(x).toBeTruthy()` keeps
 * every line it covered. Mutation testing asks the second question. A tool
 * plants a small bug, called a mutant, such as `===` turned into `!==` or a
 * condition replaced with `true`, and runs the tests that reach it. If one
 * fails, the mutant is caught. If none fails, it survived, and either a test is
 * missing an assertion or the mutant changes nothing anyone could observe.
 *
 * Only the lines this change added or changed are mutated, so the cost follows
 * the size of the change, and old code stays unchecked the way the coverage
 * minimums leave it: the check stops things getting worse and asks for no
 * clean-up. The lines come from the diff against the pinned baseline, never
 * from the plan, because the diff is what happened.
 *
 * Survivors are reported and do not block verification. Some mutants change the code without changing
 * behaviour, so no test can ever catch them. The trial on 2026-10-17 found two
 * in 62: removing a `status === 'paid'` filter changed nothing, because only
 * paid orders keep a drawing. Blocking on survivors would need an override,
 * and an override lets real survivors through too.
 *
 * Planting the mutants and running the tests is the language's business, so
 * the referee runs the mutation command the rulebook names (see
 * `src/adapters/README.md`). It reads how the run ended from the exit code
 * and reads the standard report for counts and survivors. This file holds
 * the rest: which lines to mutate, how long the run may take, and what each
 * exit code means to the reader. It is optional, like coverage and apart from
 * it: a mutation entry that says `"none"` switches it off, and the report says so.
 */
import { readFileSync, rmSync } from 'node:fs';
import { checkedOutput, inRoot } from '../workflow/check-output.mjs';
import { MARGIN } from '../workflow/mutation.mjs';
import { AdapterError, matcher, runMutate } from '../workflow/adapter.mjs';
import { parseMutationReport, type Findings } from './mutation-report.mjs';
import { survivorReport } from './mutation-display.mjs';
import { isCode, isFrozen } from '../workflow/frozen.mjs';
import { touchedFiles, touchedTargets } from '../workflow/touched.mjs';
import { command } from '../workflow/commands.mjs';
import { MUTATION_SWITCHED_OFF, readMutation } from '../workflow/rulebook.mjs';

/**
 * Whether a changed file is one to plant mutants in: code, by the adapter's
 * `code` globs, and none of these:
 *
 * - a test, or anything else the freeze covers. A bug planted in a test or its
 *   helpers proves nothing about the code. In one measured run, 9 mutants in
 *   a harness cost 302 test runs, each of them a test that starts processes.
 * - one the rulebook skips, in `checks.testQuality.mutation.exclude`. That is typically the
 *   test runners' and type checker's configs: they decide how the tests run,
 *   and a mutant there would be planted in the thing measuring it. The high-risk
 *   areas are not skipped: a file review must read is still code that tests
 *   reach like any other.
 *
 * It used to be a fixed list of folders, which was one project's layout. Nor
 * is it the folders the coverage minimums name: then a project that switched
 * coverage off would have nothing left to mutate.
 *
 * `root` is where the skip list is read from, so a test can give a rulebook of
 * its own rather than assert what this repository's skips.
 */
const mutableIn = (root: string) => {
  const mutation = readMutation(root);
  if (!mutation) return () => false;
  const skipped = matcher(mutation.exclude!);
  return (file: string): boolean => isCode(file) && !isFrozen(file) && !skipped(file);
};

/** A run of lines to mutate, or a whole file when `lines` is absent. The
 *  same shape as a touched target in `../workflow/touched.mjs`. */
export interface Target {
  file: string;
  lines?: [number, number];
}

/**
 * The ranges to mutate: the lines this change touched (see
 * `../workflow/touched.mjs`, which reads the diff), in the files `mutableIn`
 * accepts. `diff` is the output of `git diff -U0` against the baseline, and
 * `untracked` the files git has not been told about, each counted whole.
 */
export const mutationTargets = (diff: string, untracked: string[] = [], root = process.cwd()): Target[] =>
  inRoot(root, () => touchedTargets(diff, untracked, mutableIn(root)));

/** `mutationTargets` for this working tree against `base`, the baseline sha
 *  the logbook pins. */
export const changedTargets = (base: string, cwd = process.cwd()): Target[] =>
  inRoot(cwd, () => touchedFiles(base, cwd, mutableIn(cwd)));

/**
 * Seconds the adapter may run past its budget before the referee stops it. The
 * adapter is told the budget and keeps it itself; this only catches one that
 * hangs. A run stopped from outside can leave the tool's workers running,
 * which is why the budget is the adapter's to keep.
 *
 * This backstop fits inside the hook's 20-second reporting reserve.
 */
export const BACKSTOP_SECONDS = 5;

/**
 * How a mutation run ended, as the report and the change report read it:
 *
 * - `clean`, `survived`, `nothing`: the command's own exit code, as
 *   `MUTATE_EXITS` in `adapter.mjs` reads it.
 * - `failed`: the command crashed, or there was no baseline to measure from.
 * - `none`: nothing was asked, because mutation is switched off or the change
 *   touches no code.
 */
export type MutationOutcome = 'clean' | 'survived' | 'nothing' | 'failed' | 'none';

/** What `workflow mutate` says, the code it exits with, and how the run
 *  ended. The code follows the outcome; see `EXIT`. */
export interface Outcome {
  code: 0 | 1 | 2 | 3;
  lines: string[];
  outcome: MutationOutcome;
  findings?: Findings;
  /** Original account to keep with the individual findings for later displays. */
  rawReport?: string;
  /** The standard report text parsed for these findings, before another run replaces it. */
  standardReport?: string;
}

/**
 * The exit code of `workflow mutate` for each outcome: the command's own
 * meanings for 0, 1 and 2, and 3 for a run that failed. Nothing asked is 0,
 * because nothing was found wrong; the report says why nothing was asked.
 */
export const EXIT: Record<MutationOutcome, Outcome['code']> = { clean: 0, none: 0, survived: 1, nothing: 2, failed: 3 };

/** The request the mutation command reads on stdin. */
export interface Request {
  targets: Target[];
  budget: number | null;
  verbose: boolean;
}

/** What the mutation command answered: how its run ended, by its exit code,
 *  and the text it printed. */
export interface Answer {
  outcome: 'clean' | 'survived' | 'nothing';
  text: string;
}

/** Asks the mutation command. `timeout` is the backstop, in seconds, or
 *  undefined for none. Throws an `AdapterError` when the command fails. */
export type Ask = (request: Request, timeout: number | undefined) => Answer | Promise<Answer>;

/** The rulebook's mutation command, run from `cwd`. Its stderr is kept, so a
 *  run that fails can say why in the verified message, unless `--verbose`
 *  asked to watch it. */
const askCommand = (cwd: string, command: string): Ask => (request, timeout) =>
  runMutate({ command, root: cwd, input: request, timeout, keepErrors: !request.verbose });

/** The heading of every report of a run, so the reader knows what was mutated. */
export const HEADING = 'Mutation testing on the lines this change added or changed:';

/**
 * The referee's reading of each exit code, said before the tool's own text.
 * The lines are kept under 70 characters, like those in `areas.mjs`, so that
 * indented they still read in a terminal.
 *
 * A 0 is the tool's account. The referee cannot check it: a tool that ran no
 * test at all could say the same. So it is never worded as proof that the tests
 * catch every mutant.
 */
const READING: Record<Answer['outcome'], string[]> = {
  clean: [
    'The tool reports no surviving mutant. That is its account, not',
    'proof that the tests catch every mutant.',
  ],
  survived: [
    'Mutants survived: a test reached each one and none failed. For',
    'each, write the test it shows is missing, or leave it if the',
    'mutant changes nothing anyone could observe.',
  ],
  nothing: [
    'The run proves nothing this time. The tool says why below; run',
    '`' + command('mutate') + '` by hand to see more.',
  ],
};

const outcome = (o: MutationOutcome, lines: string[]): Outcome => ({ code: EXIT[o], lines, outcome: o });

/**
 * The whole of `workflow mutate`, short of printing and exiting, so a test can
 * run it in process. `ask` is the mutation command; the default runs the one
 * the rulebook names.
 *
 * `budget`, in seconds, is the time the caller can give, and the run gets that
 * or the rulebook's `checks.testQuality.mutation.timeLimitSeconds`, whichever is less. The
 * limit is the longest a run may take whatever time the hook has. Measured on
 * 2026-10-17, a product change took about two minutes. A change to the
 * workflow machinery, reached by tests that spawn processes, can take far
 * longer, and a check meant to be cheap should not grow with it. The command is
 * told that limit and stops itself there. A budget that is not a positive
 * number means no limit at all: that is a run by hand, where the person asking
 * can wait.
 *
 * A hook deadline can defer the run before the command starts.
 */
export async function mutate({ base, cwd, budget, deadline = Infinity, verbose = false, ask }: {
  base: string | null | undefined;
  cwd: string;
  budget?: number;
  deadline?: number;
  verbose?: boolean;
  ask?: Ask;
}): Promise<Outcome> {
  const rulebook = readMutation(cwd);
  if (!rulebook) return outcome('none', [`Mutation testing: ${MUTATION_SWITCHED_OFF}.`]);
  if (!base) {
    return outcome('failed', ['There is no baseline to measure from: no plan has been approved on this branch. Pass `--base <sha>`.']);
  }
  const targets = changedTargets(base, cwd);
  if (targets.length === 0) {
    return outcome('none', ['Mutation testing: this change adds or changes no code to mutate, so there is nothing to mutate.']);
  }

  const limit = budget !== undefined && Number.isFinite(budget) && budget > 0 ? Math.min(budget, rulebook.timeLimitSeconds) : null;
  if (deadline - Date.now() < (rulebook.timeLimitSeconds + MARGIN) * 1000) {
    return outcome('none', [`Mutation testing deferred: the hook needs ${rulebook.timeLimitSeconds} seconds for the run and ${MARGIN} seconds in reserve. The plan's run is still pending.`]);
  }
  const reportFile = rulebook.report!;
  try {
    rmSync(checkedOutput(reportFile, cwd), { force: true });
  } catch (error) {
    return outcome('failed', [`Mutation report could not be cleared: ${reportFile}`, String(error)]);
  }
  let answer: Answer;
  try {
    const run = ask ?? askCommand(cwd, rulebook.command);
    answer = await run({ targets, budget: limit, verbose }, limit === null ? undefined : limit + BACKSTOP_SECONDS);
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    return outcome('failed', ['Mutation testing failed before it could say anything:', ...error.message.split('\n').map((l) => `  ${l}`)]);
  }
  const said = answer.text.split('\n').map((l) => (l.trim() === '' ? '' : `  ${l}`));
  let findings: Findings;
  let standardReport: string;
  try {
    standardReport = readFileSync(checkedOutput(reportFile, cwd), 'utf8');
    findings = parseMutationReport(standardReport, answer.outcome);
  } catch (error) {
    return outcome('failed', [HEADING, `  Mutation report failed: ${reportFile}`, `  ${(error as Error).message}`, '', ...said]);
  }
  const lines = [HEADING, ...READING[answer.outcome].map((l) => `  ${l}`), '', ...said];
  if (!findings.survivors.length) return { ...outcome(answer.outcome, lines), findings, standardReport };
  const rawReport = lines.join('\n');
  const grouped = survivorReport(rawReport, findings.survivors).split('\n');
  const display = verbose ? grouped.concat('', 'Raw mutation command output:', said) : grouped;
  return { ...outcome(answer.outcome, display), findings, rawReport, standardReport };
}
