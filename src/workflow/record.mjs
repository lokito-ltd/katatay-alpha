/**
 * Every `record` on a verified tree runs the change report to decide whether
 * to declare or hold. The decision is the operator's rule from 2026-10-22:
 *
 * - No gaps, or the agent acted on the test-quality report → declared at once.
 *   Further edits void the declaration.
 * - Gaps, and the agent did not act → held. A second `record` on the same
 *   tree declares it.
 *
 * Either way the operator sees the compact change summary, linked to the
 * `declared` or `record_held` event, and the full report is kept in a
 * snapshot that event names.
 *
 * A gap is a touched line no test runs, or a mutant that survived or was
 * unproved in the plan's mutation run.
 *
 * Two consecutive successful verifies under this approval show whether tests
 * changed after the earlier advice. Intervening failures supply no receipt.
 * Changed tests for the same implementation count as action. Whether the edit
 * closed a particular gap is something only a new measurement of that gap
 * can say. `workflow report` shows the summary again without recording anything.
 *
 * Missing evidence stops the declaration on every attempt. Only a complete
 * report can tell the operator which measured gaps they are accepting.
 */

import { validateReport } from './event-format.mjs';
import { changeSummary, declaredReason, hasGaps, outcomeTitle } from './change-summary.mjs';

/** @typedef {import('./change-summary.mjs').Gaps} Gaps */

/** The `record` moment's limit on the report, in milliseconds. The agent
 *  gives the prompt moment a minute by default, and the report took about
 *  four seconds on this repository. */
export const REPORT_TIMEOUT_MS = 40_000;

/**
 * A complete report can declare or hold. An incomplete one stops.
 *
 * @param {{
 *   report: { gaps: Gaps, incomplete: string[] } | null,
 *   held: boolean,
 *   acted: boolean,
 * }} input `report` is null when it could not be built at all; `held` is
 *   whether this tree already has a `record_held`.
 * @returns {'declare' | 'hold' | 'stop'}
 */
export function recordDecision({ report, held, acted }) {
  if (report === null || report.incomplete.length > 0) return 'stop';
  if (held) return 'declare';
  return !hasGaps(report.gaps) || acted ? 'declare' : 'hold';
}

/**
 * The report command's `--json` answer, from its `spawnSync` result, or the
 * reason it gave none.
 *
 * @param {{ status: number | null, stdout?: string | null, stderr?: string | null, error?: Error }} run
 * @returns {{ report: { lines: string[], summary: string[], gaps: Gaps, incomplete: string[], problems?: string[] } } | { failed: string }}
 */
export function readReport(run) {
  if (run.error) return { failed: run.error.message };
  if (run.status !== 0) {
    const why = (run.stderr ?? '').trim().split('\n').slice(-3).join('\n');
    return { failed: why || `it exited with ${run.status}` };
  }
  let answer;
  try {
    answer = JSON.parse(run.stdout ?? '');
  } catch {
    return { failed: 'it printed something that is not JSON' };
  }
  try {
    validateReport(answer, 'report');
    return { report: answer };
  } catch (error) {
    return { failed: error.message };
  }
}

/** The heading the change file opens with. `req:guard --record` checks it. */
export const REPORT_HEADING = '## Report';

/**
 * The `## Report` section the change file opens with, as the agent is asked
 * to write it: the report's summary lines in a text block.
 * The `declared` event keeps the same lines, and `req:guard --record` refuses
 * a change file whose section differs from them.
 *
 * @param {string[]} summary
 */
export function reportSection(summary) {
  return [REPORT_HEADING, '', '```text', ...summary, '```'].join('\n');
}

/** The agent's first instruction on every `record` that ran the report. */
export const SHOW = 'Show the operator this change summary verbatim, first in your reply:';

/** What the agent tells the operator after a hold. */
export const HOLD_REPLY = 'Tell the operator to type `record` again to declare the change as it stands.';

/**
 * The operator's change summary and the agent's next action on `record`.
 *
 * The summary is the operator's: the outcome, the report's headline counts
 * and the event's link (see `change-summary.mjs`). What follows it is for the
 * agent: the accepted analysis on a hold, the request for explanations, and
 * the change file's `## Report` section, which stays out of the chat.
 *
 * @param {{ decision: 'declare' | 'hold' | 'stop', built: ReturnType<typeof readReport>, held: boolean,
 *   acted?: boolean, savedAnalysis?: string, link?: string | null, reportFile?: string }} input
 *   `link` is the new event's path from the repository root, and `reportFile`
 *   the snapshot holding the full report.
 */
