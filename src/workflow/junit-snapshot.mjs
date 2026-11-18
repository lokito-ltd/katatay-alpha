import { publishSnapshot, readNamedSnapshot } from './local-snapshot.mjs';
import { isDeepStrictEqual } from 'node:util';
import { brief, checkDocument, successfulTestRun, testDocumentFields, validateTestRun } from './result-format.mjs';
import { leniently, versionedReader } from './json-fields.mjs';

const xml = { folder: 'junit', extension: 'xml', label: 'JUnit XML' };
export const TEST_ANALYSIS = { folder: 'junit/analysis', extension: 'json', label: 'test analysis' };

/** Bind the command outcome and parsed cases to the exact XML used at verification. */
export function writeTestAnalysis(branch, reports, run, root = process.cwd(), details = {}) {
  validateTestRun(run);
  const snapshots = reports.map(report => report.snapshot);
  const signal = typeof run.exit === 'string' ? run.exit : null;
  if ((!snapshots.length && (!signal || run.cases.length)) || new Set(snapshots).size !== snapshots.length) {
    throw new Error('Tests require a test report and distinct JUnit references unless stopped before writing XML');
  }
  const outcome = successfulTestRun(run) ? 'clean' : 'findings';
  const reason = signal ? `Test command stopped by ${signal}.` : details.reason ?? (outcome === 'clean' ? 'Check passed.' : 'Check failed.');
  const { cases, leftOut } = run;
  const document = checkDocument('tests', { outcome, code: signal ? null : run.exit, text: details.text ?? '', reason },
    { reports: snapshots, cases, leftOut });
  testDocumentFields(document, 'test analysis');
  return publishSnapshot(branch, TEST_ANALYSIS, Buffer.from(JSON.stringify(document) + '\n'), root);
}

export function readTestAnalysis(branch, evidence, root = process.cwd(), status = undefined) {
  const reports = evidence.filter(item => item.role === 'raw').map(item => item.snapshot);
  const analyses = evidence.filter(item => item.role === 'analysis');
  if (new Set(reports).size !== reports.length || analyses.length !== 1) {
    throw new Error('Test evidence requires distinct JUnit reports and one analysis');
  }
  for (const report of reports) readNamedSnapshot(branch, xml, report, root);
  const document = JSON.parse(readNamedSnapshot(branch, TEST_ANALYSIS, analyses[0].snapshot, root).toString('utf8'));
  return leniently(() => readTestDocument(document, `${analyses[0].snapshot}: test analysis`, reports, status));
}

const readTestDocument = versionedReader((document, at, reports, status) => {
  testDocumentFields(document, at);
  const { measurement, result } = document;
  if (!isDeepStrictEqual(measurement.reports, reports)) throw new Error('Test analysis does not match its JUnit reports');
  const { cases, leftOut } = measurement;
  // Earlier receipts were partial when the project configured no writer.
  // Validate their status from the original snapshot, independent of today's rulebook.
  if (Object.hasOwn(measurement, 'reported') && typeof measurement.reported !== 'boolean') {
    throw new Error('test analysis.measurement.reported must be a boolean');
  }
  if ((status === 'ok' || status === 'partial') && (status === 'partial') !== (measurement.reported === false)) {
    throw new Error('Test summary or status differs from its evidence');
  }
  const run = { cases, leftOut, exit: result.exitCode };
  validateTestRun(run);
  if (result.outcome !== (successfulTestRun(run) ? 'clean' : 'findings')
    || (!reports.length && (run.exit !== null || cases.length))) {
    throw new Error('Test command result disagrees with its measurement');
  }
  return run;
});

/** Publish each report's exact bytes and keep its original name for the evidence title.
 * The event is appended after this returns, so it can only name complete files. */
export function writeJUnitSnapshot(branch, reports, root = process.cwd()) {
  return [...reports]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, bytes }) => ({ name, snapshot: publishSnapshot(branch, xml, bytes, root) }));
}

/** @param {{ name: string, snapshot: string }[]} reports Archived XML in report-name order. */
export function junitArtifacts(reports) {
  return reports.map(({ name, snapshot }) => ({ role: 'raw', title: brief(`JUnit: ${name}`), snapshot }));
}
