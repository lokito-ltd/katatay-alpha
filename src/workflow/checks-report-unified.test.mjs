import { readBaseline } from './phase.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocument } from './result-format.mjs';
import { reportFor, reportOf } from './checks-report.mjs';
import { analysisRequest } from './checks-analysis.mjs';
import { verificationResults } from './verification-results.mjs';
import { readChecks } from './rulebook.mjs';
import { current } from './state.mjs';
import { append, currentBranch, dirFor } from './chain.mjs';
import { verificationInputs, verified, approval, treeFingerprint } from '../../tests/fixtures/workflow/events.mjs';
import { TEST_ANALYSIS, writeJUnitSnapshot } from './junit-snapshot.mjs';
import { readCoverageSnapshot, writeCoverageSnapshot } from './coverage-snapshot.mjs';
import { writeMutationSnapshot } from './mutation-snapshot.mjs';
import { testResult, testRun } from '../../tests/fixtures/workflow/quality-results.mjs';
import { publishSnapshot } from './local-snapshot.mjs';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf as standardReport } from '../../tests/fixtures/workflow/mutation-report.mjs';

vi.mock('./state.mjs', () => ({ current: vi.fn() }));
vi.mock('./rulebook.mjs', { spy: true });
vi.mock('./chain.mjs', { spy: true });
vi.mock('./coverage-snapshot.mjs', { spy: true });
const branch = 'topic';
const later = 'b'.repeat(64);
let root, live;
const add = (event, payload) => { const entry = append(join(root, dirFor(branch)), event, payload, branch); live.push(entry); return entry; };
const rulebook = { testQuality: [
  { name: 'coverage', chain: 'testQuality', runs: 'everyVerify', onFailure: 'block' },
  { name: 'mutation', chain: 'testQuality', runs: 'oncePerPlan', onFailure: 'report' },
  { name: 'audit', chain: 'testQuality', runs: 'oncePerPlan', onFailure: 'report' },
], codeQuality: [{ name: 'lint', chain: 'codeQuality', runs: 'everyVerify', onFailure: 'block' }] };
const configured = () => [...rulebook.testQuality, ...rulebook.codeQuality];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'checks-report-unified-'));
  live = [];
  current.mockImplementation(() => ({ live, branch, ...verificationInputs }));
  currentBranch.mockReturnValue(branch);
  readChecks.mockReturnValue(rulebook);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });


const touched = { covered: 0, total: 2, uncovered: [{ file: 'modules/a.ts', lines: [2, 4] }] };
function keepCoverage(measured = touched) {
  const coverage = { folders: [{ folder: 'modules/', files: 1,
    lines: { covered: 1, total: 2, measured: 500, minimum: 0 }, branches: { covered: 0, total: 0, measured: 1000, minimum: 0 } }],
  failures: [], touched: measured };
  return writeCoverageSnapshot(branch, { raw: 'SF:modules/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n',
    analysis: JSON.stringify({ version: 1, name: 'coverage', result: { outcome: 'clean', exitCode: 0, text: '', reason: 'clean' }, measurement: coverage }) }, root);
}
function keepMutation() {
  const report = standardReport([mutant('Survived', { id: '1' }), mutant('NoCoverage', { id: '2' })]);
  return writeMutationSnapshot(branch, { raw: JSON.stringify(report), status: 1, outcome: 'survived',
    findings: findingsOf(report), report: 'Mutation results.' }, root);
}
const audit = { name: 'audit', chain: 'testQuality', runs: 'oncePerPlan', onFailure: 'report', outcome: 'findings', code: 1, text: 'unused x\nunused y', reason: 'two findings' };
const lint = { name: 'lint', chain: 'codeQuality', runs: 'everyVerify', onFailure: 'block', outcome: 'clean', code: 0, text: '', reason: 'clean' };

