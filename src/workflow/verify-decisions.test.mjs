import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVerify } from './referee-verify.ts';
import { runCompile } from './adapter.mjs';
import { runLint } from '../requirements/lint.ts';
import { runGuard } from '../requirements/guard.ts';
import { runTrace } from '../evidence/trace.ts';
import { runTestCommand, outcomesOf } from '../evidence/test-run.ts';
import { mutate } from '../evidence/mutants.ts';
import { baselineSha, runCheck } from './checks.mjs';
import { readChecks } from './rulebook.mjs';
import { current } from './state.mjs';
import { TargetError } from './target.mjs';
import { runCoverageCheck } from './coverage.mjs';
import { writeCoverageSnapshot } from './coverage-snapshot.mjs';
import { readMutationSnapshot, writeMutationSnapshot } from './mutation-snapshot.mjs';
import { append, currentBranch, dirFor, fileFor, sha256 } from './chain.mjs';
import { verificationInputs, verified, approval, treeFingerprint } from '../../tests/fixtures/workflow/events.mjs';
import { mutationSummary, testCase, testRun } from '../../tests/fixtures/workflow/quality-results.mjs';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

vi.mock('./chain.mjs', { spy: true });
vi.mock('node:child_process', { spy: true });
vi.mock('./adapter.mjs', { spy: true });
vi.mock('../requirements/lint.ts', () => ({ runLint: vi.fn() }));
vi.mock('../requirements/guard.ts', () => ({ runGuard: vi.fn() }));
vi.mock('../evidence/trace.ts', () => ({ runTrace: vi.fn() }));
vi.mock('../evidence/test-run.ts', { spy: true });
vi.mock('../evidence/mutants.ts', () => ({ mutate: vi.fn() }));
vi.mock('./checks.mjs', { spy: true });
vi.mock('./rulebook.mjs', { spy: true });
vi.mock('./state.mjs', () => ({ current: vi.fn() }));
vi.mock('./coverage.mjs', { spy: true });
vi.mock('./coverage-snapshot.mjs', { spy: true });
vi.mock('./mutation-snapshot.mjs', { spy: true });

const nativeMutation = await vi.importActual('./mutation-snapshot.mjs');
const nativeCoverage = await vi.importActual('./coverage-snapshot.mjs');
const standard = statuses => JSON.stringify(reportOf(statuses.map((status, i) => mutant(status, { id: String(i) }))));

