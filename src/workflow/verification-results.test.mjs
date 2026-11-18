import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { producerOf, verificationResults, validateVerificationEvidence } from './verification-results.mjs';
import { verificationSummary } from './verification-summary.mjs';
import { validateChecksResults } from './result-format.mjs';
import { current } from './state.mjs';
import { append, dirFor, fileFor, sha256 } from './chain.mjs';
import { verificationInputs, verified, approval, treeFingerprint } from '../../tests/fixtures/workflow/events.mjs';
import { TEST_ANALYSIS, readTestAnalysis, writeJUnitSnapshot } from './junit-snapshot.mjs';
import { testCase, testRun } from '../../tests/fixtures/workflow/quality-results.mjs';
import { writeCoverageSnapshot } from './coverage-snapshot.mjs';
import { writeMutationSnapshot } from './mutation-snapshot.mjs';
import { publishSnapshot } from './local-snapshot.mjs';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

vi.mock('./state.mjs', () => ({ current: vi.fn() }));
const branch = 'topic';
let root, live;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verification-results-'));
  live = [];
  current.mockImplementation(() => ({ live, branch, ...verificationInputs }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const configuration = [{ name: 'coverage' }, { name: 'mutation', onFailure: 'report' }, { name: 'audit', onFailure: 'report' }];
const make = (configured = configuration) => verificationResults(branch, configured, ['compile', 'tests', 'req:trace'], root);
const get = (collector, name) => collector.results.find(item => item.name === name);
const record = (collector, name, values = {}, run) => collector.record({ name, outcome: 'clean', code: 0, reason: 'Completed.', text: '',
  baseline: verificationInputs.baseline, onFailure: name === 'mutation' || name === 'audit' ? 'report' : 'block', ...values }, run);
const bytes = evidence => readFileSync(join(root, evidence.snapshot), 'utf8');
const add = (event, payload) => { const entry = append(join(root, dirFor(branch)), event, payload, branch); live.push(entry); return entry; };
const grant = () => add('plan_approved', approval());
const verify = (collector, expected = {}) => validateVerificationEvidence(collector.results, { branch, root, live, ...verificationInputs, before: live.length + 1, treeFingerprint, ...expected });
const audit = { name: 'audit', chain: 'testQuality', outcome: 'findings', code: 1, text: 'One warning.\nDetails.', reason: 'Warning.', treeFingerprint };

function keepMutation(statuses = ['Survived', 'NoCoverage']) {
  const report = reportOf(statuses.map((status, i) => mutant(status, { id: String(i) })));
  const findings = findingsOf(report);
  const outcome = findings.counts.survived ? 'survived' : statuses.includes('NoCoverage') ? 'nothing' : 'clean';
  const status = { survived: 1, nothing: 2, clean: 0 }[outcome];
  return writeMutationSnapshot(branch, { raw: JSON.stringify(report), status, outcome, findings, report: 'Mutation results.' }, root);
}
const measuredCoverage = () => ({ folders: [{ folder: 'modules/', files: 1,
  lines: { covered: 1, total: 2, measured: 500, minimum: 0 }, branches: { covered: 0, total: 0, measured: 1000, minimum: 0 } }],
failures: [], touched: { covered: 0, total: 1, uncovered: [{ file: 'modules/a.ts', lines: [2] }] } });
function keepCoverage(coverage = measuredCoverage(), outcome = 'clean') {
  return writeCoverageSnapshot(branch, { raw: 'SF:modules/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n',
    analysis: JSON.stringify({ version: 1, name: 'coverage', result: { outcome, exitCode: 0, text: '', reason: 'Completed.' }, measurement: coverage }) }, root);
}

it('keeps execution order, explicitly marks omissions and emits one ordered result list', () => {
  const collector = make([{ name: 'second' }, { name: 'first' }]);
  expect(collector.results.map(item => item.name)).toEqual(['compile', 'tests', 'req:trace', 'coverage', 'mutation', 'second', 'first']);
  expect(collector.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name))).toMatchObject([
    { name: 'tests', status: 'skipped', reason: 'An earlier step stopped verification.', evidence: [], summary: {} },
    { name: 'coverage', status: 'skipped', reason: 'Disabled in the rulebook.' },
    { name: 'mutation', status: 'skipped', reason: 'Disabled in the rulebook.' },
  ]);
  expect(() => validateChecksResults(collector.results)).not.toThrow();
});

it('keeps multiple test snapshots and counts outcomes without treating a missing reporter as a skipped suite', () => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [
    { name: 'reports/fast.xml', bytes: Buffer.from('<testsuites/>') },
    { name: 'reports/slow.xml', bytes: Buffer.from('<testsuites></testsuites>') },
  ], root);
  const run = { exit: 0, leftOut: [], cases: [
    testCase({ inverted: true }), testCase({ status: 'skipped' }), testCase(),
  ] };
  expect(record(collector, 'tests', { outcome: 'clean', reason: 'Check passed.' }, { junitReports: reports, tests: run })).toBe(true);
  const result = get(collector, 'tests');
  expect(result.status).toBe('ok');
  expect(result.summary).toEqual({ total: 3, passed: 2, skipped: 1, failed: 0, inverted: 1, omittedFiles: 0 });
  expect(result.evidence.filter(item => item.role === 'raw').map(item => item.snapshot)).toEqual(reports.map(item => item.snapshot));
  expect(result.evidence.filter(item => item.role === 'raw').map(bytes)).toEqual(['<testsuites/>', '<testsuites></testsuites>']);
  expect(readTestAnalysis(branch, result.evidence, root)).toEqual(run);
  expect(() => verify(collector)).not.toThrow();
});

it('keeps failed test measurements, omitted files and command signals', () => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  expect(record(collector, 'tests', { outcome: 'findings' }, { junitReports: reports,
    tests: testRun({ exit: 'SIGTERM', cases: [testCase({ status: 'failed' })], leftOut: [{ file: 'missing.test.ts', ids: [], scenarios: [], bare: [] }] }) })).toBe(true);
  expect(get(collector, 'tests')).toMatchObject({ status: 'failed', summary: { total: 1, failed: 1, omittedFiles: 1 } });
  expect(readTestAnalysis(branch, get(collector, 'tests').evidence, root)).toMatchObject({ exit: null, leftOut: [{ file: 'missing.test.ts' }] });
});

