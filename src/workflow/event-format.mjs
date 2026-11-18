/** Evidence the referee writes. Both sides of the logbook boundary use these
 * checks; consumers only see events whose required fields are present.
 * Appending refuses unknown fields; reading stored events ignores them
 * (`validateStoredEvent`, and `json-fields.mjs` for why). */
import { STATUSES } from '../evidence/mutation-report.mjs';
import { entryProblems } from './plan-declarations.mjs';
import { checkDocumentFields, validateChecksResults, validateEvidence } from './result-format.mjs';
import { fields, leniently, schemaVersion, versionedReader } from './json-fields.mjs';
import { STATE_FOLDER_PATTERN } from './folder.mjs';

const fail = (at, why) => { throw new Error(`${at} ${why}`); };
const expect = (test, description) => (value, at) => {
  if (!test(value)) fail(at, 'must be ' + description);
};
const string = expect(v => typeof v === 'string', 'a string');
const text = expect(v => typeof v === 'string' && v.trim() !== '', 'nonempty text');
const bool = expect(v => typeof v === 'boolean', 'a boolean');
const count = expect(v => Number.isSafeInteger(v) && v >= 0, 'a nonnegative integer');
const positive = expect(v => Number.isSafeInteger(v) && v > 0, 'a positive integer');
const oneOf = (...values) => expect(v => values.includes(v), values.map(v => JSON.stringify(v)).join(' or '));
const matches = (re, description) => expect(v => typeof v === 'string' && re.test(v), description);
const fingerprint = matches(/^[a-f0-9]{64}$/, 'a SHA-256 fingerprint');
const commit = matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'a Git commit ID');
const nullable = check => (value, at) => { if (value !== null) check(value, at); };
const array = (check, minimum = 0) => (value, at) => {
  if (!Array.isArray(value) || value.length < minimum) fail(at, minimum ? 'must be a nonempty list' : 'must be a list');
  for (const [i, item] of value.entries()) check(item, `${at}[${i}]`);
};
const names = array(text);
/** The most of the agent's checks-analysis summary the logbook keeps, in
 * Unicode code points. The full analysis is kept as local evidence. */
export const SUMMARY_LIMIT = 2000;
const analysisSummary = expect(v => typeof v === 'string' && v.trim() !== '' && [...v].length <= SUMMARY_LIMIT,
  `nonempty text of at most ${SUMMARY_LIMIT} characters`);
const analysisFile = matches(new RegExp(`^${STATE_FOLDER_PATTERN}/local/[^/]+/checks-analysis/\\d{8}T\\d{6}\\.\\d{3}Z_[\\w-]{43}\\.txt$`),
  'a checks analysis snapshot reference');

/**
 * Why a value cannot stand as coverage snapshot references, or null: the raw
 * report the coverage command printed and the referee's analysis of it, each a
 * separate snapshot reference. The paths are checked when they are read.
 * Only readers ask, so other keys are ignored.
 */
export function coverageReferencesProblem(references) {
  if (!references || typeof references !== 'object' || Array.isArray(references)) return 'is not an object';
  for (const key of ['raw', 'analysis']) {
    if (typeof references[key] !== 'string' || references[key].trim() === '') return `.${key} is not a snapshot path`;
  }
  return null;
}

/** The raw mutation report and its derived findings, each a snapshot path.
 * The reader checks the paths against their branch, kind and digest. Only
 * readers ask, so other keys are ignored. */