/** One pass's unified results, as verify records them. */
function firstPass(measured = touched, baseline = measured === null ? null : readBaseline(approval().baseline)) {
  const collector = verificationResults(branch, configured(), ['compile', 'tests', 'req:trace'], root);
  const coverage = keepCoverage(measured);
  const mutation = keepMutation();
  const junit = writeJUnitSnapshot(branch, [{ name: 'reports/run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  const record = (result, run) => expect(collector.record({ onFailure: 'block', code: 0, text: '', ...result }, run)).toBe(true);
  record({ name: 'compile', outcome: 'skipped', reason: 'not checked: compile' });
  record({ name: 'tests', outcome: 'clean', reason: 'Check passed.' }, { junitReports: junit, tests: testRun() });
  record({ name: 'req:trace', outcome: 'clean', reason: 'passed' });
  record({ name: 'coverage', outcome: 'clean', reason: 'clean', baseline, snapshots: coverage });
  record({ name: 'mutation', outcome: 'findings', code: 1, reason: 'survived', text: 'Mutation results.', snapshots: mutation, onFailure: 'report' });
  record(audit);
  record(lint);
  return { checks: collector.results, mutation };
}

it('reports each check from the unified results, in the order verify ran them', () => {
  add('plan_approved', approval());
  const { checks } = firstPass();
  const report = reportOf(checks, { live, branch, root, ...verificationInputs, before: live.length + 1 });
  expect(report.coverage).toEqual({ status: 'complete', uncovered: [{ file: 'modules/a.ts', line: 2 }, { file: 'modules/a.ts', line: 4 }] });
  expect(report.mutation).toMatchObject({ status: 'partial', reason: 'Mutation results.', survivors: [expect.objectContaining({ id: '1', line: expect.any(Number) })] });
  expect(report.mutation).not.toHaveProperty('treeFingerprint');
  expect(report.checks).toEqual([
    { name: 'compile', status: 'skipped', reason: 'not checked: compile' },
    { name: 'tests', status: 'clean' },
    { name: 'req:trace', status: 'clean' },
    { name: 'audit', status: 'findings', report: audit.text },
    { name: 'lint', status: 'clean' },
  ]);
});

it('marks reused results with their producer\'s tree and keeps the producer\'s measurement', () => {
  add('plan_approved', approval());
  const first = firstPass();
  add('verified', verified({ treeFingerprint, results: first.checks }));
  const collector = verificationResults(branch, configured(), [], root);
  for (const name of ['mutation', 'audit']) expect(collector.record({ name, outcome: 'skipped', ranBefore: true, reason: 'Ran before.', onFailure: 'report' })).toBe(true);
  const report = reportOf(collector.results, { live, branch, root, ...verificationInputs, before: live.length + 1 });
  expect(report.mutation).toMatchObject({ status: 'partial', treeFingerprint, survivors: [expect.objectContaining({ id: '1' })] });
  expect(analysisRequest(3, report)).toContain('Limit mutation [partial]');
  expect(analysisRequest(3, report)).toContain('Limit mutation [reused]');
  expect(report.checks).toContainEqual({ name: 'audit', status: 'findings', report: audit.text, treeFingerprint });
  add('verified', verified({ treeFingerprint: later, results: collector.results }));
  const again = verificationResults(branch, configured(), [], root);
  expect(again.record({ name: 'audit', outcome: 'skipped', ranBefore: true, reason: 'Ran before.', onFailure: 'report' })).toBe(true);
  const repeated = reportOf(again.results, { live, branch, root, ...verificationInputs, before: live.length + 1 });
  expect(repeated.checks.find(check => check.name === 'audit').treeFingerprint).toBe(treeFingerprint);
  expect(() => reportOf(collector.results, { live, branch, root, ...verificationInputs, before: 2 })).toThrow('Reuse source is not an earlier verified event');
});

it('uses the producing baseline when reading a receipt after a baseline move', () => {
  const initial = approval();
  add('plan_approved', initial);
  const { checks } = firstPass();
  const original = add('verified', verified({ results: checks }));
  const moved = 'd'.repeat(40);
  add('baseline_moved', { from: readBaseline(initial.baseline), to: moved });
  current.mockReturnValue({ live, branch, ...verificationInputs, baseline: moved });
  const next = verificationResults(branch, configured(), [], root);
  expect(next.record({ name: 'coverage', outcome: 'skipped', ranBefore: true })).toBe(false);
  expect(next.problem('coverage')).toContain('No producing verification');
  expect(reportFor(original, live, root).coverage.uncovered).toHaveLength(2);
  expect(readCoverageSnapshot).toHaveBeenLastCalledWith(branch, expect.any(Object), readBaseline(initial.baseline), root);
  const fresh = add('verified', verified({ baseline: moved, results: firstPass(touched, moved).checks }));
  expect(reportFor(fresh, live, root).coverage.uncovered).toHaveLength(2);
  expect(readCoverageSnapshot).toHaveBeenLastCalledWith(branch, expect.any(Object), moved, root);
});

it('reports what was not measured as not measured, never as complete', () => {
  add('plan_approved', approval());
  const collector = verificationResults(branch, configured(), ['tests'], root);
  const report = reportOf(collector.results, { live, branch, root });
  expect(report.coverage).toEqual({ status: 'skipped', reason: 'An earlier step stopped verification.', uncovered: [] });
  expect(report.mutation).toEqual({ status: 'skipped', reason: 'An earlier step stopped verification.', survivors: [] });
  expect(report.checks).toContainEqual({ name: 'tests', status: 'skipped', reason: 'An earlier step stopped verification.' });
  const deferred = structuredClone(collector.results);
  Object.assign(deferred.find(item => item.name === 'mutation'), { reason: 'Mutation testing deferred: not enough time.' });
  expect(reportOf(deferred, { live, branch, root }).mutation.status).toBe('deferred');
  const unknown = firstPass(null).checks;
  expect(reportOf(unknown, { live: [], branch, root, baseline: null }).coverage).toEqual({ status: 'unavailable', reason: 'The touched lines could not be measured.', uncovered: [] });
  const missing = [];
  expect(reportOf(missing, { live, branch, root })).toEqual({ coverage: { status: 'unavailable', reason: 'Verify supplied no coverage result.', uncovered: [] },
    mutation: { status: 'unavailable', reason: 'Verify supplied no validated mutation run.', survivors: [] }, checks: [] });
});

it('reads the receipt report from its recorded results', () => {
  add('plan_approved', approval());
  const { checks } = firstPass();
  const receipt = add('verified', verified({ treeFingerprint, results: checks }));
  const report = reportFor(receipt, live, root);
  expect(report).toEqual(reportOf(checks, { live, branch, root, ...verificationInputs, before: receipt.seq }));
  expect(report.coverage.uncovered).toHaveLength(2);
});

const failed = (name, reason) => ({ name, status: 'failed', reason, evidence: [], summary: { diagnostics: 'broken' } });
const ok = (name, summary) => ({ name, status: 'ok', reason: 'Completed.', evidence: [], summary });
const quality = (tests, coverage, mutation) => [tests, coverage, mutation];

it('gives exact entries for missing results and keeps a failed one unavailable without reading it', () => {
  const context = { live, branch, root };
  expect(reportOf([], context)).toEqual({
    coverage: { status: 'unavailable', reason: 'Verify supplied no coverage result.', uncovered: [] },
    mutation: { status: 'unavailable', reason: 'Verify supplied no validated mutation run.', survivors: [] },
    checks: [],
  });
  const broken = [failed('lint', 'Lint broke.'), ...quality(failed('tests', 'Tests broke.'), failed('coverage', 'Coverage broke.'), failed('mutation', 'Mutation broke.'))];
  expect(reportOf(broken, context)).toMatchObject({
    coverage: { status: 'unavailable', reason: 'Coverage broke.', uncovered: [] },
    mutation: { status: 'unavailable', reason: 'Mutation broke.', survivors: [] },
  });
  expect(reportOf(broken, context).checks).toEqual(expect.arrayContaining([
    { name: 'tests', status: 'unavailable', reason: 'Tests broke.' },
    { name: 'lint', status: 'unavailable', reason: 'Lint broke.' },
  ]));
});

// The rulebook sits outside the tree fingerprint, so it can change while a
// receipt stands. The report is the run's, whatever the rulebook says now.
it('rebuilds the same report after the rulebook switches checks off or adds one', () => {
  add('plan_approved', approval());
  const { checks } = firstPass();
  const receipt = add('verified', verified({ treeFingerprint, results: checks }));
  const before = reportFor(receipt, live, root);
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [{ name: 'added', chain: 'codeQuality', runs: 'everyVerify', onFailure: 'block' }] });
  expect(reportFor(receipt, live, root)).toEqual(before);
  expect(before.mutation.survivors).toHaveLength(1);
  expect(before.checks.map(check => check.name)).not.toContain('added');
  const off = [{ name: 'mutation', status: 'skipped', reason: 'Disabled in the rulebook.', evidence: [], summary: {} }];
  readChecks.mockReturnValue(rulebook);
  expect(reportOf(off, { live, branch, root }).mutation).toEqual({ status: 'skipped', reason: 'Disabled in the rulebook.', survivors: [] });
});

it.each(['removed', 'altered'])('names the result whose evidence was %s', damage => {
  add('plan_approved', approval());
  const { checks } = firstPass();
  const receipt = add('verified', verified({ treeFingerprint, results: checks }));
  const snapshot = join(root, checks.find(item => item.name === 'coverage').evidence[1].snapshot);
  if (damage === 'removed') rmSync(snapshot);
  else writeFileSync(snapshot, 'replacement');
  expect(() => reportFor(receipt, live, root)).toThrow(`the coverage evidence cannot be read: coverage analysis (${checks.find(item => item.name === 'coverage').evidence[1].snapshot}): `
    + (damage === 'removed' ? 'ENOENT' : 'SHA-256 digest mismatch'));
});

it('checks the saved schema before reporting an ordinary check’s printed findings', () => {
  const { checks } = firstPass();
  const result = checks.find(check => check.name === 'audit');
  const document = checkDocument(audit.name, audit);
  const analysis = version => publishSnapshot(branch, { folder: 'checks/analysis', extension: 'json' },
    Buffer.from(JSON.stringify({ ...document, version })), root);
  const reference = { role: 'analysis', title: 'Audit result', snapshot: analysis(1) };
  result.evidence.push(reference);
  const read = () => reportOf([result], { live, branch, root }).checks;
  expect(read()).toEqual([{ name: 'audit', status: 'findings', report: audit.text }]);

  reference.snapshot = analysis(2);
  expect(read).toThrow(new Error(`the audit evidence cannot be read: ${reference.snapshot}: check analysis.version has unsupported schema version 2 (expected 1)`));
});

it('names the mutation result when its findings are lost', () => {
  add('plan_approved', approval());
  const { checks } = firstPass();
  const receipt = add('verified', verified({ treeFingerprint, results: checks }));
  rmSync(join(root, checks.find(item => item.name === 'mutation').evidence[1].snapshot));
  expect(() => reportFor(receipt, live, root)).toThrow(/^the mutation evidence cannot be read: /);
});

it('refuses to report a passing suite when its archived JUnit report is missing', () => {
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  const result = testResult(branch, reports, root);
  rmSync(join(root, reports[0].snapshot));
  const read = () => reportOf([result], { live, branch, root });
  expect(read).toThrow(`the tests evidence cannot be read: JUnit XML (${reports[0].snapshot}): ENOENT`);
});

it('preserves the original limitation when reporting a historical partial tests receipt', () => {
  const reports = writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root);
  const tests = testResult(branch, reports, root);
  const complete = reportOf([tests], { live, branch, root });
  const analysis = tests.evidence.find(item => item.role === 'analysis');
  const document = JSON.parse(readFileSync(join(root, analysis.snapshot), 'utf8'));
  document.measurement.reported = false;
  tests.reason = document.result.reason = 'not checked: inverted tests';
  analysis.snapshot = publishSnapshot(branch, TEST_ANALYSIS, Buffer.from(JSON.stringify(document)), root);
  tests.status = 'partial';
  const partial = reportOf([tests], { live, branch, root });
  expect(complete.checks).toEqual([{ name: 'tests', status: 'clean' }]);
  expect(partial.checks).toEqual([{ name: 'tests', status: 'partial', reason: tests.reason }]);
  expect(analysisRequest(2, partial)).toContain('Limit tests [partial]');
  expect(analysisRequest(2, complete)).not.toContain('Limit tests [partial]');

  add('plan_approved', approval());
  const original = firstPass().checks.map(check => check.name === 'tests' ? tests : check);
  add('verified', verified({ treeFingerprint, results: original }));
  const next = verificationResults(branch, [], ['tests'], root);
  expect(next.record({ name: 'tests', outcome: 'skipped', ranBefore: true })).toBe(true);
  const reused = reportOf(next.results, { live, branch, root, ...verificationInputs, before: live.length + 1 });
  expect(reused.checks).toContainEqual({ name: 'tests', status: 'partial', reason: tests.reason, treeFingerprint });
});

it('keeps recorded order instead of relocating tests around req:trace', () => {
  const tests = testResult(branch, writeJUnitSnapshot(branch, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }], root), root);
  const order = results => reportOf(results, { live, branch, root }).checks.map(check => check.name);
  const clean = name => ok(name, { outcome: 'clean' });
  expect(order([clean('compile'), tests, clean('req:trace'), clean('lint')])).toEqual(['compile', 'tests', 'req:trace', 'lint']);
  expect(order([clean('req:trace'), clean('lint'), tests])).toEqual(['req:trace', 'lint', 'tests']);
});