it('retains unparsed JUnit bytes and valid titles when a test step throws after capture', () => {
  const collector = make();
  const name = `reports/${'🧬'.repeat(300)}.xml`;
  const reports = writeJUnitSnapshot(branch, [{ name, bytes: Buffer.from('all green') }], root);
  expect(collector.fail('tests', Error('XML could not be parsed.'), { junitReports: reports })).toBe(false);
  const result = get(collector, 'tests');
  expect(result).toMatchObject({ status: 'failed', summary: { diagnostics: 'XML could not be parsed.' },
    evidence: [{ role: 'raw', snapshot: reports[0].snapshot }] });
  expect(result.evidence.map(bytes)).toEqual(['all green']);
  expect(result.evidence[0].title).toMatch(/^JUnit: reports\/🧬.*…$/u);
  expect([...result.evidence[0].title]).toHaveLength(256);
  expect(collector.problem('tests')).toBe('XML could not be parsed.');
  expect(() => verify(collector)).not.toThrow();
});

it('keeps the original failure diagnostic when a captured JUnit reference is malformed', () => {
  const collector = make();
  expect(collector.fail('tests', Error('Report capture failed.'), {
    junitReports: [{ name: 'run.xml', snapshot: '../outside.xml' }],
  })).toBe(false);
  expect(get(collector, 'tests')).toMatchObject({ status: 'failed', evidence: [],
    summary: { diagnostics: 'Report capture failed.' } });
  expect(() => validateChecksResults(collector.results)).not.toThrow();
});

it('refuses an otherwise passing test measurement when no JUnit reports were captured', () => {
  const collector = make();
  expect(record(collector, 'tests', {}, {
    tests: { exit: 0, leftOut: [], cases: [{ status: 'passed', inverted: false }] },
  })).toBe(false);
  expect(get(collector, 'tests')).toMatchObject({ status: 'failed', evidence: [],
    summary: { diagnostics: expect.stringContaining('require a test report') } });
  expect(collector.problem('tests')).toContain('require a test report');
  expect(() => validateChecksResults(collector.results)).not.toThrow();
});

it('keeps the interrupted suite analysis when the collector received no JUnit references', () => {
  const collector = make();
  const leftOut = [{ file: 'suite.test.mjs', ids: [], scenarios: [], bare: [] }];
  expect(record(collector, 'tests', { outcome: 'findings', reason: 'Test command stopped by SIGTERM.' },
    { tests: testRun({ exit: 'SIGTERM', leftOut }) })).toBe(true);
  const tests = get(collector, 'tests');
  expect(tests.status).toBe('failed');
  expect(tests.evidence.map(item => item.role)).toEqual(['analysis']);
  expect(JSON.parse(bytes(tests.evidence[0]))).toEqual({ version: 1, name: 'tests',
    result: { outcome: 'findings', exitCode: null, text: '', reason: 'Test command stopped by SIGTERM.' },
    measurement: { reports: [], cases: [], leftOut } });
});

it('preserves unknown touched coverage and actual measurements below a minimum', () => {
  const collector = make();
  const measurement = measuredCoverage();
  measurement.touched = null;
  const snapshots = keepCoverage(measurement);
  expect(record(collector, 'coverage', { snapshots, baseline: null })).toBe(true);
  expect(get(collector, 'coverage').summary).toEqual({ folders: [{ folder: 'modules/', lines: { percent: 50, target: 0 }, branches: { percent: 100, target: 0 } }] });
  expect(JSON.parse(readFileSync(join(root, snapshots.analysis))).measurement.touched).toBeNull();
  expect(() => verify(collector, { baseline: null })).not.toThrow();
  measurement.folders[0].lines.minimum = 800;
  measurement.failures = ['modules/ lines are below 80%'];
  expect(record(collector, 'coverage', { outcome: 'findings', baseline: null, snapshots: keepCoverage(measurement, 'findings') })).toBe(true);
  expect(get(collector, 'coverage')).toMatchObject({ status: 'failed', summary: { folders: [{ lines: { percent: 50, target: 80 } }] } });
  const saved = JSON.parse(bytes(get(collector, 'coverage').evidence[1])).measurement;
  expect(saved).toMatchObject({ failures: measurement.failures, touched: null });
});

it('preserves mutation survivors, per-status counts and incomplete work', () => {
  const collector = make();
  const snapshots = keepMutation();
  expect(record(collector, 'mutation', { outcome: 'findings', snapshots })).toBe(true);
  expect(get(collector, 'mutation').status).toBe('partial');
  expect(get(collector, 'mutation').summary).toEqual({ totalMutants: 2, killed: 0, survived: 1, unproved: 1, ignored: 0, errored: 0 });
  expect(JSON.parse(readFileSync(join(root, snapshots.findings))).measurement.findings).toMatchObject({
    counts: { statuses: { Survived: 1, NoCoverage: 1 } }, survivors: [{ id: '0', file: 'modules/a.ts' }] });
  expect(get(collector, 'mutation').evidence.map(item => item.snapshot)).toEqual([snapshots.raw, snapshots.findings]);
  expect(() => verify(collector)).not.toThrow();
});

it.each(['skipped in CI', 'No changed files.', 'Insufficient time.'])('keeps an intentional omission empty: %s', reason => {
  const collector = make();
  expect(record(collector, 'mutation', { outcome: 'skipped', reason, text: 'old text', snapshots: keepMutation() })).toBe(true);
  expect(get(collector, 'mutation')).toEqual({ name: 'mutation', status: 'skipped', reason, evidence: [], summary: {} });
});

it('preserves command output and full diagnostics while limiting generated descriptions', () => {
  const collector = make();
  const text = 'warning\n'.repeat(1000);
  expect(record(collector, 'audit', { ...audit, reason: '🧬'.repeat(300), text })).toBe(true);
  const result = get(collector, 'audit');
  expect(result.status).toBe('ok');
  expect([...result.reason]).toHaveLength(256);
  expect(result.summary).toEqual({ outcome: 'findings', exitCode: 1 });
  expect(bytes(result.evidence[0])).toBe(text);
  expect(record(collector, 'compile', { outcome: 'broken', text: 'compiler crashed' })).toBe(true);
  expect(get(collector, 'compile').status).toBe('failed');
  expect(bytes(get(collector, 'compile').evidence[0])).toBe('compiler crashed');
});

function outputFixture() {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'reports/\n');
  mkdirSync(join(root, 'reports'));
  const document = { version: 1, name: 'audit', result: { outcome: 'findings', exitCode: 1, text: audit.text, reason: audit.reason } };
  writeFileSync(join(root, 'reports/audit.json'), JSON.stringify(document));
  return document;
}