const check = (name, extra = {}) => ({
  name, chain: 'testQuality', runs: 'everyVerify', onFailure: 'block', ...extra,
});
const mutation = check('mutation', { runs: 'oncePerPlan', onFailure: 'report', timeLimitSeconds: 240 });
function mockRun() {
  runTestCommand.mockImplementation(({ capture }) => {
    capture([{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }]);
    return { cases: [], leftOut: [], exit: 0 };
  });
}
let dir, log, errors;
beforeEach(() => {
  vi.clearAllMocks();
  readMutationSnapshot.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'verify-results-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  currentBranch.mockReturnValue('topic');
  readMutationSnapshot.mockImplementation(nativeMutation.readMutationSnapshot);
  writeMutationSnapshot.mockImplementation(nativeMutation.writeMutationSnapshot);
  writeCoverageSnapshot.mockImplementation(nativeCoverage.writeCoverageSnapshot);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  runLint.mockReturnValue(true);
  runGuard.mockReturnValue(true);
  spawnSync.mockReturnValue({ status: 0 });
  runCompile.mockReturnValue({ errors: [] });
  mockRun();
  outcomesOf.mockReturnValue([]);
  runTrace.mockReturnValue(true);
  baselineSha.mockReturnValue('base');
  current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [append(join(dir, dirFor('topic')), 'plan_approved', approval(), 'topic')] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
async function verify(...args) {
  const file = join(dir, 'result.json');
  const status = await runVerify(['--results', file, ...args]);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  // The unified results are the whole answer; nothing of the old transport.
  expect(Object.keys(written)).toEqual(['results']);
  const results = written.results;
  return { status, results, named: name => results.find(item => item.name === name) };
}
it.each([
  ['compile', () => runCompile.mockReturnValue({ errors: Array.from({ length: 41 }, (_, i) => ({ file: 'code.ts', line: i + 1, message: 'invalid' })) })],
  ['tests', () => outcomesOf.mockReturnValue([{ file: 'suite', title: 'broken', failed: true, reason: 'did not load' }])],
])('stops at %s and explains the failure before tracing', async (step, fail) => {
  fail();
  const result = await verify();
  expect(result.status).toBe(1);
  expect(result.named(step).status).toBe('failed');
  expect(result.named('req:trace')).toMatchObject({ status: 'skipped', reason: 'An earlier step stopped verification.' });
  expect(runTrace).not.toHaveBeenCalled();
  const diagnostic = errors.mock.calls.flat().join('\n');
  expect(diagnostic).toContain('failed at ' + step);
  expect(diagnostic).toContain(step === 'compile' ? '… and 1 more' : 'suite — broken (did not load)');
});
it('names the checks the adapter could not perform on a passing run', async () => {
  runCompile.mockReturnValue(null);
  expect((await verify()).status).toBe(0);
  expect(runTrace).toHaveBeenCalledWith(runTestCommand.mock.results[0].value);
  const summary = log.mock.calls.flat().filter(line => line.startsWith('verify:'));
  for (const name of ['compile', 'mutation', 'coverage']) expect(summary.join('\n')).toContain(name);
});

async function verifySuite(run, reports) {
  runTestCommand.mockImplementationOnce(({ capture }) => { capture(reports); return run; });
  const runner = await vi.importActual('../evidence/test-run.ts');
  outcomesOf.mockImplementationOnce(runner.outcomesOf);
  return verify();
}

it('saves the failure count and one diagnostic line per failed case, in suite order', async () => {
  const run = testRun({ exit: 1, cases: [
    testCase({ file: 'fast.mjs', name: 'adds', status: 'failed', message: 'expected 4' }),
    testCase({ file: 'fast.mjs', name: 'subtracts' }),
    testCase({ file: 'slow.mjs', name: 'loads', status: 'failed' }),
  ] });
  const result = await verifySuite(run, [{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }]);
  const tests = result.named('tests');
  expect(tests).toMatchObject({ status: 'failed', reason: 'Check failed.' });
  const analysis = tests.evidence.find(item => item.role === 'analysis');
  const saved = JSON.parse(readFileSync(join(dir, analysis.snapshot), 'utf8'));
  expect(saved.result).toEqual({ outcome: 'findings', exitCode: 1, reason: 'Check failed.',
    text: 'tests — 2 of 3 failed\n  fast.mjs — adds (expected 4)\n  slow.mjs — loads' });
});

it.each([
  ['SIGTERM', false],
  ['SIGKILL', true],
])('records %s as the failed test step’s reason (partial XML=%s)', async (exit, partial) => {
  const run = testRun({ exit, cases: partial ? [testCase()] : [],
    leftOut: partial ? [] : [{ file: 'missing.test.mjs', ids: [], scenarios: [], bare: [] }] });
  const reports = partial ? [{ name: 'partial.xml', bytes: Buffer.from('<testsuite><testcase name="example"/></testsuite>') }] : [];
  const result = await verifySuite(run, reports);
  expect(result.status).toBe(1);
  expect(result.named('tests')).toMatchObject({ status: 'failed', reason: 'Test command stopped by ' + exit + '.' });
  expect(result.named('req:trace').status).toBe('skipped');
  expect(runTrace).not.toHaveBeenCalled();
});
it.each([false, true])('keeps a failed test run diagnostic and only its captured reports (captured=%s)', async captured => {
  const reports = [
    { name: 'reports/fast.xml', bytes: Buffer.from('<testsuites/>') },
    { name: 'reports/slow.xml', bytes: Buffer.from('all green') },
  ];
  const diagnostic = 'test run: a test report could not be read: reports/slow.xml';
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [check('build')] });
  runTestCommand.mockImplementation(({ capture }) => {
    if (captured) capture(reports);
    throw new TargetError(diagnostic);
  });
  const result = await verify();
  expect(result.status).toBe(1);
  const tests = result.named('tests');
  expect(tests.status).toBe('failed');
  expect(tests.summary).toEqual({ diagnostics: diagnostic });
  expect(tests.evidence.map(item => ({ role: item.role, title: item.title,
    bytes: readFileSync(join(dir, item.snapshot)) }))).toEqual(captured
    ? reports.map(report => ({ role: 'raw', title: `JUnit: ${report.name}`, bytes: report.bytes })) : []);
  expect(errors.mock.calls.flat().join('\n')).toContain(`verify: refused — ${diagnostic}`);
  expect(runTrace).not.toHaveBeenCalled();
  expect(runCheck).not.toHaveBeenCalled();
  expect(result.named('req:trace').status).toBe('skipped');
  expect(result.named('build').status).toBe('skipped');
});
it('keeps captured JUnit evidence on tests when a later builtin throws', async () => {
  runTrace.mockImplementationOnce(() => { throw new TargetError('Tracing could not finish.'); });
  const result = await verify();
  expect(result.status).toBe(1);
  expect(result.named('tests').status).toBe('ok');
  expect(result.named('tests').evidence.filter(item => item.role === 'raw').map(item => readFileSync(join(dir, item.snapshot), 'utf8'))).toEqual(['<testsuites/>']);
  expect(result.named('req:trace')).toMatchObject({ status: 'failed', evidence: [],
    summary: { diagnostics: 'Tracing could not finish.' } });
});
it('reports a standalone test-run refusal without requiring a results collector', async () => {
  runTestCommand.mockImplementationOnce(() => { throw new TargetError('Test command could not start.'); });
  await expect(runVerify()).resolves.toBe(1);
  expect(errors.mock.calls.flat()).toContain('verify: refused — Test command could not start.');
  expect(runTrace).not.toHaveBeenCalled();
  expect(existsSync(join(dir, 'result.json'))).toBe(false);
});
it.each([
  ['findings', 'report', 0], ['findings', 'block', 1], ['broken', 'report', 1],
])('a configured check with %s and onFailure=%s gives status %i', async (outcome, onFailure, status) => {
  // Coverage itself must block in a valid rulebook. Exercise the generic
  // scheduler policy with a configurable audit rather than impossible coverage.
  readChecks.mockReturnValue({ testQuality: [check('audit', { onFailure })], codeQuality: [check('build')] });
  runCheck.mockImplementation(check => check.name === 'audit'
    ? { outcome, reason: 'audit result', text: 'details', code: 1 }
    : { outcome: 'clean', reason: 'built', text: '', code: 0 });
  const result = await verify();
  expect(result.status).toBe(status);
  expect(runCheck.mock.calls.map(([c]) => c.name)).toEqual(status ? ['audit'] : ['audit', 'build']);
  const audit = result.named('audit');
  expect(audit).toEqual({ name: 'audit', status: status ? 'failed' : 'ok', reason: 'audit result',
    evidence: [{ role: 'raw', title: 'audit output', snapshot: expect.any(String) }], summary: { outcome, exitCode: 1 } });
  expect(readFileSync(join(dir, audit.evidence[0].snapshot), 'utf8')).toBe('details');
  expect(result.named('build').status).toBe(status ? 'skipped' : 'ok');
});
it.each([
  ['clean', 0, 0], ['survived', 1, 1], ['nothing', 2, 0],
])('preserves %s mutation evidence with the budget and deadline', async (outcome, code, survived) => {
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  const raw = standard([outcome === 'clean' ? 'Killed' : outcome === 'survived' ? 'Survived' : 'NoCoverage']);
  const findings = findingsOf(JSON.parse(raw));
  mutate.mockResolvedValue({ outcome, code, findings, rawReport: 'original', standardReport: raw, lines: ['tool output'] });
  const result = await verify('--deadline', '300000');
  expect(result.status).toBe(0);
  expect(mutate).toHaveBeenCalledWith({ base: 'base', cwd: process.cwd(), budget: 240, deadline: 300000 });
  const reason = (outcome === 'nothing' ? 'inconclusive: ' : '') + '1 mutant, ' + findings.counts.caught + ' caught, ' + survived + ' survived';
  const snapshots = writeMutationSnapshot.mock.results[0].value;
  expect(result.named('mutation')).toEqual({ name: 'mutation', status: outcome === 'nothing' ? 'partial' : 'ok', reason: outcome === 'nothing' ? `Mutation measurement is incomplete: ${reason}` : reason,
    summary: { totalMutants: 1, killed: outcome === 'clean' ? 1 : 0, survived, unproved: outcome === 'nothing' ? 1 : 0, ignored: 0, errored: 0 },
    evidence: [{ role: 'raw', title: 'Raw mutation results', snapshot: snapshots.raw },
      { role: 'analysis', title: 'Mutation findings and limitations', snapshot: snapshots.findings }] });
  expect(writeMutationSnapshot).toHaveBeenCalledExactlyOnceWith(currentBranch(), {
    raw, status: code, outcome, report: 'original\n' + reason, findings,
  });
});
it.each([
  ['none', 'skipped', 0], ['failed', 'failed', 1],
])('distinguishes a mutation run that returned %s without findings', async (outcome, expected, status) => {
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  mutate.mockResolvedValue({ outcome, code: 1, lines: ['no result'] });
  const result = await verify();
  expect(result.status).toBe(status);
  expect(result.named('mutation').status).toBe(expected);
  expect(writeMutationSnapshot).not.toHaveBeenCalled();
});
it('reports an unavailable baseline as broken before launching mutation', async () => {
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  baselineSha.mockImplementationOnce(() => { throw Error('unavailable'); });
  const result = await verify();
  expect(result.status).toBe(1);
  expect(result.named('mutation')).toMatchObject({ status: 'failed', reason: expect.stringContaining('no baseline') });
  expect(mutate).not.toHaveBeenCalled();
});
/** A unified mutation result naming these snapshots. */
const mutationResult = (snapshots, status = 'ok', summary = {}) => ({ name: 'mutation', status, reason: 'Measured.', evidence: [
  { role: 'raw', title: 'Raw mutation results', snapshot: snapshots.raw },
  { role: 'analysis', title: 'Mutation findings and limitations', snapshot: snapshots.findings },
], summary });
const skippedResult = (name, reason = 'Not measured here.') => ({ name, status: 'skipped', reason, evidence: [], summary: {} });
const quality = (mutationOne = skippedResult('mutation')) => [skippedResult('tests'), skippedResult('coverage'), mutationOne];

