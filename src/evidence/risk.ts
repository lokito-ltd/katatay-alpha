import { fileURLToPath } from 'node:url';
import { current } from '../workflow/state.mjs';
import { COMPILE_OFF } from '../workflow/adapter.mjs';
import { TargetError } from '../workflow/target.mjs';
import { approvedPredictions, PlanEvidenceError } from '../workflow/approved-predictions.mjs';
import { outcomesOf, runTestCommand, type TestRun } from './test-run.js';
import { keepAll, namedLists, TRIAGE_TITLE, triageBlocks } from '../workflow/triage-summary.mjs';
import { compileErrors, splitErrors, withCompileFailures, type TypeError } from './typecheck.js';
import { applyPrediction } from './predicted.js';

export interface TestOutcome {
  file: string;
  title: string;
  ids: string[];
  /** Scenario ids, such as `AC0009.2`, which a prediction can name. */
  scenarios?: string[];
  failed: boolean;
  /** The lines the test spans, 1-based, when the reporter gave them. */
  line?: number;
  endLine?: number;
  /** Set when the failure is not a runtime one, such as a test that does not compile. */
  reason?: string;
  /** Set when the file's tests never ran at all, so nothing in it was classified. */
  didNotRun?: boolean;
  /** Set when the outcome stands for a whole file rather than one test. */
  wholeFile?: boolean;
}