it('keeps command text and the existing output document after the working file is overwritten or removed', () => {
  const document = outputFixture();
  const collector = make([{ name: 'audit', output: 'reports/audit.json' }]);
  expect(record(collector, 'audit', audit)).toBe(true);
  const result = get(collector, 'audit');
  expect(result.evidence.map(item => item.role)).toEqual(['raw', 'analysis']);
  expect(bytes(result.evidence[0])).toBe(audit.text);
  expect(JSON.parse(bytes(result.evidence[1]))).toEqual(document);
  writeFileSync(join(root, 'reports/audit.json'), 'different run');
  expect(() => verify(collector)).not.toThrow();
  rmSync(join(root, 'reports/audit.json'));
  expect(() => verify(collector)).not.toThrow();
});

it('refuses a missing configured output and preserves the command text already captured', () => {
  outputFixture();
  rmSync(join(root, 'reports/audit.json'));
  const collector = make([{ name: 'audit', output: 'reports/audit.json' }]);
  expect(record(collector, 'audit', audit)).toBe(false);
  expect(collector.problem('audit')).toContain('ENOENT');
  expect(get(collector, 'audit')).toMatchObject({ status: 'failed', summary: { outcome: 'findings', diagnostics: expect.stringContaining('ENOENT') } });
  expect(bytes(get(collector, 'audit').evidence[0])).toBe(audit.text);
});

it('fails publication instead of pretending an output was preserved', () => {
  mkdirSync(join(root, '.katatay'));
  writeFileSync(join(root, '.katatay/local'), 'not a directory');
  const collector = make();
  expect(record(collector, 'audit', audit)).toBe(false);
  expect(get(collector, 'audit')).toMatchObject({ status: 'failed', evidence: [], summary: { outcome: 'findings', diagnostics: expect.any(String) } });
});

it.each(['coverage', 'mutation'])('refuses altered %s snapshots on readback', name => {
  const collector = make();
  const snapshots = name === 'coverage' ? keepCoverage() : keepMutation();
  expect(record(collector, name, { snapshots })).toBe(true);
  writeFileSync(join(root, snapshots.raw), 'altered');
  expect(() => verify(collector)).toThrow('SHA-256 digest mismatch');
});

it('refuses an altered summary even while the original snapshot bytes remain valid', () => {
  const collector = make();
  expect(record(collector, 'coverage', { snapshots: keepCoverage() })).toBe(true);
  get(collector, 'coverage').summary.folders[0].lines.percent = 51;
  expect(() => verify(collector)).toThrow('Coverage summary differs');
});

it('retains a failed result when its available evidence is malformed', () => {
  const collector = make();
  expect(record(collector, 'coverage', { snapshots: { raw: 'missing', analysis: 'missing' } })).toBe(false);
  expect(get(collector, 'coverage')).toMatchObject({ status: 'failed', evidence: [], summary: { diagnostics: expect.stringContaining('reference') } });
  expect(() => validateChecksResults(collector.results)).not.toThrow();
});

function originalMutation() {
  grant();
  const snapshots = keepMutation();
  const collector = make();
  expect(record(collector, 'mutation', { snapshots, outcome: 'findings' })).toBe(true);
  const receipt = add('verified', verified({ treeFingerprint, results: collector.results }));
  return { receipt, snapshots, result: get(collector, 'mutation') };
}
function reused(name) {
  const collector = make();
  expect(record(collector, name, { outcome: 'skipped', ranBefore: true })).toBe(true);
  return collector;
}

it('retains original mutation provenance and evidence across repeated reuse', () => {
  const { receipt, result } = originalMutation();
  const collector = reused('mutation');
  const stored = get(collector, 'mutation');
  expect(stored).toMatchObject({ status: 'reused', source: { seq: receipt.seq,
    fingerprint: sha256(readFileSync(join(root, dirFor(branch), fileFor(receipt)))) }, summary: result.summary, evidence: result.evidence });
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: collector.results }));
  const later = reused('mutation');
  expect(get(later, 'mutation')).toEqual(stored);
  expect(() => verify(later)).not.toThrow();
});

it.each([
  ['Killed', 0, 'clean', 'clean', 'ok'],
  ['Survived', 1, 'survived', 'findings', 'ok'],
  ['NoCoverage', 2, 'nothing', 'findings', 'partial'],
])('keeps the original exit, tool outcome and evidence on reuse (%s)', (status, exitCode, toolOutcome, outcome, completeness) => {
  grant();
  const collector = make();
  const snapshots = keepMutation([status]);
  expect(record(collector, 'mutation', { snapshots, outcome, code: exitCode })).toBe(true);
  expect(get(collector, 'mutation').status).toBe(completeness);
  const receipt = add('verified', verified({ results: collector.results }));
  const next = reused('mutation');
  expect(() => verify(next)).not.toThrow();
  const result = get(next, 'mutation');
  expect(result.source.seq).toBe(receipt.seq);
  expect(result.evidence).toEqual(get(collector, 'mutation').evidence);
  expect(JSON.parse(bytes(result.evidence.find(item => item.role === 'analysis')))).toMatchObject({
    result: { exitCode, outcome }, measurement: { toolOutcome, findings: { counts: { total: 1 } } },
  });
});

// The producer is a stored event: a field no format lists on its result is
// ignored when the reuse is validated against it.
it('reuses a stored result holding a field no format lists', () => {
  grant();
  const collector = make();
  expect(record(collector, 'mutation', { snapshots: keepMutation(), outcome: 'findings' })).toBe(true);
  get(collector, 'mutation').producer = 'an older referee';
  const dir = join(root, dirFor(branch));
  const receipt = { version: 1, seq: live.length + 1, prev: sha256(readFileSync(join(dir, fileFor(live.at(-1))))),
    ts: '2026-01-01T00:00:00.000Z', event: 'verified', payload: verified({ treeFingerprint, results: collector.results }) };
  writeFileSync(join(dir, fileFor(receipt)), JSON.stringify(receipt, null, 2) + '\n');
  live.push(receipt);
  const later = reused('mutation');
  expect(get(later, 'mutation')).toMatchObject({ status: 'reused', source: { seq: receipt.seq } });
  expect(get(later, 'mutation')).not.toHaveProperty('producer');
  expect(() => verify(later)).not.toThrow();
});

