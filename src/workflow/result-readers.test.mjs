import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationResults } from './verification-results.mjs';
import {
  checkText, coverageReferences, junitReports, measuredTree, mutationReferences, producerEvent,
  requireUsable, resultNamed, snapshotsOf, testMeasurement, usable,
} from './result-readers.mjs';
import { current } from './state.mjs';
import { append, dirFor, fileFor } from './chain.mjs';
import { verificationInputs, verified, approval, treeFingerprint } from '../../tests/fixtures/workflow/events.mjs';
import { writeJUnitSnapshot } from './junit-snapshot.mjs';

vi.mock('./state.mjs', () => ({ current: vi.fn() }));
const branch = 'topic';
let root, live;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'result-readers-'));
  live = [];
  current.mockImplementation(() => ({ live, branch, ...verificationInputs }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const add = (event, payload) => { const entry = append(join(root, dirFor(branch)), event, payload, branch); live.push(entry); return entry; };
const audit = { name: 'audit', onFailure: 'report' };
const collect = () => verificationResults(branch, [audit], ['compile', 'tests'], root);
const run = (collector, values) => collector.record({ name: 'audit', outcome: 'findings', code: 1, reason: 'One finding.', onFailure: 'report', ...values });
const artifact = (role, title, snapshot) => ({ role, title, snapshot });
const snapshot = name => `.katatay/local/${branch}/${name}/20261104T120000.000Z_${'A'.repeat(43)}.json`;

it('finds each kind of result by name in the one list', () => {
  const checks = collect().results;
  expect(checks).not.toHaveProperty('qualityResults');
  expect(checks.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).map(result => result.name)).toEqual(['tests', 'coverage', 'mutation']);
  expect(resultNamed(checks, 'tests')).toBe(checks.find(item => item.name === 'tests'));
  expect(resultNamed(checks, 'compile')).toBe(checks[0]);
  expect(resultNamed(checks, 'missing')).toBeNull();
});

it('reads evidence by role and never by title', () => {
  const result = { name: 'coverage', status: 'ok', evidence: [
    artifact('analysis', 'Raw LCOV coverage', snapshot('a')), artifact('raw', 'Coverage analysis', snapshot('b')),
  ] };
  expect(snapshotsOf(result, 'raw')).toEqual([snapshot('b')]);
  expect(coverageReferences(result)).toEqual({ raw: snapshot('b'), analysis: snapshot('a') });
  expect(mutationReferences({ ...result, name: 'mutation' })).toEqual({ raw: snapshot('b'), findings: snapshot('a') });
});

it.each([
  ['no', []],
  ['more than one', [artifact('raw', 'One', snapshot('a')), artifact('raw', 'Two', snapshot('b')), artifact('analysis', 'Three', snapshot('c'))]],
])('refuses a coverage result naming %s raw snapshot', (count, evidence) => {
  expect(() => coverageReferences({ name: 'coverage', status: 'ok', evidence }))
    .toThrow(`The coverage result names ${count} raw snapshot`);
});

it('never takes a missing, skipped or failed result for a measurement', () => {
  expect(usable({ status: 'ok' }) && usable({ status: 'reused' })).toBe(true);
  for (const status of ['skipped', 'failed', undefined]) expect(usable(status && { status })).toBe(false);
  expect(() => requireUsable(null, 'coverage')).toThrow('The verification recorded no coverage result');
  expect(() => testMeasurement(null, branch, root)).toThrow('The verification recorded no tests result');
  expect(() => requireUsable({ status: 'skipped', reason: 'Disabled in the rulebook.' }, 'coverage'))
    .toThrow("The verification's coverage result is skipped: Disabled in the rulebook.");
  const ok = { status: 'ok' };
  expect(requireUsable(ok, 'coverage')).toBe(ok);
});

it('reads the JUnit reports a tests result names, named by snapshot path', () => {
  const reports = writeJUnitSnapshot(branch, [{ name: 'reports/fast.xml', bytes: Buffer.from('<testsuites/>') }], root);
  const result = { name: 'tests', status: 'ok', evidence: reports.map(({ snapshot: path }) => artifact('raw', 'JUnit: anything', path)) };
  expect(junitReports(result, branch, root)).toEqual([{ name: reports[0].snapshot, bytes: Buffer.from('<testsuites/>') }]);
  expect(() => junitReports({ ...result, evidence: [] }, branch, root)).toThrow('The verification recorded no JUnit report');
  expect(() => junitReports({ ...result, status: 'skipped', reason: 'Stopped.' }, branch, root)).toThrow('tests result is skipped');
  writeFileSync(join(root, reports[0].snapshot), 'altered');
  expect(() => junitReports(result, branch, root)).toThrow('SHA-256 digest mismatch');
});

it('reads a check\'s printed text from its raw snapshot only', () => {
  const collector = collect();
  expect(run(collector, { text: 'First.\nSecond.' })).toBe(true);
  const result = resultNamed(collector.results, 'audit');
  expect(checkText(result, branch, root)).toBe('First.\nSecond.');
  expect(checkText({ ...result, evidence: [] }, branch, root)).toBe('');
});

it('measures a reused result against its validated producer, and any other against the receipt', () => {
  add('plan_approved', approval());
  const first = collect();
  expect(run(first, { text: 'Finding.' })).toBe(true);
  const original = add('verified', verified({ treeFingerprint, results: first.results }));
  const second = collect();
  expect(second.record({ name: 'audit', outcome: 'skipped', ranBefore: true, reason: 'Ran before.', onFailure: 'report' })).toBe(true);
  const reused = resultNamed(second.results, 'audit');
  const context = { live, branch, root, ...verificationInputs, before: live.length + 1 };
  expect(producerEvent(reused, context)).toEqual(original);
  expect(measuredTree(reused, 'b'.repeat(64), context)).toBe(treeFingerprint);
  expect(producerEvent(resultNamed(first.results, 'audit'), context)).toBeNull();
  expect(measuredTree(resultNamed(first.results, 'audit'), 'b'.repeat(64), context)).toBe('b'.repeat(64));
  expect(() => measuredTree(reused, 'b'.repeat(64), { ...context, before: original.seq })).toThrow('Reuse source is not an earlier verified event');
  const file = join(root, dirFor(branch), fileFor(original));
  writeFileSync(file, readFileSync(file, 'utf8') + ' ');
  expect(() => producerEvent(reused, context)).toThrow();
});

it('reads a check\'s text from its raw output, never from its analysis document', () => {
  // A configured output must be an ignored file in a repository.
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'reports/\n');
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'reports/audit.json'), JSON.stringify({ version: 1, name: 'audit',
    result: { outcome: 'findings', exitCode: 1, text: 'Printed.', reason: 'One finding.' } }));
  const collector = verificationResults(branch, [{ ...audit, output: 'reports/audit.json' }], [], root);
  expect(run(collector, { text: 'Printed.' })).toBe(true);
  const result = resultNamed(collector.results, 'audit');
  expect(result.evidence.map(item => item.role)).toEqual(['raw', 'analysis']);
  expect(checkText(result, branch, root)).toBe('Printed.');
});
