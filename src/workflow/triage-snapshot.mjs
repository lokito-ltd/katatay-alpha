// Both sections describe the frozen run. Readers check the whole file before
// using either section, including when the caller only wants the names.
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { publishSnapshot, readSnapshot } from './local-snapshot.mjs';
import { schemaVersion } from './json-fields.mjs';

const kind = { folder: 'triage', extension: 'json', label: 'triage' };
const testCount = list => list.tests.reduce((n, group) => n + group.titles.length, 0);

const sortedStrings = values => Array.isArray(values) && values.every((s, i) =>
  typeof s === 'string' && (i === 0 || values[i - 1] < s));

function validIdentities(list) {
  return Array.isArray(list?.tests) && sortedStrings(list.unlisted)
    && sortedStrings(list.tests.map(group => group?.file))
    && list.tests.every(group => group.file && sortedStrings(group.titles) && group.titles.length > 0);
}

export function writeTriageSnapshot(branch, identities, report, root = process.cwd()) {
  const { surprise, overPredicted, notRun } = report;
  // The event carries the reason sentences. The failing invariant tests are
  // named here only, so the event stays free of test names.
  const invariants = report.invariants ?? [];
  // The surprises by name alone, for the operator's report. A failure's
  // message can run to many lines, so `surprises` keeps it and this does not.
  const surpriseNames = surprise.names;
  const details = { surprises: surprise.failures, ...(surpriseNames ? { surpriseNames } : {}),
    overPredictions: overPredicted.tests, notRun, invariants };
  const bytes = Buffer.from(JSON.stringify({ version: HARNESS_SCHEMA_VERSION, identities, details }, null, 2) + '\n');
  return {
    evidence: [{ role: 'analysis', title: 'Triage analysis', snapshot: publishSnapshot(branch, kind, bytes, root) }],
    testCount: testCount(identities),
    predicted: { failed: report.predicted.failed, total: report.predicted.total },
    surprise: { failed: surprise.failed, total: surprise.total },
    overPredicted: { count: overPredicted.count, total: overPredicted.total },
    notRun: { predicted: notRun.predicted.length, unpredicted: notRun.unpredicted.length },
  };
}

const names = items => Array.isArray(items) && items.every(item => typeof item === 'string' && item.trim() !== '');

function validateSnapshot(data, payload) {
  schemaVersion(data?.version, 'triage.version');
  if (!validIdentities(data.identities)) throw new Error('invalid triage snapshot identities or version');
  const { surprises, overPredictions, notRun } = data.details ?? {};
  if (![surprises, overPredictions, notRun?.predicted, notRun?.unpredicted].every(names)) {
    throw new Error('invalid triage snapshot details');
  }
  // Optional: snapshots written before the invariants were kept have none.
  const { invariants } = data.details;
  if (invariants !== undefined && !names(invariants)) throw new Error('invalid triage snapshot invariants');
  // Optional: older snapshots kept the reasons, with the invariant tests as
  // the items of their reason. Read for those names; newer ones write none.
  const { reasons } = data.details;
  if (reasons !== undefined && !(Array.isArray(reasons)
    && reasons.every(r => typeof r?.text === 'string' && r.text.trim() !== '' && (r.items === undefined || names(r.items))))) {
    throw new Error('invalid triage snapshot reasons');
  }
  // Optional: snapshots written before the names were kept have none.
  const { surpriseNames } = data.details;
  if (surpriseNames !== undefined && !(names(surpriseNames) && surpriseNames.length === surprises.length)) {
    throw new Error('invalid triage snapshot surprise names');
  }
  if (testCount(data.identities) !== payload.testCount
    || surprises.length + notRun.unpredicted.length !== payload.surprise.failed
    || overPredictions.length !== payload.overPredicted.count
    || notRun.predicted.length !== payload.notRun.predicted || notRun.unpredicted.length !== payload.notRun.unpredicted) {
    throw new Error('event counts disagree');
  }
  const omitted = [...notRun.predicted, ...notRun.unpredicted].sort();
  if (omitted.length !== data.identities.unlisted.length || omitted.some((file, i) => file !== data.identities.unlisted[i])) {
    throw new Error('omitted files disagree between sections');
  }
}

export const triageAnalysisSnapshot = payload => payload.evidence.find(item => item.role === 'analysis').snapshot;

export function triageEvidence(branch, { seq, payload }, root = process.cwd()) {
  const reference = triageAnalysisSnapshot(payload);
  try {
    const bytes = readSnapshot(branch, kind, reference, root);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validateSnapshot(data, payload);
    const { surprises, surpriseNames, overPredictions, notRun, reasons = [] } = data.details;
    const invariants = data.details.invariants ?? reasons.flatMap(reason => reason.items ?? []);
    return { identities: data.identities, payload: { ...payload, invariants,
      surprise: { ...payload.surprise, failures: surprises, ...(surpriseNames ? { names: surpriseNames } : {}) },
      overPredicted: { ...payload.overPredicted, tests: overPredictions }, notRun } };
  } catch (error) {
    const problem = `triage ${seq} ${reference}: ${error.message}. Restore the exact snapshot or re-triage with the baseline tests.`;
    return { payload, problem };
  }
}