it('reuses general check evidence without reading a working output', () => {
  grant();
  const collector = make();
  expect(record(collector, 'audit', audit)).toBe(true);
  const receipt = add('verified', verified({ treeFingerprint, results: collector.results }));
  const second = reused('audit');
  const result = get(second, 'audit');
  expect(result.source.seq).toBe(receipt.seq);
  expect(bytes(result.evidence[0])).toBe(audit.text);
  expect(result.evidence).toEqual(get(collector, 'audit').evidence);
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: second.results }));
  expect(get(reused('audit'), 'audit')).toEqual(result);
});

it.each([
  ['fingerprint', /Reuse source fingerprint does not match its verification/],
  ['future', /source must precede this verification/],
  ['approval', /Reuse source is not an earlier verified event under this approval/],
  ['measurement', /Reused evidence differs from the original successful result/],
  ['evidence', /ENOENT.*mutation\/raw/],
  ['missing source', /ENOENT.*0002__verified\.json/],
])('rejects invalid reuse: %s', (failure, diagnostic) => {
  const { receipt } = originalMutation();
  const collector = reused('mutation');
  const result = get(collector, 'mutation');
  if (failure === 'fingerprint') result.source.fingerprint = 'f'.repeat(64);
  if (failure === 'future') result.source.seq = live.length + 1;
  if (failure === 'approval') grant();
  if (failure === 'measurement') { result.summary.survived--; result.summary.killed++; }
  if (failure === 'evidence') rmSync(join(root, result.evidence[0].snapshot));
  if (failure === 'missing source') rmSync(join(root, dirFor(branch), fileFor(receipt)));
  expect(() => verify(collector)).toThrow(diagnostic);
});

const producer = name => producerOf(name, { live, branch, root, ...verificationInputs });

it.each([
  ['baseline', 'e'.repeat(40)],
  ['rulebookFingerprint', 'e'.repeat(64)],
])('selects only matching receipts and rejects a reuse pointer crossing %s', (field, changed) => {
  const { receipt } = originalMutation();
  const inputs = { ...verificationInputs, [field]: changed };
  const select = () => producerOf('mutation', { live, branch, root, ...inputs });
  expect(select()).toBeNull();

  const collector = reused('mutation');
  expect(() => verify(collector, inputs)).toThrow('different rulebook or baseline');
  add('verified', verified({ ...inputs, results: collector.results }));
  expect(select).toThrow('different rulebook or baseline');
  expect(producer('mutation').event).toEqual(receipt);
});

it('finds no producer without an approval, or when only an earlier approval ran the check', () => {
  expect(producer('mutation')).toBeNull();
  originalMutation();
  grant();
  expect(producer('mutation')).toBeNull();
});

it('takes an ok result as its own producer and follows reuse, repeated, to the validated original', () => {
  const { receipt, result } = originalMutation();
  expect(producer('mutation')).toEqual({ event: receipt, result });
  const first = reused('mutation');
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: first.results }));
  expect(producer('mutation')).toEqual({ event: receipt, result: get(first, 'mutation') });
  const second = reused('mutation');
  add('verified', verified({ treeFingerprint: 'c'.repeat(64), results: second.results }));
  expect(producer('mutation').event).toEqual(receipt);
  expect(producer('mutation').result.evidence).toEqual(result.evidence);
});

it('asks an older receipt when a newer one skipped the check, and never a failed verification', () => {
  const { receipt } = originalMutation();
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: make().results }));
  add('verify_failed', { treeFingerprint: 'c'.repeat(64), baseline: verificationInputs.baseline, rulebookFingerprint: null, results: verified().results, tail: '' });
  expect(producer('mutation').event).toEqual(receipt);
});

it.each(['fingerprint', 'missing source'])('refuses a reused result whose producer fails validation: %s', failure => {
  const { receipt } = originalMutation();
  const collector = reused('mutation');
  if (failure === 'fingerprint') get(collector, 'mutation').source.fingerprint = 'f'.repeat(64);
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: collector.results }));
  if (failure === 'missing source') rmSync(join(root, dirFor(branch), fileFor(receipt)));
  expect(() => producer('mutation')).toThrow();
});

it('finds no producer in a logbook without an approval, even beside a verified run', () => {
  const collector = make();
  expect(record(collector, 'audit', audit)).toBe(true);
  live.push({ seq: 1, event: 'verified', payload: verified({ treeFingerprint, results: collector.results }) });
  expect(producer('audit')).toBeNull();
  live.unshift({ seq: 0, event: 'plan_approved' });
  expect(producer('audit')).toEqual({ event: live[1], result: get(collector, 'audit') });
});

it('passes over a newer unified receipt that has no result for the check', () => {
  grant();
  const collector = make();
  expect(record(collector, 'audit', audit)).toBe(true);
  const original = add('verified', verified({ treeFingerprint, results: collector.results }));
  const without = verificationResults(branch, [{ name: 'coverage' }], [], root);
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: without.results }));
  expect(producer('audit')).toEqual({ event: original, result: get(collector, 'audit') });
});

it('refuses reuse without its producing verification rather than silently executing or guessing', () => {
  grant();
  const collector = make();
  expect(record(collector, 'mutation', { outcome: 'skipped', ranBefore: true })).toBe(false);
  expect(get(collector, 'mutation')).toMatchObject({ status: 'failed', evidence: [], summary: { diagnostics: 'No producing verification for reused mutation' } });
});

it('uses the caller repository when no root is supplied and captures thrown step failures', () => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const collector = verificationResults(branch, [], ['compile', 'tests']);
  collector.fail('compile', Error('Compiler would not start.'));
  expect(get(collector, 'compile')).toMatchObject({ status: 'failed', evidence: [], summary: { diagnostics: 'Compiler would not start.' } });
});

const sourceOf = receipt => ({ seq: receipt.seq, fingerprint: sha256(readFileSync(join(root, dirFor(branch), fileFor(receipt)))) });
const replaceEvidence = (result, role, folder, extension, content) => {
  const snapshot = publishSnapshot(branch, { folder, extension, label: 'replacement' }, Buffer.from(content), root);
  result.evidence.find(item => item.role === role).snapshot = snapshot;
};

