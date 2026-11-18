/**
 * The change report as the operator sees it on `record` and from `workflow
 * report`: what was decided and why, the report's headline counts, and one
 * link to the `declared` or `record_held` event.
 *
 * The headline counts are the report's `summary` lines, the same lines the
 * change file's `## Report` section holds. The full report, every uncovered
 * line and surviving mutant included, is kept in a snapshot the event names,
 * so the detail outlives the chat.
 *
 * A decision is written once, at `record`. `workflow report` reads it back
 * from the snapshot when one exists for the tree, and otherwise builds a
 * preview that no event stands behind.
 */
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { schemaVersion } from './json-fields.mjs';
import { compactReport } from './compact-report.mjs';
import { changeReports, publishSnapshot, readSnapshot } from './local-snapshot.mjs';
import { declarationFor, heldFor } from './phase.mjs';

export const PREVIEW = 'Change report preview. No `record` decision exists for this tree.';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** @typedef {{ uncoveredLines?: number, uncaughtMutants?: number }} Gaps */
/** @param {Gaps} gaps */
export const hasGaps = (gaps) => (gaps.uncoveredLines ?? 0) > 0 || (gaps.uncaughtMutants ?? 0) > 0;

/**
 * Why a change was declared: the report found no gaps (`clean`), tests
 * changed since the verification before (`acted`), or the operator typed
 * `record` again on a held tree (`accepted`). The same inputs as
 * `recordDecision` in `record.mjs`, read in the same order.
 */
export function declaredReason({ gaps, held }) {
  if (held) return 'accepted';
  return hasGaps(gaps) ? 'acted' : 'clean';
}

const DECLARED = {
  clean: 'Change declared. The report found no gaps.',
  acted: 'Change declared. Tests changed since the verification before, so the gaps do not hold it.',
  accepted: 'Change declared. You typed `record` again on the same tree, so you accept the gaps it shows.',
};

/** The gaps that held a change, in words. */
function heldTitle({ uncoveredLines = 0, uncaughtMutants = 0 }) {
  const found = [
    ...(uncoveredLines > 0 ? [`${plural(uncoveredLines, 'touched line')} no test runs`] : []),
    ...(uncaughtMutants > 0 ? [`${plural(uncaughtMutants, 'mutant')} no test caught`] : []),
  ];
  return [`Change held: ${found.join(', and ')}.`,
    'No test changed since the verification before. Type `record` again to declare it as it stands.'].join('\n');
}

/**
 * The first line or lines of the summary, for each way `record` or `workflow
 * report` can end.
 *
 * @param {{ decision: 'declared', reason: 'clean' | 'acted' | 'accepted' }
 *   | { decision: 'record_held', gaps: Gaps }
 *   | { decision: 'incomplete', count: number }
 *   | { decision: 'failed', why: string }
 *   | { decision: 'preview' }
 *   | { decision: 'recorded', event: 'declared' | 'record_held' }} outcome
 */
export function outcomeTitle(outcome) {
  switch (outcome.decision) {
    case 'declared': return DECLARED[outcome.reason];
    case 'record_held': return heldTitle(outcome.gaps);
    case 'incomplete': return `Change not declared: ${plural(outcome.count, 'section')} of the change report could not be read.`;
    case 'failed': return `Change not declared. The change report could not be built: ${outcome.why}`;
    case 'preview': return PREVIEW;
    case 'recorded': return `Change ${outcome.event === 'declared' ? 'declared' : 'held'} on this tree. This is the report recorded with that decision.`;
    default: throw new Error(`unknown change summary outcome ${outcome.decision}`);
  }
}

/**
 * The summary's text. Every unreadable section is listed with its reason:
 * there are only a dozen sections, each one stops the declaration, and no
 * event holds the list when nothing was declared.
 *
 * @param {{ title: string, summary?: string[], problems?: string[], link: string | null }} input
 */
export function changeSummary({ title, summary = [], problems = [], link }) {
  const blocks = [{ lines: summary }];
  if (problems.length > 0) blocks.push({ lines: ['Could not be read:', ...problems.map((p) => `- ${p}`)] });
  return compactReport({ title, blocks, link });
}

/**
 * Keeps the full report a decision was made on.
 *
 * @param {string} branch
 * @param {{ treeFingerprint: string, decision: 'declared' | 'record_held',
 *   lines: string[], summary: string[], gaps: Gaps }} report
 * @returns {string} the snapshot's reference, for the event's `changeReportSnapshot`.
 */
export function writeChangeReport(branch, report, root = process.cwd()) {
  const { treeFingerprint, decision, lines, summary, gaps } = report;
  const bytes = Buffer.from(JSON.stringify({ version: HARNESS_SCHEMA_VERSION, treeFingerprint, decision, lines, summary, gaps }, null, 2) + '\n');
  return publishSnapshot(branch, changeReports, bytes, root);
}

const strings = (value) => Array.isArray(value) && value.every((line) => typeof line === 'string');
const same = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * The report a `declared` or `record_held` event names, checked against the
 * event: the same tree, the same decision, and for a declaration the same
 * summary lines the change file is held to.
 */
export function changeReportEvidence(branch, event, root = process.cwd()) {
  const reference = event.payload.changeReportSnapshot;
  try {
    const bytes = readSnapshot(branch, changeReports, reference, root);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    schemaVersion(data?.version, 'change report.version');
    if (!strings(data.lines) || !strings(data.summary)) throw new Error('invalid change report snapshot');
    if (data.treeFingerprint !== event.payload.treeFingerprint) throw new Error('its tree disagrees with the event');
    if (data.decision !== event.event) throw new Error('its decision disagrees with the event');
    if (event.event === 'declared' && !same(data.summary, event.payload.summary)) {
      throw new Error('its summary disagrees with the declaration');
    }
    return data;
  } catch (error) {
    throw new Error(`${event.event} ${event.seq} ${reference}: ${error.message}`);
  }
}

/**
 * The declaration or hold recorded after this tree's receipt.
 */
export function recordedDecision(live, measurement) {
  return declarationFor(live, measurement) ?? heldFor(live, measurement);
}
