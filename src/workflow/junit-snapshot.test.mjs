import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSnapshot } from './local-snapshot.mjs';
import { junitArtifacts, writeJUnitSnapshot, readTestAnalysis, writeTestAnalysis, TEST_ANALYSIS } from './junit-snapshot.mjs';
import { testCase, testRun } from '../../tests/fixtures/workflow/quality-results.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'junit-snapshot-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('lists the paths and exact bytes of reports with the same basename, sorted, and writes no manifest', () => {
  const reports = ['slow', 'A'].map(name => ({ name: name + '/run.xml', bytes: Buffer.from(name + '\r\n') }));
  const list = writeJUnitSnapshot('feat/x', reports, root);
  expect(list.map(f => f.name)).toEqual(['A/run.xml', 'slow/run.xml']);
  for (const f of list) {
    expect(Object.keys(f)).toEqual(['name', 'snapshot']);
    expect(f.snapshot).toMatch(/^\.katatay\/local\/feat_x\/junit\/[^/]+_[\w-]{43}\.xml$/);
  }
  expect(readdirSync(join(root, '.katatay/local/feat_x/junit')).filter(f => !f.endsWith('.xml'))).toEqual([]);
  const entries = junitArtifacts(list);
  expect(entries).toEqual(['A', 'slow'].map((folder, index) => ({
    role: 'raw', title: 'JUnit: ' + folder + '/run.xml', snapshot: list[index].snapshot,
  })));
  expect(entries.map(item => readFileSync(join(root, item.snapshot)))).toEqual([reports[1].bytes, reports[0].bytes]);
});

it('keeps an empty capture empty without publishing files', () => {
  expect(junitArtifacts(writeJUnitSnapshot('topic', [], root))).toEqual([]);
  expect(existsSync(join(root, '.katatay'))).toBe(false);
});

function savedRun(run = testRun(), details) {
  const reports = writeJUnitSnapshot('topic', [
    { name: 'fast.xml', bytes: Buffer.from('<testsuite name="fast"/>') },
    { name: 'slow.xml', bytes: Buffer.from('<testsuite name="slow"/>') },
  ], root);
  const analysis = writeTestAnalysis('topic', reports, run, root, details);
  return { reports, evidence: [...reports.map(({ snapshot }) => ({ role: 'raw', snapshot })), { role: 'analysis', snapshot: analysis }] };
}

it.each([
  ['passed', 0, undefined, 'clean', 'Check passed.'],
  ['failed', 1, undefined, 'findings', 'Check failed.'],
  ['failed', 1, { reason: 'Suite timed out.' }, 'findings', 'Suite timed out.'],
])('saves the reason for a %s suite (exit %i, details %j)', (status, exit, details, outcome, reason) => {
  const { evidence } = savedRun(testRun({ cases: [testCase({ status })], exit }), details);
  const saved = JSON.parse(readFileSync(join(root, evidence.at(-1).snapshot), 'utf8'));
  expect(saved.result).toEqual({ outcome, exitCode: exit, text: '', reason });
});

it('identifies a malformed report reference before publishing the test analysis', () => {
  expect(() => writeTestAnalysis('topic', [{ snapshot: '../outside' }], testRun(), root))
    .toThrow('test analysis.measurement.reports[0] must be a snapshot reference');
  expect(existsSync(join(root, '.katatay/local/topic/junit/analysis'))).toBe(false);
});

it('preserves parsed identities, omissions and command signals without a writer setting', () => {
  const run = testRun({ exit: 'SIGTERM',
    cases: [testCase({ name: 'historical test', inverted: true, ids: ['AC0001'], scenarios: ['AC0001.1'], line: 4, endLine: 8 })],
    leftOut: [{ file: 'missing.test.mjs', ids: [], scenarios: [], bare: [] }],
  });
  const { evidence } = savedRun(run);
  const saved = JSON.parse(readFileSync(join(root, evidence.at(-1).snapshot), 'utf8'));
  expect(saved).toEqual({ version: 1, name: 'tests', result: { outcome: 'findings', exitCode: null, text: '', reason: 'Test command stopped by SIGTERM.' },
    measurement: { reports: evidence.slice(0, -1).map(item => item.snapshot), cases: run.cases, leftOut: run.leftOut } });
  run.cases[0].name = 'current test';
  expect(readTestAnalysis('topic', evidence, root)).toEqual({ ...run, exit: null,
    cases: [{ ...run.cases[0], name: 'historical test' }] });
});

it.each([false, true])('reads historical analysis without a receipt status (reported=%s) and rejects extra fields when writing', reported => {
  const { reports } = savedRun();
  const run = testRun({ cases: [testCase()] });
  const older = { ...run, origin: 'an older referee', cases: run.cases.map(test => ({ ...test, retries: 0 })) };
  const document = { version: 1, name: 'tests', result: { outcome: 'clean', exitCode: 0, text: '', reason: 'Passed.' },
    measurement: { reports: reports.map(report => report.snapshot), cases: older.cases, leftOut: [], reported, origin: older.origin }, producer: 'vitest' };
  const analysis = publishSnapshot('topic', TEST_ANALYSIS, Buffer.from(JSON.stringify(document) + '\n'), root);
  const evidence = [...reports.map(({ snapshot }) => ({ role: 'raw', snapshot })), { role: 'analysis', snapshot: analysis }];
  expect(readTestAnalysis('topic', evidence, root)).toEqual({ ...run, cases: older.cases });
  expect(() => writeTestAnalysis('topic', reports, older, root)).toThrow('test evidence.origin is an unknown field');
  expect(() => writeTestAnalysis('topic', reports, { ...run, cases: older.cases }, root))
    .toThrow('test evidence.cases[0].retries is an unknown field');
});