export function mutationReferencesProblem(references) {
  if (!references || typeof references !== 'object' || Array.isArray(references)) return 'is not an object';
  for (const key of ['raw', 'findings']) {
    if (typeof references[key] !== 'string' || references[key].trim() === '') return `.${key} is not a snapshot path`;
  }
  return null;
}
const requirementFields = fields({ id: text, status: text, statement: text, scenarios: array(string) }, { renumberedFrom: text });
const requirement = (v, at) => {
  requirementFields(v, at);
  const [problem] = entryProblems(v);
  if (problem) fail(at, problem);
};
const point = fields({ line: positive, column: positive });
const findings = fields({
  counts: fields({ total: count, caught: count, survived: count, unproven: count,
    statuses: fields(Object.fromEntries(STATUSES.map(status => [status, count]))) }),
  survivors: array(fields({ file: text, id: string, mutator: string, location: fields({ start: point, end: point }) },
    { replacement: string, sourceLine: matches(/^[^\r\n]*$/, 'one source line') })),
}, { partial: bool });
const treeFingerprint = fingerprint;
const note = nullable(string);
// The report shown at record and the declaration drawn from it must agree
// on what counts as evidence. Blank lines may separate parts of a report.
const reportText = (value, at) => {
  array(string, 1)(value, at);
  if (!value.some(line => line.trim() !== '')) fail(at, 'must contain a nonblank line');
};
const summary = (value, at) => {
  reportText(value, at);
  if (value.some(line => /[\r\n]/.test(line))) fail(at, 'must contain one line per entry');
};
const gaps = fields({}, { uncoveredLines: count, uncaughtMutants: count });
export const validateReport = fields({ lines: reportText, summary, gaps, incomplete: names }, { problems: array(text) });
function rawEvidence(items, at) {
  validateEvidence(items, at);
  if (items.some(item => item.role !== 'raw')) fail(at, 'must contain only raw reports');
}
const attempts = {
  implementation_changed: {},
  measurement_changed: { evidence: rawEvidence },
  invalid_test_run: { message: text, evidence: rawEvidence },
  snapshot_failed: { message: text, evidence: rawEvidence },
  tests_modified: { files: array(text, 1) },
  typecheck_failed: { files: array(text, 1) },
  suite_not_green: { failures: array(text, 1), evidence: rawEvidence },
};
const mutationAnalysisFields = checkDocumentFields('mutation', fields({ toolOutcome: oneOf('clean', 'survived', 'nothing'), findings }));
function currentMutationAnalysis(document, at) {
  mutationAnalysisFields(document, at);
  const { result, measurement: { toolOutcome, findings: { counts, survivors } } } = document;
  if (['clean', 'survived', 'nothing'][result.exitCode] !== toolOutcome) fail(at + '.result.exitCode', 'disagrees with the tool outcome');
  if (result.outcome !== (toolOutcome === 'clean' ? 'clean' : 'findings')) fail(at + '.result.outcome', 'disagrees with the tool outcome');
  text(result.text, at + '.result.text');
  const statuses = counts.statuses;
  if (counts.total !== Object.values(statuses).reduce((a, b) => a + b, 0)
    || counts.caught !== statuses.Killed + statuses.Timeout || counts.survived + counts.unproven !== statuses.Survived
    || counts.survived !== survivors.length) fail(at + '.measurement.findings.counts', 'disagrees with the recorded statuses or survivors');
  if ((toolOutcome === 'clean' && statuses.Survived !== 0) || (toolOutcome === 'survived' && !counts.survived)) {
    fail(at + '.measurement.toolOutcome', 'disagrees with the findings');
  }
}
const readMutationAnalysis = versionedReader(currentMutationAnalysis);
export function validateMutationAnalysis(document, at = 'mutation analysis') {
  readMutationAnalysis(document, at);
}

const triageFields = fields({
  treeFingerprint, level: oneOf('LOW', 'MEDIUM', 'HIGH'), reasons: names, implemented: bool,
  evidence: validateEvidence, testCount: count,
  predicted: fields({ failed: count, total: count }), surprise: fields({ failed: count, total: count }),
  overPredicted: fields({ count, total: count }), notRun: fields({ predicted: count, unpredicted: count }),
  implementationFingerprint: fingerprint,
}, { unchecked: names });
function triageReport(v, at) {
  triageFields(v, at);
  if (v.level === 'LOW' && v.reasons.length !== 0) fail(at + '.reasons', 'must be empty for LOW risk');
  if (v.level !== 'LOW' && (v.reasons.length === 0 || v.reasons.length > 4)) fail(at + '.reasons', 'must contain one to four reasons for raised risk');
  if (v.evidence.filter(item => item.role === 'analysis').length !== 1) fail(at + '.evidence', 'requires one triage analysis');
  const { predicted, surprise, overPredicted, notRun } = v;
  if (predicted.failed > predicted.total || predicted.failed < notRun.predicted) fail(at + '.predicted.failed', 'disagrees with the bucket');
  if (surprise.failed > surprise.total || surprise.failed < notRun.unpredicted) fail(at + '.surprise.failed', 'disagrees with the bucket');
  if (predicted.failed + overPredicted.count !== overPredicted.total) fail(at + '.overPredicted.count', 'disagrees with the prediction total');
}
const approvalFields = fields({
  proposal: fingerprint, testOnly: bool, requirementChanges: array(requirement),
  baseline: commit, planSnapshot: text,
});
/** Who ran a verify, when it was not the turn-end hook: `workflow verify
 *  --rerun`. The hook's events leave it out. */