it.each([true, false])('skips configured checks in CI or reuses their receipts (CI=%s)', async ci => {
  vi.stubEnv('CI', String(ci));
  const raw = standard(['Killed']);
  const findings = findingsOf(JSON.parse(raw));
  const snapshots = nativeMutation.writeMutationSnapshot('topic', { raw, status: 0, outcome: 'clean', report: 'prior result', findings }, dir);
  const directory = join(dir, dirFor('topic'));
  const grant = current.mock.results[0]?.value?.live?.[0] ?? JSON.parse(readFileSync(join(directory, '0001__plan_approved.json')));
  const original = append(directory, 'verified', verified({ treeFingerprint, results: [{ name: 'audit', status: 'ok', reason: 'clean', evidence: [], summary: { outcome: 'clean', exitCode: 0 } }, ...quality(mutationResult(snapshots, 'ok', mutationSummary(findings)))] }), 'topic');
  current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [grant, original] });
  readChecks.mockReturnValue({ testQuality: [{ ...mutation, skipInCi: true }, check('audit', { runs: 'oncePerPlan', skipInCi: true })], codeQuality: [] });
  const result = await verify();
  expect(result.status).toBe(0);
  if (ci) {
    expect(result.named('mutation')).toMatchObject({ status: 'skipped', reason: 'skipped in CI (skipInCi: true)' });
    expect(result.named('audit')).toMatchObject({ status: 'skipped', reason: 'skipped in CI (skipInCi: true)' });
    expect(readMutationSnapshot).not.toHaveBeenCalled();
  } else {
    expect(readMutationSnapshot).toHaveBeenCalledWith(currentBranch(), snapshots);
    expect(log.mock.calls.flat().join('\n')).toContain('prior result');
    expect(result.named('mutation')).toMatchObject({ status: 'reused', source: { seq: original.seq }, summary: mutationSummary(findings) });
    expect(result.named('audit')).toMatchObject({ status: 'reused', source: { seq: original.seq } });
  }
  expect(mutate).not.toHaveBeenCalled();
  expect(runCheck).not.toHaveBeenCalled();
  expect(writeMutationSnapshot).not.toHaveBeenCalled();
});