it.each(['another check', 'a skipped result'])('refuses reuse of a source carrying %s', kind => {
  grant();
  const collector = make();
  expect(record(collector, 'audit', audit)).toBe(true);
  const elsewhere = make([{ name: 'other', onFailure: 'report' }]);
  expect(record(elsewhere, 'other', { ...audit, name: 'other', onFailure: 'report' })).toBe(true);
  const skipping = make();
  expect(record(skipping, 'audit', { outcome: 'skipped', reason: 'Skipped in CI.' })).toBe(true);
  const receipt = add('verified', verified({ treeFingerprint, results: kind === 'another check' ? elsewhere.results : skipping.results }));
  Object.assign(get(collector, 'audit'), { status: 'reused', reason: 'Once per plan.', source: sourceOf(receipt) });
  expect(() => verify(collector)).toThrow(kind === 'a skipped result' ? 'Reused evidence differs from the original successful result'
    : `Reuse source ${receipt.seq} has no audit result`);
});

it('rejects a mutation summary changed after publication', () => {
  const collector = make();
  expect(record(collector, 'mutation', { snapshots: keepMutation() })).toBe(true);
  get(collector, 'mutation').summary.killed++;
  get(collector, 'mutation').summary.survived--;
  expect(() => verify(collector)).toThrow('Mutation summary or status differs from its evidence');
});

it.each(['name', 'outcome', 'measurement', 'result'])('rejects corrupt coverage analysis: %s', kind => {
  const collector = make();
  expect(record(collector, 'coverage', { snapshots: keepCoverage() })).toBe(true);
  const result = get(collector, 'coverage');
  const document = JSON.parse(bytes(result.evidence.find(item => item.role === 'analysis')));
  if (kind === 'outcome') document.result.outcome = 'findings';
  else delete document[kind];
  replaceEvidence(result, 'analysis', 'coverage', 'json', JSON.stringify(document));
  expect(() => verify(collector)).toThrow(kind === 'outcome' ? 'not successful' : 'invalid shape');
});

it.each(['name', 'old format', 'outcome', 'exitCode', 'reason', 'text'])('refuses a configured output with mismatched %s before preserving it', kind => {
  const document = outputFixture();
  if (kind === 'name') document.name = 'other';
  if (kind === 'old format') { document.version = 1; document.result.code = document.result.exitCode; delete document.result.exitCode; }
  if (kind === 'outcome') document.result.outcome = 'clean';
  if (kind === 'exitCode') document.result.exitCode = 2;
  if (kind === 'reason' || kind === 'text') document.result[kind] = 'different';
  writeFileSync(join(root, 'reports/audit.json'), JSON.stringify(document));
  const collector = make([{ name: 'audit', output: 'reports/audit.json' }]);
  expect(record(collector, 'audit', audit)).toBe(false);
  expect(collector.problem('audit')).toBe('Check output does not match its producing run');
});

it.each(['name', 'outcome', 'exitCode', 'text', 'old format'])('checks the saved ordinary analysis against its receipt and raw bytes: %s', kind => {
  const document = outputFixture();
  const collector = make([{ name: 'audit', output: 'reports/audit.json' }]);
  expect(record(collector, 'audit', audit)).toBe(true);
  if (kind === 'name') document.name = 'other';
  if (kind === 'outcome') document.result.outcome = 'clean';
  if (kind === 'exitCode') document.result.exitCode = 0;
  if (kind === 'text') document.result.text = 'other';
  if (kind === 'old format') { document.version = 1; document.result.code = 1; delete document.result.exitCode; }
  replaceEvidence(get(collector, 'audit'), 'analysis', 'checks/analysis', 'json', JSON.stringify(document));
  const problem = { name: 'check analysis.name', text: 'Check output differs from its analysis', 'old format': 'exitCode is missing' };
  expect(() => verify(collector)).toThrow(problem[kind] ?? 'Check analysis differs from its producing measurement');
});

it('accepts a configured check with no raw text', () => {
  const document = outputFixture();
  document.result.text = '';
  writeFileSync(join(root, 'reports/audit.json'), JSON.stringify(document));
  const collector = make([{ name: 'audit', output: 'reports/audit.json' }]);
  expect(record(collector, 'audit', { ...audit, text: '' })).toBe(true);
  expect(get(collector, 'audit').evidence.map(item => item.role)).toEqual(['analysis']);
  expect(() => verify(collector)).not.toThrow();
});

describe.each([
  ['audit', 'check analysis', 'checks/analysis', collector => {
    outputFixture();
    return record(collector, 'audit', audit);
  }],
  ['tests', 'test analysis', 'junit/analysis', collector => {
    const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
    return record(collector, 'tests', {}, { junitReports: reports, tests: testRun() });
  }],
  ['coverage', 'coverage analysis', 'coverage', collector => record(collector, 'coverage', { snapshots: keepCoverage() })],
  ['mutation', 'mutation analysis', 'mutation/findings', collector => record(collector, 'mutation', { snapshots: keepMutation() })],
])('%s evidence schema', (name, label, folder, capture) => {
  it.each([undefined, null, '1', 2, 1])('validates digest-matched version %j on receipt readback and reuse', version => {
    grant();
    const collector = make([{ name: 'audit', output: 'reports/audit.json' }, { name: 'coverage' }, { name: 'mutation' }]);
    expect(capture(collector)).toBe(true);
    const result = get(collector, name);
    const analysis = result.evidence.find(item => item.role === 'analysis');
    const document = JSON.parse(bytes(analysis));
    document.version = version;
    replaceEvidence(result, 'analysis', folder, 'json', JSON.stringify(document));
    const problem = version === undefined ? 'is missing' : `has unsupported schema version ${JSON.stringify(version)}`;
    const diagnostic = `${analysis.snapshot}: ${label}.version ${problem}`;
    if (version === 1) expect(() => verify(collector)).not.toThrow();
    else expect(() => verify(collector)).toThrow(diagnostic);
    if (name === 'mutation' || name === 'audit') {
      add('verified', verified({ results: collector.results }));
      const later = make();
      expect(record(later, name, { outcome: 'skipped', ranBefore: true })).toBe(version === 1);
      if (version === 1) expect(get(later, name).status).toBe('reused');
      else expect(later.problem(name)).toContain(diagnostic);
    }
  });
});