const trigger = oneOf('rerun');

const payloads = {
  plan_approved: approvalFields,
  replan_requested: fields({ approval: positive }),
  replan_resumed: fields({ request: positive }),
  baseline_moved: fields({ from: commit, to: commit }),
  triaged: triageReport,
  convergence_requested: fields({ triage: positive, reply: fingerprint }),
  triage_refused: (v, at) => {
    const reason = v?.reason;
    oneOf(...Object.keys(attempts))(reason, at + '.reason');
    if (Object.hasOwn(v, 'evidence') && !Object.hasOwn(attempts[reason], 'evidence')) {
      fail(at + '.evidence', 'belongs only to a refusal after the suite ran');
    }
    fields({ reason: text, ...attempts[reason] })(v, at);
  },
  verified: fields({ treeFingerprint, implementationFingerprint: fingerprint, testFingerprint: fingerprint,
    results: validateChecksResults, rulebookFingerprint: fingerprint, baseline: commit }, { trigger }),
  checks_analysis: fields({ verification: positive, summary: analysisSummary, analysisSnapshot: analysisFile }),
  verify_failed: fields({ treeFingerprint, tail: string, rulebookFingerprint: nullable(fingerprint), baseline: commit,
    results: validateChecksResults }, { trigger }),
  record_held: fields({ treeFingerprint, note, changeReportSnapshot: text, gaps }),
  declared: fields({ treeFingerprint, note, gaps, summary, changeReportSnapshot: text }),
  recorded: fields({ treeFingerprint, changes: fingerprint, files: array(text, 1) }),
  // `changeFiles` lists the change files new on the branch when the operator
  // reset: the change epoch they belonged to is abandoned, and they count for
  // nothing after it (`abandonedChangeFiles` in `state.mjs`). Left out when
  // there were none.
  reset: fields({ note }, { changeFiles: array(text, 1) }),
};
export const EVENTS = Object.keys(payloads);

const timestamp = expect(v => typeof v === 'string' && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString() === v, 'a UTC ISO timestamp');
/** Throws on the first invalid field, with its path inside the file. */
function currentEvent(entry, at, seq) {
  fields({ version: schemaVersion, seq: positive, ts: timestamp, prev: seq === 1 ? oneOf(null) : fingerprint,
    ...(seq === 1 ? { branch: text } : {}), event: (v, at) => { if (!EVENTS.includes(v)) fail(at, 'has unknown event type ' + JSON.stringify(v)); },
    payload: (v, at) => payloads[entry.event](v, at) })(entry, at);
  if (entry.seq !== seq) throw new Error(`claims seq ${entry.seq}, but it is entry ${seq}`);
  if (['verified', 'verify_failed'].includes(entry.event)) {
    validateChecksResults(entry.payload.results, 'event.payload.results', seq);
    if (entry.event === 'verified' && entry.payload.results
      .some(result => result.status === 'failed')) throw new Error('event.payload.results cannot contain a failed result on a verified event');
  }
}

export function validateEvent(entry, seq) {
  currentEvent(entry, 'event', seq);
}

const readEvent = versionedReader(currentEvent);

/** `validateEvent` for an event already stored: unknown fields are ignored,
 * so dropping a field from a format never breaks a committed logbook. */
export function validateStoredEvent(entry, seq) {
  leniently(() => readEvent(entry, 'event', seq));
}