/** A first pass whose unified results name its mutation evidence. */
function unifiedProducer() {
  const directory = join(dir, dirFor('topic'));
  const grant = JSON.parse(readFileSync(join(directory, '0001__plan_approved.json')));
  const raw = standard(['Survived']);
  const unified = nativeMutation.writeMutationSnapshot('topic', { raw, status: 1, outcome: 'survived', report: 'unified result', findings: findingsOf(JSON.parse(raw)) }, dir);
  const results = (status, extra = {}) => ([...quality({ ...mutationResult(unified, status, mutationSummary(findingsOf(JSON.parse(raw)))), ...extra })]);
  const original = append(directory, 'verified', verified({ treeFingerprint, results: results('ok') }), 'topic');
  return { directory, grant, original, unified, results };
}

it('runs every once-per-plan check when there is no logbook to ask, as in a verify by hand without a target', async () => {
  current.mockImplementation(() => { throw new TargetError('no target is configured'); });
  readChecks.mockReturnValue({ testQuality: [check('audit', { runs: 'oncePerPlan' })], codeQuality: [] });
  runCheck.mockReturnValue({ outcome: 'clean', code: 0, text: '', reason: 'clean' });
  const result = await verify();
  expect(result.status).toBe(0);
  expect(runCheck).toHaveBeenCalledOnce();
  expect(result.named('audit')).toMatchObject({ status: 'ok', summary: { outcome: 'clean' } });
});