export interface RiskInput {
  /** The plan's `predicted-failures`, as the approval recorded them. */
  predictions: readonly string[];
  tests: TestOutcome[];
  /** What was not checked because the adapter says the language lacks it,
   *  one line each, said in the report. */
  unchecked?: string[];
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Bucket {
  failed: number;
  total: number;
  /** The failing tests themselves, as `file — title (failure message)`. A
   *  count tells the operator a bucket is red. Only the names tell them where
   *  to look. A file that never ran is counted here and named in `notRun`
   *  instead. */
  failures: string[];
  /** The same tests as `file — title`, without the message, which can run to
   *  many lines. The triage report lists these. */
  names: string[];
}

/** The tests the plan said would fail and that passed, out of every test it
 *  predicted. See `applyPrediction` in `predicted.ts`. */
export interface OverPrediction {
  count: number;
  /** How many tests the plan predicted would fail. */
  total: number;
  tests: string[];
}

/** The test files the test report leaves out, by whether the plan predicted
 *  them. Each is one failed outcome in its bucket's counts, and named here
 *  only, so a file carries one label. */
export interface NotRun {
  predicted: string[];
  unpredicted: string[];
}

/**
 * Why the level is what it is, written for the operator rather than for the
 * author of the check. One sentence. The tests or files it is about are named
 * in the report's lists, which the sentence points to.
 */
export interface Reason {
  text: string;
}

export interface RiskReport {
  level: RiskLevel;
  /** Failures the plan predicted. */
  predicted: Bucket;
  /** Failures it did not. */
  surprise: Bucket;
  /** Tests it predicted would fail that passed. */
  overPredicted: OverPrediction;
  notRun: NotRun;
  /** The failing invariant tests, as `file — title`, predicted or not. */
  invariants: string[];
  /** What raised the level. Empty at LOW. */
  reasons: Reason[];
  /** What the report could not look at, because the adapter says the language
   *  lacks it. Said, so a report built without them does not read as one
   *  built with them. */
  unchecked: string[];
}

/** How a file that never ran is named among the failures. */
const NEVER_RAN = 'never ran: it failed to load, or the run never reached it';

/**
 * Every failure the report holds, files that never ran included.
 *
 * The buckets are disjoint by construction — a test lands in exactly one — so
 * summing them is the count of failing tests rather than a count of bucket
 * memberships.
 *
 * Here because a caller that reached into the buckets by hand would be
 * deciding for itself that they are the whole report, and would go on saying
 * so after another bucket existed. The test-only refusal names these.
 */
export const allFailures = (report: RiskReport): string[] => [
  ...report.predicted.failures,
  ...report.surprise.failures,
  ...[...report.notRun.predicted, ...report.notRun.unpredicted].map((file) => `${file} — ${NEVER_RAN}`),
];

export const totalFailures = (report: RiskReport): number =>
  report.predicted.failed + report.surprise.failed;

/**
 * Whether `part` is 20% or more of the predicted tests. Both of the plan's
 * misses are measured against the size of its own prediction, which grows
 * with the change. A share of the whole suite, as the triage once used,
 * grows weaker with every test the project adds.
 *
 * With nothing predicted, any miss is all of it.
 */
const fifthOrMore = (part: number, predicted: number): boolean => part > 0 && part * 5 >= predicted;

/**
 * The risk rules, as a pure function.
 *
 * The level measures two things, and nothing else: the plan's missed
 * predictions, and test regressions. A failure the plan did not predict is a
 * surprise, and is both: the plan missed an effect, and a test that should
 * still pass broke. A test it predicted would fail that passed is an
 * over-prediction, and shows it did not know what the change would do. It is
 * also what padding looks like: a plan that lists every test to hide its
 * surprises.
 *
 * A diff in a high-risk area used to raise the level too. It reads only the
 * diff, so it said nothing about either, and it made most triages HIGH. The
 * reviewer still gets those files under "Must look" (`areas.mjs`).
 *
 * Severity is evaluated HIGH → MEDIUM → LOW, and the highest wins.
 */
export function assess(input: RiskInput): RiskReport {
  const { predictions, tests, unchecked = [] } = input;

  const prediction = applyPrediction(predictions, tests);
  const predicted: Bucket = { failed: 0, total: 0, failures: [], names: [] };
  const surprise: Bucket = { failed: 0, total: 0, failures: [], names: [] };
  const notRun: NotRun = { predicted: [], unpredicted: [] };

  for (const test of tests) {
    const isPredicted = prediction.isPredicted(test);
    const bucket = isPredicted ? predicted : surprise;
    bucket.total += 1;
    if (!test.failed) continue;
    bucket.failed += 1;
    if (test.didNotRun) {
      const files = isPredicted ? notRun.predicted : notRun.unpredicted;
      if (!files.includes(test.file)) files.push(test.file);
    } else {
      bucket.failures.push(`${test.file} — ${test.title}${test.reason ? ` (${test.reason})` : ''}`);
      bucket.names.push(`${test.file} — ${test.title}`);
    }
  }
  const overPredicted: OverPrediction = {
    count: prediction.overPredicted.length,
    total: prediction.count,
    tests: prediction.overPredicted,
  };

  const high: Reason[] = [];
  const medium: Reason[] = [];

  // A regression. An invariant must hold however the state was reached, so a
  // failing one is never an acceptable place to stop, whatever share of the
  // suite it is, and predicting it does not excuse it.
  const invariants = tests.filter((t) => t.failed && t.ids.some((id) => id.startsWith('INV'))).map((t) => `${t.file} — ${t.title}`);
  if (invariants.length > 0) high.push({ text: 'Raised to HIGH by failing invariants, named below.' });

  // A file whose tests never ran says nothing about this change, in either
  // direction. On 2026-10-04 a test server failed to start, the runner ran
  // nothing at all, and the triage recorded "0 tests ran, 0 failed, risk LOW".
  // One the plan predicted raises nothing: the plan saw it coming, which the
  // operator decided on 2026-11-01. It is named all the same.
  if (notRun.unpredicted.length > 0) {
    high.push({ text: 'Raised to HIGH by test files the plan did not predict that never ran, named below among the surprises: nothing in them was classified.' });
  }

  // Missed predictions, measured against the size of the prediction.
  const p = overPredicted.total;
  if (fifthOrMore(surprise.failed, p)) {
    high.push({ text: `Raised to HIGH by surprise failures: ${surprise.failed} against ${p} predicted, 20% or more.` });
  } else if (surprise.failed > 0) {
    medium.push({ text: 'Raised to MEDIUM by a surprise failure.' });
  }

  if (fifthOrMore(overPredicted.count, p)) {
    high.push({ text: `Raised to HIGH by over-predictions: ${overPredicted.count} of ${p} predicted failures passed, 20% or more.` });
  } else if (overPredicted.count > 0) {
    medium.push({ text: 'Raised to MEDIUM by an over-prediction: a test the plan said would fail passed.' });
  }

  const report = { predicted, surprise, overPredicted, notRun, invariants, unchecked };
  if (high.length > 0) return { level: 'HIGH', ...report, reasons: high };
  if (medium.length > 0) return { level: 'MEDIUM', ...report, reasons: medium };
  return { level: 'LOW', ...report, reasons: [] };
}

// ---------------------------------------------------------------- CLI

/**
 * The suite's results, from the rulebook's test command and the JUnit reports
 * it writes, with a test that does not compile counted as failed. See
 * `typecheck.ts` for why, and `outcomesOf` in `test-run.ts` for the outcomes
 * that stand for a whole file or for the run.
 *
 * `typeErrors` is passed in by a caller that has already asked for them, so
 * the compile step does not run twice. `null` means the adapter has none.
 */
export function runTests(typeErrors: TypeError[] | null, run: TestRun = runTestCommand({ shown: false })): TestOutcome[] {
  const outcomes: TestOutcome[] = outcomesOf(run);
  return typeErrors === null ? outcomes : withCompileFailures(outcomes, splitErrors(typeErrors).inTests, run);
}

/**
 * The whole computation behind the report: what the plan predicted would
 * fail, and how the suite answered.
 *
 * Exported because the triage needs exactly this and must not reimplement it.
 * Two paths that were supposed to agree and drifted apart is the failure this
 * repository keeps finding in itself. The triage passes the run in, because it
 * also stores the test list the run holds.
 */
export function assessChange(
  typeErrors: TypeError[] | null = compileErrors(),
  predictions: readonly string[] = [],
  run: TestRun = runTestCommand({ shown: false }),
): RiskReport {
  const unchecked = typeErrors === null ? [`${COMPILE_OFF}: a test that runs green while it would not compile counts as passing`] : [];
  return assess({ predictions, tests: runTests(typeErrors, run), unchecked });
}

/** The report as an operator reads it, one line each. Printing only: what a
 *  level means is each caller's decision, and the callers disagree on purpose.
 *
 *  The triage's own layout, from the same blocks (`triageBlocks` in
 *  `triage-summary.mjs`), so the two cannot drift apart: the title, the level
 *  and why, the counts, what was not checked, then the named lists. It has no
 *  link and no notes for the agent, because it records nothing. Its lists are
 *  never trimmed, because there is no event to hold the rest. */
export function renderLines(report: RiskReport): string[] {
  const named = namedLists({
    surprises: [...report.notRun.unpredicted.map((file) => `${file} — never ran`), ...report.surprise.names],
    overPredictions: report.overPredicted.tests,
    invariants: report.invariants,
    predictedNotRun: report.notRun.predicted,
  }, keepAll);
  const blocks = triageBlocks({ ...report, reasons: report.reasons.map((reason) => reason.text) }, named);
  return [TRIAGE_TITLE, ...blocks.flatMap((block) => ['', ...block.lines])];
}

export function render(report: RiskReport): void {
  console.log(renderLines(report).join('\n'));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // Against the approved plan's predictions, as the triage measures it, so
  // the two reports agree.
  let report: RiskReport;
  try {
    const state = current();
    if (state.broken) throw new PlanEvidenceError(`the workflow state chain is broken: ${state.broken}`);
    const predictions = state.grant ? approvedPredictions(state.branch, state.grant) : [];
    report = assessChange(compileErrors(), predictions);
  } catch (error) {
    if (!(error instanceof TargetError || error instanceof PlanEvidenceError)) throw error;
    console.error(`req:risk: refused — ${error.message}`);
    process.exit(1);
  }
  render(report);

  if (report.level !== 'LOW') {
    console.error(`Stop here. ${report.level} needs the operator to look — no approval clears it.`);
    process.exit(1);
  }
}