it.each(['raw', 'analysis'])('checks the digest and existence of the %s snapshot before returning test analysis', role => {
  const { evidence } = savedRun();
  const file = join(root, evidence.find(item => item.role === role).snapshot);
  const original = readFileSync(file);
  writeFileSync(file, 'substituted');
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow('SHA-256 digest mismatch');
  rmSync(file);
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow('ENOENT');
  writeFileSync(file, original);
  expect(readTestAnalysis('topic', evidence, root)).toEqual(testRun());
});

it.each(['substituted', 'reordered', 'removed'])('rejects %s raw references even when every remaining snapshot is valid', kind => {
  const { evidence } = savedRun();
  if (kind === 'substituted') evidence[0].snapshot = writeJUnitSnapshot('topic', [{ name: 'other.xml', bytes: Buffer.from('<testsuite name="other"/>') }], root)[0].snapshot;
  if (kind === 'reordered') [evidence[0], evidence[1]] = [evidence[1], evidence[0]];
  if (kind === 'removed') evidence.splice(0, 1);
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow('Test analysis does not match its JUnit reports');
});

it.each(['no raw', 'repeated raw', 'no analysis', 'repeated analysis'])('requires distinct reports and exactly one analysis (%s)', kind => {
  let { evidence } = savedRun();
  if (kind === 'no raw') evidence = evidence.filter(item => item.role !== 'raw');
  if (kind === 'repeated raw') evidence.push(evidence[0]);
  if (kind === 'no analysis') evidence = evidence.filter(item => item.role !== 'analysis');
  if (kind === 'repeated analysis') evidence.push(evidence[2]);
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow(kind === 'no raw' ? 'does not match its JUnit reports' : 'Test evidence requires distinct JUnit reports and one analysis');
});

it.each(['name', 'old format', 'outcome', 'exitCode', 'run', 'json'])('rejects an invalid %s in otherwise digest-valid test analysis', kind => {
  const { evidence } = savedRun();
  const document = JSON.parse(readFileSync(join(root, evidence[2].snapshot), 'utf8'));
  if (kind === 'name') document.name = 'coverage';
  if (kind === 'old format') { Object.assign(document, { version: 1, run: testRun(), reports: document.measurement.reports }); delete document.result; delete document.measurement; }
  if (kind === 'outcome') document.result.outcome = 'findings';
  if (kind === 'exitCode') document.result.exitCode = 'SIGTERM';
  if (kind === 'run') delete document.measurement.cases;
  evidence[2].snapshot = publishSnapshot('topic', TEST_ANALYSIS, Buffer.from(kind === 'json' ? '{' : JSON.stringify(document)), root);
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow();
});

it.each([
  ['malformed historical writer flag', doc => { doc.measurement.reported = 'false'; }, 'test analysis.measurement.reported must be a boolean'],
  ['future version', doc => { doc.version = 2; }, 'test analysis.version has unsupported schema version 2'],
  ['missing reason', doc => { delete doc.result.reason; }, 'test analysis.result.reason is missing'],
  ['reversed source range', doc => { doc.measurement.cases[0].endLine = 4; }, 'test evidence has invalid test lines'],
])('diagnoses a %s when reading a digest-valid test analysis', (_, change, diagnostic) => {
  const { evidence } = savedRun(testRun({ cases: [testCase({ line: 8, endLine: 9 })] }));
  const analysis = evidence.at(-1);
  const doc = JSON.parse(readFileSync(join(root, analysis.snapshot), 'utf8'));
  change(doc);
  analysis.snapshot = publishSnapshot('topic', TEST_ANALYSIS, Buffer.from(JSON.stringify(doc)), root);
  expect(() => readTestAnalysis('topic', evidence, root)).toThrow(diagnostic);
  if (doc.version === 2) expect(() => readTestAnalysis('topic', evidence, root)).toThrow(analysis.snapshot);
});

it('refuses to publish fabricated analysis without distinct reports or a valid parsed run', () => {
  const { reports } = savedRun();
  for (const list of [[], [reports[0], reports[0]]]) {
    expect(() => writeTestAnalysis('topic', list, testRun(), root)).toThrow('Tests require a test report and distinct JUnit references');
  }
  expect(() => writeTestAnalysis('topic', reports, { cases: [], exit: 0 }, root)).toThrow();
});

it('reads an interrupted run without XML and rejects cases attributed to nonexistent reports', () => {
  const leftOut = [{ file: 'suite.test.mjs', ids: [], scenarios: [], bare: [] }];
  const run = testRun({ exit: 'SIGKILL', leftOut });
  const snapshot = writeTestAnalysis('topic', [], run, root);
  const evidence = [{ role: 'analysis', snapshot }];
  expect(readTestAnalysis('topic', evidence, root)).toEqual({ ...run, exit: null });
  const doc = JSON.parse(readFileSync(join(root, snapshot), 'utf8'));
  const altered = () => [{ role: 'analysis', snapshot: publishSnapshot('topic', TEST_ANALYSIS, Buffer.from(JSON.stringify(doc)), root) }];
  doc.result.exitCode = 1;
  expect(() => readTestAnalysis('topic', altered(), root)).toThrow('disagrees with its measurement');
  doc.result.exitCode = null;
  doc.measurement.cases = [testCase()];
  expect(() => readTestAnalysis('topic', altered(), root)).toThrow('disagrees with its measurement');
  expect(() => writeTestAnalysis('topic', [], { ...run, cases: [testCase()] }, root)).toThrow('distinct JUnit references');
});