it('shows a failed suite’s counts and the schema diagnostic from its digest-valid test analysis', () => {
  grant();
  const collector = make();
  const xml = '<testsuites><testsuite name="suite.test.mjs"><testcase name="example" file="suite.test.mjs"><failure/></testcase></testsuite></testsuites>';
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from(xml) }], root);
  const run = testRun({ exit: 1, cases: [testCase({ status: 'failed' })] });
  expect(record(collector, 'tests', { outcome: 'findings', code: 1 }, { junitReports: reports, tests: run })).toBe(true);
  const result = get(collector, 'tests');
  const analysis = result.evidence.find(item => item.role === 'analysis');
  const document = JSON.parse(bytes(analysis));
  delete document.version;
  replaceEvidence(result, 'analysis', 'junit/analysis', 'json', JSON.stringify(document));
  const receipt = add('verify_failed', { ...verificationInputs, treeFingerprint, results: collector.results, tail: 'One test failed.' });
  const summary = verificationSummary(receipt, { branch, root, dir: dirFor(branch) }).replace(/\s+/g, ' ');
  expect(summary).toContain('tests: FAILED 1 / 1 failed');
  expect(summary).toContain(analysis.snapshot + ': test analysis.version is missing');
});

it('refuses reuse of mutation findings written under an unsupported schema', () => {
  grant();
  const collector = make();
  expect(record(collector, 'mutation', { snapshots: keepMutation() })).toBe(true);
  const result = get(collector, 'mutation');
  const analysis = result.evidence.find(item => item.role === 'analysis');
  const document = { ...JSON.parse(bytes(analysis)), version: 2 };
  replaceEvidence(result, 'analysis', 'mutation/findings', 'json', JSON.stringify(document));
  add('verified', verified({ treeFingerprint, results: collector.results }));
  const later = make();
  expect(record(later, 'mutation', { outcome: 'skipped', ranBefore: true })).toBe(false);
  expect(later.problem('mutation')).toContain(`${analysis.snapshot}: mutation analysis.version has unsupported schema version 2`);
});

it('retains diagnostics when a failed quality command has no measurement and retains explicit limitations', () => {
  const collector = make();
  expect(record(collector, 'mutation', { outcome: 'broken', text: 'Detailed crash\ntrace', reason: 'Failed.' })).toBe(true);
  expect(get(collector, 'mutation')).toMatchObject({ status: 'failed', summary: { diagnostics: 'Detailed crash\ntrace' } });
  expect(record(collector, 'coverage', { outcome: 'broken', reason: 'No raw report.' })).toBe(true);
  expect(get(collector, 'coverage')).toMatchObject({ status: 'failed', summary: { diagnostics: 'No raw report.' } });
  expect(record(collector, 'compile', {}, { limitations: ['Only configured inputs were checked.'] })).toBe(true);
  expect(get(collector, 'compile').summary.limitations).toEqual(['Only configured inputs were checked.']);
});

it('refuses damaged test bytes and malformed completed results before returning success', () => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  writeFileSync(join(root, reports[0].snapshot), 'damaged');
  expect(record(collector, 'tests', {}, { junitReports: reports, tests: { cases: [], leftOut: [], exit: 0 } })).toBe(false);
  expect(collector.problem('tests')).toBe(`JUnit XML (${reports[0].snapshot}): SHA-256 digest mismatch`);
  expect(record(collector, 'audit', { outcome: 'unknown' })).toBe(false);
  expect(collector.problem('audit')).toContain('summary.outcome');
});

it('binds reuse to the exact stored event bytes, even when reserialization preserves its JSON value', () => {
  const { receipt } = originalMutation();
  const collector = reused('mutation');
  const result = get(collector, 'mutation');
  const file = join(root, dirFor(branch), fileFor(receipt));
  const originalBytes = readFileSync(file);
  const reformatted = JSON.stringify(JSON.parse(originalBytes));
  writeFileSync(file, reformatted);
  expect(JSON.parse(reformatted)).toEqual(receipt);
  expect(() => verify(collector)).toThrow('Reuse source fingerprint does not match its verification');
  result.source.fingerprint = sha256(reformatted);
  expect(() => verify(collector)).not.toThrow();
  expect(result.source.fingerprint).not.toBe(sha256(originalBytes));
});

it.each(['missing approval', 'different in-memory event', 'broken predecessor', 'failed event'])
  ('refuses reuse with %s before trusting its readable artifacts', kind => {
    const { receipt } = originalMutation();
    const collector = reused('mutation');
    let message;
    if (kind === 'missing approval') {
      live = live.filter(event => event.event !== 'plan_approved');
      message = 'Reuse has no current approval';
    } else if (kind === 'different in-memory event') {
      receipt.payload.treeFingerprint = 'c'.repeat(64);
      message = 'Reuse source fingerprint does not match its verification';
    } else if (kind === 'broken predecessor') {
      const file = join(root, dirFor(branch), fileFor(live[0]));
      writeFileSync(file, readFileSync(file, 'utf8') + ' ');
      message = 'Reuse source logbook is broken:';
    } else {
      const failed = add('verify_failed', { treeFingerprint, baseline: verificationInputs.baseline, rulebookFingerprint: null, results: verified().results, tail: 'Unsuccessful run.' });
      get(collector, 'mutation').source = sourceOf(failed);
      message = 'Reuse source is not an earlier verified event under this approval';
    }
    expect(() => validateVerificationEvidence(collector.results, { branch, root, live, ...verificationInputs, before: 100 }))
      .toThrow(message);
    for (const evidence of get(collector, 'mutation').evidence) expect(bytes(evidence)).not.toBe('');
  });

it('rejects reuse pointers to a reused receipt instead of the original producer', () => {
  originalMutation();
  const firstReuse = reused('mutation');
  const intermediate = add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: firstReuse.results }));
  const later = reused('mutation');
  get(later, 'mutation').source = sourceOf(intermediate);
  expect(() => verify(later)).toThrow('Reused evidence differs from the original successful result');
});

it('refuses a different valid snapshot even when the reused summary has not changed', () => {
  originalMutation();
  const collector = reused('mutation');
  const replacement = keepMutation(['Killed']);
  get(collector, 'mutation').evidence[0].snapshot = replacement.raw;
  expect(() => verify(collector)).toThrow('Reused evidence differs from the original successful result');
});

it('selects the mutation producer through older, failed and skipped receipts', () => {
  grant();
  const older = make();
  expect(record(older, 'mutation', { outcome: 'findings', snapshots: keepMutation(['Killed']) })).toBe(true);
  add('verified', verified({ treeFingerprint: 'c'.repeat(64), results: older.results }));
  const snapshots = keepMutation();
  const producer = make();
  expect(record(producer, 'mutation', { outcome: 'findings', snapshots })).toBe(true);
  const receipt = add('verified', verified({ treeFingerprint, results: producer.results }));
  add('verify_failed', { treeFingerprint: 'd'.repeat(64), baseline: verificationInputs.baseline, rulebookFingerprint: null, results: verified().results, tail: 'A later test run failed.' });
  add('verified', verified({ treeFingerprint: 'e'.repeat(64), results: make().results }));
  const collector = reused('mutation');
  expect(get(collector, 'mutation')).toMatchObject({ source: sourceOf(receipt), summary: get(producer, 'mutation').summary });
  expect(get(collector, 'mutation').evidence.map(item => item.snapshot)).toEqual([snapshots.raw, snapshots.findings]);
  expect(() => verify(collector)).not.toThrow();
});