export function recordContext({ decision, built, held, savedAnalysis, link = null, reportFile }) {
  if ('failed' in built || built.report.incomplete.length) {
    const summary = 'failed' in built
      ? changeSummary({ title: outcomeTitle({ decision: 'failed', why: built.failed }), link: null })
      : changeSummary({ title: outcomeTitle({ decision: 'incomplete', count: built.report.incomplete.length }),
        summary: built.report.summary, problems: built.report.problems ?? built.report.incomplete, link: null });
    return [SHOW, '', summary, '', 'The change was not declared. Resolve the missing or invalid evidence before recording.'].join('\n');
  }
  const { summary, gaps } = built.report;
  if (decision === 'hold') {
    const shown = changeSummary({ title: outcomeTitle({ decision: 'record_held', gaps }), summary, link });
    // The summary already says what a second `record` does. After the
    // analysis summary it is said again, so it is the last thing read.
    return [SHOW, '', shown, ...(savedAnalysis ? ['', savedAnalysis, '', HOLD_REPLY] : [])].join('\n');
  }
  const shown = changeSummary({ title: outcomeTitle({ decision: 'declared', reason: declaredReason({ gaps, held }) }), summary, link });
  const parts = [SHOW, '', shown, ''];
  if (held && !savedAnalysis) {
    parts.push('Then, under a heading that says these are your explanations and not measurements, say for each '
      + 'touched line no test runs why no test can, and for each surviving mutant why it survived. '
      + 'For unproved mutants, explain the counts by status: reached by no test, pending, or no completed tests. '
      + `Use the measured counts in the full report at ${reportFile}.`, '');
  }
  parts.push(WRITE_CHANGE_FILE, '', reportSection(summary));
  return parts.join('\n');
}

/** The change-file instruction, on the `record` that declares and on a repeated one. */
const WRITE_CHANGE_FILE = 'The operator declared this change finished. Write the change file now. It opens with this section, '
  + 'straight after the title and before `## Why`, exactly as it stands here. The record step checks it against what was declared. '
  + 'Keep the section out of the chat reply:';

/** The commit-message request, at recording and on a repeated `record` after it. */
export const WRITE_COMMIT_MESSAGE = 'Write the commit message now, show it in full, and commit only on the operator\'s yes.';

/** Said on a repeated `record`, before what is still to do. */
export const NOTHING_NEW = 'Nothing new was declared: this tree is already declared, and no event was added.';

/**
 * The declaration's change summary, as `workflow report` shows a recorded
 * decision: the summary lines kept on the `declared` event, and its link.
 *
 * @param {{ summary: string[], link: string }} declaration
 */
export const declaredSummary = ({ summary, link }) =>
  changeSummary({ title: outcomeTitle({ decision: 'recorded', event: 'declared' }), summary, link });

/**
 * What a `record` on a tree already `declared` or `recorded` says. It adds
 * no event and runs no report: the tree has not changed, so the declaration
 * stands. It repeats the handoff that may have been lost, from the logbook,
 * so the operator can always get the change summary and the next step back.
 * The referee cannot see what the agent showed in chat, so it does not try
 * to remember whether this was said before.
 *
 * @param {{ phase: 'declared' | 'recorded', summary: string[], link: string, changeFiles: string[] }} input
 *   `summary` and `link` are the `declared` event's summary lines and path.
 */
export function repeatedRecordContext({ phase, summary, link, changeFiles }) {
  const parts = [SHOW, '', declaredSummary({ summary, link }), '', NOTHING_NEW, ''];
  if (phase === 'recorded') {
    parts.push(`The change is recorded by ${changeFiles.join(', ')}, and every file is staged. ${WRITE_COMMIT_MESSAGE}`);
  } else if (changeFiles.length > 0) {
    parts.push(`The change file is written (${changeFiles.join(', ')}). The next turn end checks it and records the change.`);
  } else {
    parts.push(WRITE_CHANGE_FILE, '', reportSection(summary));
  }
  return parts.join('\n');
}