it('reuses mutation from the unified producer\'s evidence', async () => {
  const { grant, original, unified } = unifiedProducer();
  current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [grant, original] });
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  const result = await verify();
  expect(result.status).toBe(0);
  expect(result.named('mutation')).toMatchObject({ status: 'reused', source: { seq: original.seq },
    evidence: [{ snapshot: unified.raw }, { snapshot: unified.findings }] });
  expect(log.mock.calls.flat().join('\n')).toContain('unified result');
  expect(readMutationSnapshot).toHaveBeenCalledWith('topic', unified);
  expect(mutate).not.toHaveBeenCalled();
});

it('follows a reused result to its validated producer, and reports a tampered one as broken', async () => {
  const { directory, grant, original, unified, results } = unifiedProducer();
  const fingerprint = sha256(readFileSync(join(directory, fileFor(original))));
  const reusing = append(directory, 'verified', verified({ treeFingerprint: 'b'.repeat(64),
    results: results('reused', { reason: 'Runs once per approved plan.', source: { seq: original.seq, fingerprint } }) }), 'topic');
  current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [grant, original, reusing] });
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  expect((await verify()).named('mutation')).toMatchObject({ status: 'reused', source: { seq: original.seq },
    evidence: [{ snapshot: unified.raw }, { snapshot: unified.findings }] });
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [check('build')] });
  writeFileSync(join(directory, fileFor(original)), readFileSync(join(directory, fileFor(original)), 'utf8') + ' ');
  const broken = await verify();
  expect(broken.status).toBe(1);
  expect(broken.named('mutation')).toMatchObject({ status: 'failed',
    reason: expect.stringMatching(/^mutation: Reuse source logbook is broken: .*Restore the exact evidence in \.katatay\/local\//) });
  expect(broken.named('build')).toMatchObject({ status: 'skipped', reason: 'An earlier step stopped verification.' });
  expect(mutate).not.toHaveBeenCalled();
  expect(runCheck).not.toHaveBeenCalled();
});

it.each(['missing raw report', 'missing findings', 'SHA-256 digest mismatch', 'Mutation findings do not match the raw report'])(
  'refuses reuse with %s instead of running mutation or later checks', async problem => {
    const snapshots = { raw: 'original raw', findings: 'original findings' };
    current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [{ event: 'plan_approved' },
      { seq: 7, event: 'verified', payload: { ...verificationInputs, results: [...quality(mutationResult(snapshots))] } }] });
    readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [check('build')] });
    readMutationSnapshot.mockImplementation(() => { throw Error(problem); });
    const reason = `mutation: verification 7: ${problem}. Restore the exact evidence in .katatay/local/ or ask the operator to reset the workflow.`;
    const result = await verify();
    expect(result.status).toBe(1);
    expect(result.named('mutation')).toMatchObject({ status: 'failed', reason });
    expect(result.named('build').status).toBe('skipped');
    expect(errors.mock.calls.flat()).toContain(reason);
    expect(mutate).not.toHaveBeenCalled();
    expect(writeMutationSnapshot).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