it('does not borrow a different check or an older approval when selecting a general source', () => {
  grant();
  const earlier = make();
  expect(record(earlier, 'audit', audit)).toBe(true);
  add('verified', verified({ treeFingerprint, results: earlier.results }));
  grant();
  const other = make([{ name: 'other', onFailure: 'report' }]);
  expect(record(other, 'other', { ...audit, name: 'other', onFailure: 'report' })).toBe(true);
  add('verified', verified({ treeFingerprint: 'b'.repeat(64), results: other.results }));
  const collector = make();
  expect(record(collector, 'audit', { ranBefore: true, outcome: 'skipped' })).toBe(false);
  expect(collector.problem('audit')).toBe('No producing verification for reused audit');
});

it('keeps reused evidence independent of mutations to the in-memory producing result', () => {
  const { receipt } = originalMutation();
  const collector = reused('mutation');
  const captured = structuredClone(get(collector, 'mutation'));
  receipt.payload.results.find(item => item.name === 'mutation').summary.partial = false;
  receipt.payload.results.find(item => item.name === 'mutation').evidence[0].title = 'Changed after capture';
  expect(get(collector, 'mutation')).toEqual(captured);
  expect(() => verify(collector)).toThrow('Reuse source fingerprint does not match its verification');
});

it.each(['coverage', 'mutation', 'audit'])('identifies %s when valid-shaped evidence is lost or corrupt', name => {
  const collector = make();
  const values = name === 'audit' ? audit : { snapshots: name === 'coverage' ? keepCoverage() : keepMutation() };
  expect(record(collector, name, values)).toBe(true);
  const result = get(collector, name);
  const file = join(root, result.evidence[0].snapshot);
  const original = readFileSync(file);
  for (const failure of ['corrupt', 'missing']) {
    if (failure === 'corrupt') writeFileSync(file, 'changed');
    else rmSync(file);
    let error;
    try { verify(collector); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ resultName: name, message: expect.stringContaining(failure === 'corrupt' ? 'SHA-256 digest mismatch' : 'ENOENT') });
    writeFileSync(file, original);
    expect(() => verify(collector)).not.toThrow();
  }
});

it('refuses an unversioned coverage snapshot before comparing its malformed result', () => {
  const collector = make();
  const snapshots = keepCoverage();
  const doc = JSON.parse(readFileSync(join(root, snapshots.analysis)));
  delete doc.version;
  delete doc.result;
  snapshots.analysis = publishSnapshot(branch, { folder: 'coverage', extension: 'json' }, Buffer.from(JSON.stringify(doc)), root);
  expect(record(collector, 'coverage', { snapshots })).toBe(false);
  expect(collector.problem('coverage')).toContain(snapshots.analysis + ': coverage analysis.version is missing');
});

it.each(['name', 'exitCode', 'outcome', 'missing result'])('refuses mismatched coverage %s during capture, before receipt validation', kind => {
  const collector = make();
  const snapshots = keepCoverage();
  const document = JSON.parse(readFileSync(join(root, snapshots.analysis), 'utf8'));
  if (kind === 'name') document.name = 'another';
  if (kind === 'exitCode') document.result.exitCode = 42;
  if (kind === 'outcome') document.result.outcome = 'findings';
  if (kind === 'missing result') delete document.result;
  snapshots.analysis = publishSnapshot(branch, { folder: 'coverage', extension: 'json', label: 'coverage analysis' }, Buffer.from(JSON.stringify(document)), root);
  expect(record(collector, 'coverage', { snapshots })).toBe(false);
  const shape = 'coverage: saved analysis has an invalid shape: ' + snapshots.analysis;
  const diagnostic = {
    name: shape + ': coverage analysis.name must be coverage',
    exitCode: snapshots.analysis + ': Coverage analysis does not match its result',
    outcome: 'coverage: saved analysis is not successful (Completed.)',
    'missing result': shape + ': coverage analysis.result is missing',
  }[kind];
  expect(collector.problem('coverage')).toBe(diagnostic);
  expect(get(collector, 'coverage')).toMatchObject({ status: 'failed', summary: { diagnostics: diagnostic } });
});

it.each(['block', 'report'])('maps general findings using the %s policy while keeping identical diagnostics', onFailure => {
  const collector = make();
  expect(record(collector, 'audit', { ...audit, onFailure })).toBe(true);
  const result = get(collector, 'audit');
  expect(result).toEqual({ name: 'audit', status: onFailure === 'report' ? 'ok' : 'failed', reason: 'Warning.',
    evidence: [{ role: 'raw', title: 'audit output', snapshot: expect.any(String) }], summary: { outcome: 'findings', exitCode: 1 } });
  expect(bytes(result.evidence[0])).toBe(audit.text);
});

it('partitions every mutation status into six exhaustive aggregate fields', () => {
  const mutants = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Pending', 'Ignored', 'CompileError', 'RuntimeError']
    .map((status, id) => mutant(status, { id: String(id) }));
  mutants.push(mutant('Survived', { id: 'zero-tests', testsCompleted: 0 }));
  const raw = JSON.stringify(reportOf(mutants));
  const snapshots = writeMutationSnapshot(branch, { raw, status: 2, outcome: 'nothing', report: 'Some work is unproved.', findings: findingsOf(JSON.parse(raw)) }, root);
  const collector = make();
  expect(record(collector, 'mutation', { outcome: 'findings', snapshots })).toBe(true);
  const result = get(collector, 'mutation');
  expect(result.status).toBe('partial');
  expect(result.summary).toEqual({ totalMutants: 9, killed: 2, survived: 1, unproved: 3, ignored: 1, errored: 2 });
  expect(() => verify(collector)).not.toThrow();
});

