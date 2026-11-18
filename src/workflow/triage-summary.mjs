/**
 * The triage as the operator sees it: the risk, the counts, the surprises and
 * over-predictions by name, then the link to the logbook event that holds the
 * rest.
 *
 * `workflow triage` prints it on the run that recorded the event, and the turn
 * end sends the same text as its `triaged` message. The counts come from the
 * event's payload, the names from the triage snapshot it names. The failure
 * messages stay in the event's JUnit snapshots: one can run to many lines.
 *
 * What the agent does next is not part of it. `workflow triage` prints that
 * after the report, under a line saying it is for the agent. An earlier
 * summary mixed the two, and read as instructions to the operator.
 *
 * A refusal is a short report too, on stderr, linked to its `triage_refused`
 * event when one was recorded.
 */
import { join } from 'node:path';
import { fileFor } from './chain.mjs';
import { compactReport, NAMED, row, trimmed } from './compact-report.mjs';

export { NAMED };
import { triageCounts } from './phase.mjs';
import { triageAnalysisSnapshot, triageEvidence } from './triage-snapshot.mjs';

export const FROZEN = 'Tests are editable. The implementation is frozen at this triage.';
export const TITLE = "Triage of plan's missed predictions and test regressions";
/** The title every triage report opens with, for a tree with an implementation. */
export const TRIAGE_TITLE = `${TITLE}.`;
/** The line that starts the agent's part of `workflow triage`'s output. */
export const FOR_AGENT = 'For the agent, not part of the report:';

/**
 * What to do next, from the counts. "Start with the surprise bucket" was once
 * printed with no surprises in it, which told the agent to read an empty list.
 */
export function advice({ surprise, overPredicted, predicted, notRun }, testOnly) {
  if (testOnly) {
    return ['the suite is green, so write the tests this change is for. Anything they turn red is something they found, and that is the whole point of them.'];
  }
  const steps = [];
  if (surprise.failed > 0 || notRun.unpredicted > 0) steps.push('start with the surprises: they are the part of the change the plan did not predict.');
  if (overPredicted.count > 0) {
    steps.push('check each over-predicted test: the plan expected it to fail and it passed, so either the change did not do what the plan said, or the test does not test what it says.');
  }
  if (predicted.failed > 0) steps.push('fix the predicted failures: the plan saw them coming, and they are failures all the same.');
  if (notRun.predicted > 0) steps.push('get the predicted files that never ran running: their tests have not said anything yet.');
  if (steps.length === 0) steps.push('nothing failed. Write the tests this change needs.');
  return steps;
}

const linkOf = (event, dir) => (event ? join(dir, fileFor(event)) : null);

function title({ implemented }, testOnly) {
  if (implemented !== false) return TRIAGE_TITLE;
  return `${TITLE}, on a tree with no implementation in it${testOnly ? ', as the plan said' : ''}.\nThe counts below are the suite's, not this change's.`;
}

/** @typedef {(rows: string[], noun: string) => string[]} Keep */

/**
 * A named list: its heading, then its rows as `keep` gives them.
 * @param {string} heading @param {string[]} rows @param {string} noun @param {Keep} keep
 * @returns {{ lines: string[] } | null}
 */
function named(heading, rows, noun, keep) {
  if (rows.length === 0) return null;
  return { lines: [heading, ...keep(rows, noun)] };
}

/** Every row, whole: for a report with no details file to point to.
 * @type {Keep} */
export const keepAll = (rows) => rows.map(row);

/**
 * The tests and files a triage names, one block per list that has anything in
 * it. The surprises come first: they are what the plan missed, and what is
 * worth reading. Predicted failures are counted and never named, because the
 * plan named them already. A failing invariant is named under its own heading
 * whether or not it was predicted, so the reason that raised the level to HIGH
 * can say "named below". One the plan did not predict is a surprise as well.
 *
 * `keep` is `trimmed` where the event holds the rest, and `keepAll` where
 * nothing does, as in `req risk`.
 *
 * @param {{ surprises: string[], overPredictions: string[], invariants: string[], predictedNotRun: string[] }} lists
 * @param {Keep} [keep]
 * @returns {Array<{ lines: string[] }>}
 */