it.each(['failed verification', 'skipped verification', 'new approval'])(
  'performs a fresh mutation run when the history supplies only a %s', async kind => {
    const saved = [...quality(mutationResult({ raw: 'old raw', findings: 'old findings' }))];
    const history = {
      'failed verification': [{ event: 'verify_failed', payload: { ...verificationInputs, results: saved } }],
      'skipped verification': [{ event: 'verified', payload: { ...verificationInputs, results: [...quality(skippedResult('mutation', 'skipped in CI'))] } }],
      'new approval': [{ event: 'verified', payload: { ...verificationInputs, results: saved } }, { event: 'plan_approved' }],
    };
    current.mockReturnValue({ branch: 'topic', ...verificationInputs, live: [{ event: 'plan_approved' }, ...history[kind]] });
    readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
    const findings = findingsOf(reportOf([]));
    mutate.mockResolvedValue({ outcome: 'clean', code: 0, findings, standardReport: standard([]), lines: ['fresh result'] });
    const result = await verify();
    expect(result.status).toBe(0);
    const snapshots = writeMutationSnapshot.mock.results[0].value;
    expect(result.named('mutation')).toMatchObject({ status: 'ok', evidence: [{ snapshot: snapshots.raw }, { snapshot: snapshots.findings }] });
    expect(mutate).toHaveBeenCalledOnce();
    expect(readMutationSnapshot).toHaveBeenCalledWith('topic', snapshots, dir);
  });

it.each(['missing standard report', 'publication failed'])('fails verification when mutation has %s', async failure => {
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [check('build')] });
  const findings = findingsOf(reportOf([]));
  mutate.mockResolvedValue({ outcome: 'clean', code: 0, findings, lines: ['tool output'],
    ...(failure === 'publication failed' ? { standardReport: standard([]) } : {}) });
  writeMutationSnapshot.mockImplementationOnce(() => { throw Error('disk full'); });
  try {
    const result = await verify();
    expect(result.status).toBe(1);
    expect(result.named('mutation')).toMatchObject({ status: 'failed', evidence: [], reason: expect.stringContaining(
      failure === 'publication failed' ? 'disk full' : 'No standard mutation report was returned') });
    expect(runCheck).not.toHaveBeenCalled();
    expect(writeMutationSnapshot).toHaveBeenCalledTimes(failure === 'publication failed' ? 1 : 0);
  } finally {
    // An unspent one-time failure must not reach the next case.
    writeMutationSnapshot.mockReset();
  }
});

it('preserves the displayed mutation report when there is no separate original text', async () => {
  readChecks.mockReturnValue({ testQuality: [mutation], codeQuality: [] });
  const raw = standard(['Killed', 'Killed']);
  const findings = findingsOf(JSON.parse(raw));
  mutate.mockResolvedValue({ outcome: 'clean', code: 0, findings, standardReport: raw, lines: ['tool output'] });
  const result = await verify();
  expect(result.status).toBe(0);
  expect(writeMutationSnapshot).toHaveBeenCalledExactlyOnceWith(currentBranch(), {
    raw, status: 0, outcome: 'clean', report: 'tool output\n2 mutants, 2 caught, 0 survived', findings,
  });
});
it('refuses incomplete results and invalid deadlines before any check runs', async () => {
  expect(await runVerify(['--results'])).toBe(1);
  const refused = await verify('--deadline', 'tomorrow');
  expect(refused.status).toBe(1);
  expect(refused.results.every(item => item.status === 'skipped')).toBe(true);
  expect(runLint).not.toHaveBeenCalled();
  expect(errors.mock.calls.flat().join('\n')).toContain('absolute time in milliseconds');
});

it('rejects an empty capture even when the runner reports no failed outcomes', async () => {
  runTestCommand.mockImplementation(({ capture }) => { capture([]); return testRun(); });
  expect((await verify()).status).toBe(1);
  expect(errors.mock.calls.flat().join(' ')).toContain('test command produced no JUnit report');
  expect(runTrace).not.toHaveBeenCalled();
});