it.each([
  ['Killed', {}, 'killed', 'ok'], ['Timeout', {}, 'killed', 'ok'],
  ['Survived', {}, 'survived', 'ok'], ['Survived', { testsCompleted: 1 }, 'survived', 'ok'],
  ['Survived', { testsCompleted: 0 }, 'unproved', 'partial'],
  ['NoCoverage', {}, 'unproved', 'partial'], ['Pending', {}, 'unproved', 'partial'],
  ['Ignored', {}, 'ignored', 'ok'], ['CompileError', {}, 'errored', 'partial'], ['RuntimeError', {}, 'errored', 'partial'],
])('assigns %s with %j only to %s', (status, extra, category, completeness) => {
  const report = reportOf([mutant(status, extra)]);
  const outcome = completeness === 'partial' ? 'nothing' : category === 'survived' ? 'survived' : 'clean';
  const snapshots = writeMutationSnapshot(branch, { raw: JSON.stringify(report), status: ['clean', 'survived', 'nothing'].indexOf(outcome), outcome,
    report: 'Measured.', findings: findingsOf(report) }, root);
  const collector = make();
  expect(record(collector, 'mutation', { outcome: 'findings', snapshots })).toBe(true);
  expect(get(collector, 'mutation')).toMatchObject({ status: completeness });
  expect(get(collector, 'mutation').summary).toEqual({ totalMutants: 1, killed: 0, survived: 0,
    unproved: 0, ignored: 0, errored: 0, [category]: 1 });
  expect(() => verify(collector)).not.toThrow();
});

it.each([
  [[], 'ok', { totalMutants: 0, killed: 0, survived: 0, unproved: 0, ignored: 0, errored: 0 }],
  [['Killed', 'Timeout', 'Ignored'], 'ok', { totalMutants: 3, killed: 2, survived: 0, unproved: 0, ignored: 1, errored: 0 }],
  [['Survived'], 'ok', { totalMutants: 1, killed: 0, survived: 1, unproved: 0, ignored: 0, errored: 0 }],
])('preserves complete mutation measurements including empty runs and nonblocking survivors (%#)', (statuses, status, summary) => {
  const collector = make();
  expect(record(collector, 'mutation', { outcome: statuses.includes('Survived') ? 'findings' : 'clean', snapshots: keepMutation(statuses) })).toBe(true);
  expect(get(collector, 'mutation')).toMatchObject({ status, summary });
  expect(() => verify(collector)).not.toThrow();
});

it.each(['tests', 'mutation'])('blocking failure takes precedence over partial for %s', name => {
  const collector = make();
  if (name === 'tests') {
    const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
    expect(record(collector, name, { outcome: 'findings' }, { junitReports: reports,
      tests: testRun({ exit: 1, cases: [testCase({ status: 'failed' })] }) })).toBe(true);
  } else expect(record(collector, name, { outcome: 'findings', onFailure: 'block', snapshots: keepMutation() })).toBe(true);
  expect(get(collector, name).status).toBe('failed');
  expect(get(collector, name).summary).not.toHaveProperty('partial');
});

it.each([undefined, false, true])('checks the receipt status against its saved analysis (historical reported=%s)', reported => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  expect(record(collector, 'tests', {}, { junitReports: reports, tests: testRun() })).toBe(true);
  const result = get(collector, 'tests');
  expect(result.status).toBe('ok');
  const analysis = result.evidence.find(item => item.role === 'analysis');
  const document = JSON.parse(bytes(analysis));
  expect(document.measurement).not.toHaveProperty('reported');
  if (reported !== undefined) {
    document.measurement.reported = reported;
    analysis.snapshot = publishSnapshot(branch, TEST_ANALYSIS, Buffer.from(JSON.stringify(document)), root);
    result.status = reported ? 'ok' : 'partial';
  }
  expect(() => verify(collector)).not.toThrow();
  result.status = result.status === 'partial' ? 'ok' : 'partial';
  expect(() => verify(collector)).toThrow('Test summary or status differs from its evidence');
});

it('checks test aggregates against preserved analysis even when the altered counts add up', () => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  expect(record(collector, 'tests', {}, { junitReports: reports, tests: testRun({ cases: [testCase()] }) })).toBe(true);
  const result = get(collector, 'tests');
  result.summary.passed--; result.summary.skipped++;
  expect(() => verify(collector)).toThrow('Test summary or status differs from its evidence');
});

it.each([1, 'SIGTERM', null])('does not permit a successful test result with command exit %s', exit => {
  const collector = make();
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  expect(record(collector, 'tests', {}, { junitReports: reports, tests: testRun({ exit }) })).toBe(false);
  expect(get(collector, 'tests').status).toBe('failed');
  expect(collector.problem('tests')).toContain('unsuccessful command');
  expect(readTestAnalysis(branch, get(collector, 'tests').evidence, root).exit).toBe(typeof exit === 'string' ? null : exit);
});

it('shows floored line and branch percentages and different folder targets without raw counts', () => {
  const measurement = measuredCoverage();
  measurement.folders[0].lines = { covered: 2, total: 3, measured: 666, minimum: 666 };
  measurement.folders.push({ folder: 'other/', files: 7, lines: { covered: 1, total: 4, measured: 250, minimum: 200 },
    branches: { covered: 3, total: 7, measured: 428, minimum: 400 } });
  const collector = make();
  expect(record(collector, 'coverage', { snapshots: keepCoverage(measurement) })).toBe(true);
  expect(get(collector, 'coverage').summary).toEqual({ folders: [
    { folder: 'modules/', lines: { percent: 66.6, target: 66.6 }, branches: { percent: 100, target: 0 } },
    { folder: 'other/', lines: { percent: 25, target: 20 }, branches: { percent: 42.8, target: 40 } },
  ] });
  expect(() => verify(collector)).not.toThrow();
});

it('refuses reuse when the original status hides an inconclusive measurement with complete-looking counts', () => {
  grant();
  const raw = JSON.stringify(reportOf([mutant('Killed')]));
  const snapshots = writeMutationSnapshot(branch, { raw, status: 2, outcome: 'nothing', report: 'Inconclusive.', findings: findingsOf(JSON.parse(raw)) }, root);
  const original = make();
  expect(record(original, 'mutation', { snapshots, outcome: 'findings' })).toBe(true);
  expect(get(original, 'mutation').status).toBe('partial');
  get(original, 'mutation').status = 'ok';
  add('verified', verified({ treeFingerprint, results: original.results }));
  const next = make();
  expect(record(next, 'mutation', { ranBefore: true })).toBe(false);
  expect(next.problem('mutation')).toContain('Mutation summary or status differs');
});