export function namedLists({ surprises, overPredictions, invariants, predictedNotRun }, keep = trimmed) {
  return [
    named('Surprises:', surprises, 'surprises', keep),
    named('Over-predictions:', overPredictions, 'over-predictions', keep),
    named('Failing invariants:', invariants, 'failing invariants', keep),
    named('Predicted files that never ran:', predictedNotRun, 'files', keep),
  ].filter((block) => block !== null);
}

/**
 * The surprises, over-predictions, failing invariants and predicted files
 * that never ran by name, or why they cannot be read.
 *
 * The snapshot is read only when there is something to name. A HIGH level
 * with nothing else counted is a failing invariant the plan predicted, which
 * no count in the event shows.
 */
function namesOf(counts, evidence) {
  const { surprise, overPredicted, notRun, level } = counts;
  if (surprise.failed + overPredicted.count + notRun.predicted === 0 && level !== 'HIGH') return [];
  const names = evidence.payload.surprise.names;
  if (evidence.problem || !names) {
    const why = evidence.problem ?? `${triageAnalysisSnapshot(counts)} holds no surprise names, because an earlier version wrote it.`;
    return [{ lines: [`The tests cannot be named: ${why}`] }];
  }
  // A file that never ran comes first: every test in it is unclassified, so it
  // can hide more than any one test, and the limit must not push it out.
  const neverRan = evidence.payload.notRun.unpredicted.map((file) => `${file} — never ran`);
  return namedLists({
    surprises: [...neverRan, ...names],
    overPredictions: evidence.payload.overPredicted.tests,
    invariants: evidence.payload.invariants,
    predictedNotRun: evidence.payload.notRun.predicted,
  });
}

/**
 * The report's blocks, before the link: the level, why, and the counts; what
 * was not checked; then the named lists. Shared by every place a triage is
 * shown, and by `req risk`, so they cannot drift apart.
 *
 * @param {{ level: string, reasons: string[], unchecked?: string[],
 *   predicted: { failed: number, total: number }, surprise: { failed: number, total: number },
 *   overPredicted: { count: number, total: number } }} counts
 * @param {Array<{ lines: string[] }>} named the blocks `namedLists` gives
 * @returns {Array<{ lines: string[] }>}
 */
export function triageBlocks(counts, named) {
  const [ran, ...shares] = triageCounts(counts);
  return [
    { lines: [`Risk: ${counts.level}`, ...counts.reasons, ran, shares.join(' · ')] },
    counts.unchecked?.length ? { lines: counts.unchecked } : null,
    ...named,
  ].filter((block) => block !== null);
}

/**
 * The report of a recorded triage.
 *
 * @param {{ seq: number, event: string, payload: object }} event the `triaged` event
 * @param {{ branch: string, dir: string, testOnly: boolean, root?: string }} options
 *   The logbook and snapshot location, and the test-only flag from the approved plan.
 */
export function triageReport(event, { branch, dir, testOnly, root = process.cwd() }) {
  const counts = event.payload;
  const blocks = triageBlocks(counts, namesOf(counts, triageEvidence(branch, event, root)));
  return compactReport({ title: title(counts, testOnly), blocks, link: linkOf(event, dir) });
}

/** What the agent does next, printed after the report and never posted. */
export function agentNotes(counts, testOnly) {
  const steps = advice(counts, testOnly).map((step, i) => (i === 0 ? 'Next: ' : 'Then ') + step);
  return [FOR_AGENT, ...steps, FROZEN].join('\n');
}

/**
 * The summary of a refusal.
 *
 * @param {{ why: string | string[], list?: string[], next?: string | string[],
 *   event?: { seq: number, event: string } | null, dir?: string }} refusal
 *   `list` is the files or failures the refusal is about, cut to fit. `event`
 *   is the `triage_refused` record, or null when the refusal recorded none.
 */
export function refusalSummary({ why, list = [], next = [], event = null, dir = '' }) {
  const lines = (value) => (Array.isArray(value) ? value : [value]);
  const blocks = [
    { lines: lines(why) },
    list.length ? { lines: list, cut: true } : null,
    lines(next).length ? { lines: lines(next) } : null,
  ].filter(Boolean);
  return compactReport({ title: 'Triage refused.', blocks, link: linkOf(event, dir) });
}