it('can verify without a results file', async () => {
  expect(await runVerify()).toBe(0);
  expect(runTrace).toHaveBeenCalledOnce();
});

it('gives the coverage check a publisher that keeps its snapshots on this branch', async () => {
  readChecks.mockReturnValue({ testQuality: [check('coverage')], codeQuality: [] });
  const figures = { covered: 1, total: 1, measured: 1000, minimum: 0 };
  const analysis = JSON.stringify({ version: 1, name: 'coverage', result: { outcome: 'clean', reason: 'clean', exitCode: 0, text: '' },
    measurement: { folders: [{ folder: 'modules/', files: 1, lines: figures, branches: figures }], failures: [], touched: null } });
  runCoverageCheck.mockImplementation((_, __, { publish }) => ({ outcome: 'clean', reason: 'clean', text: '', code: 0, baseline: null, snapshots: publish('SF:x', analysis) }));
  const result = await verify();
  expect(result.status).toBe(0);
  expect(runCoverageCheck).toHaveBeenCalledWith(expect.objectContaining({ name: 'coverage' }), process.cwd(), { publish: expect.any(Function) });
  expect(writeCoverageSnapshot).toHaveBeenCalledWith(currentBranch(), { raw: 'SF:x', analysis });
  const snapshots = writeCoverageSnapshot.mock.results[0].value;
  expect(result.named('coverage')).toMatchObject({ status: 'ok', evidence: [{ role: 'raw', snapshot: snapshots.raw }, { role: 'analysis', snapshot: snapshots.analysis }] });
});

it.each(['builtin', 'configured'])('preserves a thrown %s step failure before propagating it', async kind => {
  if (kind === 'builtin') runLint.mockImplementationOnce(() => { throw Error('built-in failed to start'); });
  else {
    readChecks.mockReturnValue({ testQuality: [], codeQuality: [check('audit'), check('later')] });
    runCheck.mockImplementationOnce(() => { throw Error('configured failed to start'); });
  }
  await expect(verify()).rejects.toThrow(kind === 'builtin' ? 'built-in failed to start' : 'configured failed to start');
  const saved = JSON.parse(readFileSync(join(dir, 'result.json'))).results;
  expect(saved.find(item => item.name === (kind === 'builtin' ? 'req:lint' : 'audit'))).toMatchObject({ status: 'failed',
    summary: { diagnostics: kind === 'builtin' ? 'built-in failed to start' : 'configured failed to start' } });
  if (kind === 'configured') {
    expect(runCheck).toHaveBeenCalledOnce();
    expect(saved.find(item => item.name === 'later').status).toBe('skipped');
  }
});

it('fails before later commands when a configured result cannot publish its evidence', async () => {
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [check('audit'), check('later')] });
  runCheck.mockImplementationOnce(() => {
    writeFileSync(join(dir, '.katatay/local/topic/checks'), 'blocks the snapshot directory');
    return { outcome: 'clean', code: 0, reason: 'Passed.', text: 'command output' };
  });
  expect((await verify()).status).toBe(1);
  expect(runCheck).toHaveBeenCalledOnce();
  expect(errors.mock.calls.flat().join('\n')).toContain('verify: could not preserve audit evidence:');
  const saved = JSON.parse(readFileSync(join(dir, 'result.json'))).results;
  expect(saved.find(item => item.name === 'audit')).toMatchObject({ status: 'failed', summary: { outcome: 'clean' } });
  expect(saved.find(item => item.name === 'later').status).toBe('skipped');
});

it('fails with a diagnostic when a built-in result cannot publish its evidence', async () => {
  writeFileSync(join(dir, '.katatay/local'), 'blocks publication');
  runCompile.mockReturnValue({ errors: [{ file: 'a.ts', line: 7, message: 'invalid' }] });
  expect((await verify()).status).toBe(1);
  expect(errors.mock.calls.flat().join('\n')).toContain('verify: could not preserve compile evidence:');
  expect(runTestCommand).not.toHaveBeenCalled();
});

it('preserves both compiler diagnostics as complete separate lines in the evidence', async () => {
  runCompile.mockReturnValue({ errors: [{ file: 'a.ts', line: 7, message: 'invalid a' }, { file: 'b.ts', line: 11, message: 'invalid b' }] });
  expect((await verify()).status).toBe(1);
  const saved = JSON.parse(readFileSync(join(dir, 'result.json'))).results;
  const compile = saved.find(item => item.name === 'compile');
  expect(compile).toMatchObject({ status: 'failed', reason: 'Check failed.', summary: { outcome: 'findings' } });
  expect(readFileSync(join(dir, compile.evidence[0].snapshot), 'utf8')).toBe('a.ts:7 invalid a\nb.ts:11 invalid b');
});

it('keeps omissions scoped to their own results and preserves successful builtin statuses', async () => {
  runCompile.mockReturnValue(null);
  expect((await verify()).status).toBe(0);
  const saved = JSON.parse(readFileSync(join(dir, 'result.json'))).results;
  expect(saved.find(item => item.name === 'compile')).toMatchObject({ status: 'skipped', evidence: [], summary: {} });
  expect(saved.find(item => item.name === 'req:trace')).toMatchObject({ status: 'ok', reason: 'Check passed.', summary: { outcome: 'clean' } });
  expect(saved.find(item => item.name === 'tests')).toMatchObject({ status: 'ok', summary: { total: 0, omittedFiles: 0 } });
  expect(saved.find(item => item.name === 'tests').reason).toBe('Check passed.');
});

it('does not snapshot configured command output without a results destination', async () => {
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [check('audit')] });
  runCheck.mockReturnValue({ outcome: 'clean', code: 0, text: 'full command output', reason: 'Passed.' });
  expect(await runVerify()).toBe(0);
  expect(existsSync(join(dir, '.katatay/local/topic/checks'))).toBe(false);
});

it('preserves the initialized result list when an invalid deadline prevents all work', async () => {
  expect((await verify('--deadline', 'invalid')).status).toBe(1);
  const saved = JSON.parse(readFileSync(join(dir, 'result.json'))).results;
  expect(saved.map(item => item.name)).toEqual(['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace', 'coverage', 'mutation']);
  expect(saved.every(item => item.status === 'skipped')).toBe(true);
  expect(saved.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).map(item => item.name)).toEqual(['tests', 'coverage', 'mutation']);
});

it.each([
  ['req:lint', () => runLint.mockReturnValue(false)],
  ['req:guard', () => runGuard.mockReturnValue(false)],
  ['state:verify', () => spawnSync.mockReturnValue({ status: 1 })],
  ['req:trace', () => runTrace.mockReturnValue(false)],
])('retains the failed %s builtin and distinguishes completed steps from unreached ones', async (name, fail) => {
  readChecks.mockReturnValue({ testQuality: [check('audit')], codeQuality: [check('build')] });
  fail();
  expect((await verify()).status).toBe(1);
  const transport = JSON.parse(readFileSync(join(dir, 'result.json')));
  expect(Object.keys(transport)).toEqual(['results']);
  const names = ['req:lint', 'req:guard', 'state:verify', 'compile', 'req:trace', 'audit', 'build'];
  expect(transport.results.map(item => item.name)).toEqual(['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace', 'coverage', 'mutation', 'audit', 'build']);
  const failedIndex = names.indexOf(name);
  expect(transport.results.filter(item => !['tests', 'coverage', 'mutation'].includes(item.name))).toEqual(names.map((step, i) => i < failedIndex
    ? { name: step, status: 'ok', reason: 'Check passed.', evidence: [], summary: { outcome: 'clean' } }
    : i === failedIndex
      ? { name: step, status: 'failed', reason: 'Check failed.', evidence: [], summary: { outcome: 'findings' } }
      : { name: step, status: 'skipped', reason: 'An earlier step stopped verification.', evidence: [], summary: {} }));
  const [tests, coverage, mutation] = transport.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name));
  expect(tests.status).toBe(name === 'req:trace' ? 'ok' : 'skipped');
  expect(tests.evidence).toHaveLength(name === 'req:trace' ? 2 : 0);
  if (name === 'req:trace') expect(readFileSync(join(dir, tests.evidence[0].snapshot), 'utf8')).toBe('<testsuites/>');
  for (const result of [coverage, mutation]) expect(result).toEqual({ name: result.name,
    status: 'skipped', reason: 'Disabled in the rulebook.', evidence: [], summary: {} });
  expect(runCheck).not.toHaveBeenCalled();
});
