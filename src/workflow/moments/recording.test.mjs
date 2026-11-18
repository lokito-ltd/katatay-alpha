import { readBaseline } from '../phase.mjs';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSnapshot } from '../local-snapshot.mjs';
import { verificationInputs, verified as verifiedPayload, approval } from '../../../tests/fixtures/workflow/events.mjs';
import { onTurnEnd } from './turn-end.mjs';
import { readMutationSnapshot } from '../mutation-snapshot.mjs';
import { findingsOf } from '../../evidence/mutation-report.mjs';
import { mutant as reportMutant, reportOf } from '../../../tests/fixtures/workflow/mutation-report.mjs';
import { append } from '../chain.mjs';
import { current } from '../state.mjs';
import { provedOnServer } from '../baseline.mjs';
import { gitText } from '../git.mjs';
import { MUTATION_SWITCHED_OFF, readChecks, readMutation, analysisRequired, rulebookFingerprint } from '../rulebook.mjs';
import { readCoverageSnapshot } from '../coverage-snapshot.mjs';
import { coverageSummary, mutationSummary } from '../../../tests/fixtures/workflow/quality-results.mjs';
import { validateVerificationEvidence } from '../verification-results.mjs';
import { renderAreas } from '../areas.mjs';
import { agentWarnings } from '../agent.mjs';
import { changedFiles } from '../frozen.mjs';

vi.mock('../coverage-snapshot.mjs', () => ({ readCoverageSnapshot: vi.fn() }));
vi.mock('../mutation-snapshot.mjs', () => ({ readMutationSnapshot: vi.fn() }));
vi.mock('../state.mjs', () => ({ current: vi.fn(), followTarget: () => false }));
vi.mock('../chain.mjs', { spy: true });
vi.mock('../git.mjs', { spy: true });
vi.mock('../baseline.mjs', () => ({ provedOnServer: vi.fn() }));
vi.mock('../frozen.mjs', () => ({ branchChanges: () => ({ added: [] }), reviewSuppressions: () => ({}),
  changedFiles: vi.fn(() => []), implementationChanges: vi.fn(files => files) }));
vi.mock('../areas.mjs', () => ({ reviewAreas: () => ({}), renderAreas: vi.fn(() => []) }));
vi.mock('../rulebook.mjs', { spy: true });
vi.mock('../verification-results.mjs', { spy: true });
vi.mock('../agent.mjs', () => ({ agentWarnings: vi.fn(() => []) }));

let state, referee;
const reports = [{ name: 'reports/junit/run.xml', snapshot: '.katatay/local/topic/junit/run.xml' }];
const end = (stopRefusedBefore = false) => onTurnEnd({ stopRefusedBefore, secondsLeft: 60 }, { referee });
beforeEach(() => {
  vi.clearAllMocks();
  rulebookFingerprint.mockReturnValue(verificationInputs.rulebookFingerprint);
  readCoverageSnapshot.mockReturnValue({ touched: null });
  append.mockImplementation((dir, event, payload) => ({ seq: 3, event, payload }));
  gitText.mockReturnValue('');
  provedOnServer.mockReturnValue({ ok: true });
  readMutation.mockReturnValue(null);
  readMutationSnapshot.mockImplementation((branch, references) => {
    if (branch !== 'topic' || JSON.stringify(references) !== JSON.stringify(mutationSnapshots)) throw Error('No mutation snapshots were recorded');
    return savedMutation;
  });
  state = { ...verificationInputs, dir: 'log', branch: 'topic', phase: 'declared', treeFingerprint: 'tree', target: { name: 'origin/main' },
    testFingerprint: 'tests', implementationFingerprint: 'code', triage: { seq: 2, payload: { implementationFingerprint: 'code' } },
    grant: { payload: {} }, live: [{ seq: 1, event: 'plan_approved', payload: approval() }], entries: [], baselines: ['base'], changeDigest: 'digest', changeFiles: ['change.md'] };
  current.mockReturnValue(state);
  referee = vi.fn(() => ({ status: 0 }));
});
it.each([
  [{ ok: false, reason: 'unreachable' }, 'info', false],
  [{ ok: false, tip: 'tip', shas: ['missing'] }, 'stop', true],
])('cannot record without server proof: %j', (proof, code, keepWorking) => {
  provedOnServer.mockReturnValue(proof);
  expect(end()).toMatchObject({ keepWorking, messages: [{ code }] });
  expect(referee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(gitText).not.toHaveBeenCalled();
});
it('keeps a change declared when its guard fails', () => {
  referee.mockReturnValue({ status: 1, stderr: 'summary mismatch' });
  expect(end()).toMatchObject({ keepWorking: true, messages: [{ code: 'change_file', text: expect.stringContaining('summary mismatch') }] });
  expect(referee.mock.calls[0][1]).toEqual(['--record']);
  expect(append).not.toHaveBeenCalled();
  expect(gitText).not.toHaveBeenCalled();
});
it.each([false, true])('stages the recorded event before requesting the commit message (prior refusal: %s)', refused => {
  const result = end(refused);
  expect(append).toHaveBeenCalledWith('log', 'recorded', { treeFingerprint: 'tree', changes: 'digest', files: ['change.md'] }, 'topic', state.entries.length);
  expect(gitText).toHaveBeenCalledWith(['add', '-A']);
  expect(append).toHaveBeenCalledBefore(gitText);
  expect(result).toMatchObject({ keepWorking: !refused, messages: [{ code: 'recorded', for: refused ? 'operator' : 'agent' }] });
});
// The agent was asked to show the change summary at `record`, and once showed
// only its title. So recording carries it again, from the `declared` event.
it.each([false, true])('carries the declared change summary with the recorded message (prior refusal: %s)', refused => {
  state.declaration = { seq: 5, event: 'declared', payload: { treeFingerprint: 'tree', summary: ['risk LOW', 'tests: 1 added'] } };
  const [{ text }] = end(refused).messages;
  expect(text).toContain('Change declared on this tree. This is the report recorded with that decision.');
  expect(text).toContain('risk LOW\ntests: 1 added');
  expect(text).toContain('Details: log/0005__declared.json');
  expect(text).toMatch(refused
    ? /Type `record` to have the agent write the commit message\. Nothing is committed without your yes\.$/
    : /^Recorded by change\.md[\s\S]*If this change summary is not already in the chat, show it to the operator verbatim:[\s\S]*Write the commit message now/);
});
it('records without a summary when no declaration is on the state', () => {
  const [{ text }] = end(true).messages;
  expect(text).toBe('Recorded by change.md. The merge is the operator\'s.\n\n'
    + 'Every file is staged, the `recorded` event included. Type `record` to have the agent write the commit message. Nothing is committed without your yes.');
});
it('tells the operator when staging failed after recording', () => {
  gitText.mockImplementationOnce(() => { throw Object.assign(Error('git'), { stderr: 'index locked' }); });
  expect(end()).toMatchObject({ messages: [{ code: 'stop', text: expect.stringContaining('index locked') }] });
  expect(append).toHaveBeenCalledOnce();
});

/** A verify that exits 0 and writes these unified results, or no file content
 * the turn end could read them from when `results` is undefined. */
function verifying(results) {
  state.phase = 'converging';
  referee.mockImplementation((_, args) => {
    writeFileSync(args[1], JSON.stringify(results === undefined ? {} : { results }));
    return { status: 0 };
  });
}
const mutationSnapshots = { raw: 'raw mutation snapshot', findings: 'mutation findings snapshot' };
const savedMutation = { status: 1, outcome: 'survived', report: 'original report', findings: findingsOf(reportOf([reportMutant('Survived')])) };

it('appends only the receipt on a pass: the tree, the fingerprints and the unified results', () => {
  const checks = competingChecks();
  verifying(checks);
  expect(end().messages[0].code).toBe('verified');
  expect(append.mock.calls.map(call => call[1])).toEqual(['verified']);
  expect(append.mock.calls[0][2]).toEqual({ ...verificationInputs, treeFingerprint: 'tree', results: checks, testFingerprint: 'tests', implementationFingerprint: 'code' });
});

it('records the unreadable starting rulebook as null even when the verifier exits successfully', () => {
  state.rulebookFingerprint = null;
  verifying(competingChecks());
  expect(end().messages[0].code).toBe('verify_failed');
  expect(append.mock.calls.map(call => call[1])).toEqual(['verify_failed']);
  expect(append.mock.calls[0][2]).toMatchObject({ baseline: verificationInputs.baseline, rulebookFingerprint: null,
    tail: 'The rulebook could not be read at the start of verification.' });
});

// The unified results are a pass's only evidence. A verify that wrote the old
// transport, or nothing readable, measured nothing a receipt could vouch for.
it.each([
  ['the old transport', JSON.stringify({ checks: [], steps: [], junitReports: reports })],
  ['an empty object', '{}'],
  ['unreadable JSON', 'not JSON'],
])('refuses a successful exit that supplies %s instead of check results', (_, written) => {
  state.phase = 'converging';
  referee.mockImplementation((__, args) => {
    writeFileSync(args[1], written);
    return { status: 0 };
  });
  expect(end().messages[0]).toMatchObject({ code: 'verify_failed', text: expect.stringContaining('verify returned no check results') });
  expect(append.mock.calls.map(call => call[1])).toEqual(['verify_failed']);
  expect(append.mock.calls[0][2]).toEqual({ ...verificationInputs, treeFingerprint: 'tree', tail: 'verify returned no check results', results: unavailableResults() });
});

it.each([
  [['verified', 'checks_analysis'], true],
  [['verified'], true],
  [['convergence_requested'], true],
  [['verified', 'verify_failed', 'checks_analysis'], false],
])('relays a new failure after these logbook events: %j', (history, shouldContinue) => {
  state.phase = 'converging';
  state.entries = history.map(event => ({ event }));
  referee.mockReturnValue({ status: 1, stderr: 'A test failed.' });
  const result = end(true);
  expect(result).toMatchObject({ keepWorking: shouldContinue, messages: [
    { code: 'verify_failed', for: 'operator', text: expect.stringContaining('A test failed.') },
    { code: 'info', for: 'agent', text: expect.stringContaining('A test failed.') }] });
  // No triage was fresh here, so nothing stands in its place.
  expect(result.messages.every(Boolean)).toBe(true);
});

it('withholds a passing receipt when tests change while verify runs', () => {
  verifying(competingChecks());
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, testFingerprint: 'new tests' });
  expect(end().messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('changed during verify') });
  expect(append).not.toHaveBeenCalled();
});

it('detects a baseline move while validating the evidence for a pass', () => {
  verifying(competingChecks());
  validateVerificationEvidence.mockImplementationOnce(() => {
    current.mockReturnValue({ ...state, baseline: 'd'.repeat(40) });
  });
  expect(end().messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('The baseline changed during verify') });
  expect(append).not.toHaveBeenCalled();
});

it('identifies a rulebook lost before the final state read', () => {
  verifying(competingChecks());
  current.mockReturnValueOnce(state).mockImplementationOnce(() => { throw Error('no rulebook'); });
  rulebookFingerprint.mockReturnValueOnce(null);
  expect(end().messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('The rulebook changed during verify') });
  expect(append).not.toHaveBeenCalled();
});

it('does not record or stage a change file edited during the guard', () => {
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, changeDigest: 'changed' });
  expect(end().messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('changed during the guard') });
  expect(append).not.toHaveBeenCalled();
  expect(gitText).not.toHaveBeenCalled();
});

it('withholds recording if the declaration disappears during the guard on identical bytes', () => {
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, phase: 'verified' });
  expect(end().messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('during the guard') });
  expect(append).not.toHaveBeenCalled();
  expect(gitText).not.toHaveBeenCalled();
});

it.each([
  [{ stderr: 'compile failed' }, false, 'compile failed'],
  [{ stdout: 'tests failed' }, true, 'tests failed'],
  [{ stdout: 'check output\n', stderr: 'build failed' }, true, 'check output\nbuild failed'],
])('retains exactly the available diagnostic and evidence after a failed exit: %j', (streams, captured, tail) => {
  state.phase = 'converging';
  const checks = competingChecks();
  checks[0] = { name: 'compile', status: 'failed', reason: 'Compiler failed.', evidence: [], summary: { outcome: 'findings' } };
  referee.mockImplementation((_, args) => {
    if (captured) writeFileSync(args[1], JSON.stringify({ results: checks }));
    return { status: 1, ...streams };
  });
  end();
  const [[, event, payload]] = append.mock.calls;
  expect(event).toBe('verify_failed');
  expect(payload.tail).toBe(tail);
  if (captured) expect(payload.results).toEqual(checks);
  else expect(payload).not.toHaveProperty('checks');
});

it('keeps the process-start error when verify produced neither output nor results', () => {
  state.phase = 'converging';
  referee.mockReturnValue({ status: null, error: Error('Verify executable could not start.') });
  expect(end().messages[0]).toMatchObject({ code: 'verify_failed',
    text: expect.stringContaining('Verify executable could not start.') });
  expect(append.mock.calls[0][1]).toBe('verify_failed');
  expect(append.mock.calls[0][2].tail).toContain('Verify executable could not start.');
  expect(append.mock.calls[0][2].results).toEqual(unavailableResults());
  expect(append.mock.calls[0][2]).not.toHaveProperty('checks');
});

const unavailableResults = () => ['tests', 'coverage', 'mutation'].map(name => ({ name, status: 'skipped',
  reason: 'Verify supplied no usable results.', evidence: [], summary: {} }));
const competingChecks = () => [{ name: 'compile', status: 'ok', evidence: [], summary: { outcome: 'clean' } },
  ...['tests', 'coverage', 'mutation'].map(name => ({ name, status: 'skipped', reason: 'Not measured by this stub.', evidence: [], summary: {} }))];

it.each([0, 1])('records required omissions for every unusable result transport when verify exits %s', status => {
  state.phase = 'converging';
  for (const written of [undefined, '{}', 'not JSON', JSON.stringify({ results: null }),
    JSON.stringify({ results: [] }), JSON.stringify({ results: competingChecks().slice(0, 2) }),
    JSON.stringify({ results: { results: [], testQualityResults: competingChecks().slice(1) } })]) {
    referee.mockImplementation((_, args) => {
      if (written !== undefined) writeFileSync(args[1], written);
      return { status, stderr: 'Verifier exited before completing.' };
    });
    const outcome = end();
    expect(outcome.messages[0].code).toBe('verify_failed');
    const [, event, payload] = append.mock.calls.at(-1);
    expect(event).toBe('verify_failed');
    expect(payload.results).toEqual(unavailableResults());
    expect(payload).not.toHaveProperty('checks');
    if (status !== 0) expect(payload.tail).toContain('Verifier exited before completing.');
    else expect(payload.tail).toMatch(/verify returned (no check results|unusable check evidence)/);
  }
});

it.each([true, false])('keeps the unified results whether or not the analysis is on (%s)', enabled => {
  analysisRequired.mockReturnValueOnce(enabled);
  const checks = competingChecks();
  verifying(checks);
  const messages = end().messages;
  expect(messages[0].code).toBe('verified');
  expect(append.mock.calls[0][2]).toEqual({ ...verificationInputs, treeFingerprint: 'tree', results: checks, testFingerprint: 'tests', implementationFingerprint: 'code' });
  expect(messages.some(m => m.code === 'info' && m.for === 'agent')).toBe(enabled);
});

it('refuses a successful exit carrying a failed result', () => {
  const checks = competingChecks();
  checks[0] = { name: 'compile', status: 'failed', reason: 'Compiler broke.', evidence: [], summary: {} };
  verifying(checks);
  expect(end().messages[0].code).toBe('verify_failed');
  expect(append.mock.calls[0][1]).toBe('verify_failed');
  expect(append.mock.calls[0][2].tail).toContain('successful verify contains a failed result');
});

it('refuses a malformed results envelope, and keeps it off the failure', () => {
  verifying([]);
  expect(end().messages[0].code).toBe('verify_failed');
  const payload = append.mock.calls[0][2];
  expect(payload.tail).toContain('tests, coverage and mutation');
  expect(payload.results).toEqual(unavailableResults());
  expect(payload).not.toHaveProperty('checks');
});

it('rejects verification transport carrying only the retired list', () => {
  verifying({ results: [], testQualityResults: competingChecks().slice(1) });
  expect(end().messages[0].code).toBe('verify_failed');
  const payload = append.mock.calls[0][2];
  expect(payload.tail).toContain('results must be a list');
  expect(payload.results).toEqual(unavailableResults());
  expect(payload).not.toHaveProperty('checks');
});

it('marks the canonical test result failed when its evidence fails validation', () => {
  verifying(competingChecks());
  validateVerificationEvidence.mockImplementationOnce(() => {
    throw Object.assign(Error('Test evidence was lost.'), { resultName: 'tests' });
  });
  expect(end().messages[0].code).toBe('verify_failed');
  const saved = append.mock.calls[0][2].results;
  expect(saved.find(item => item.name === 'tests')).toMatchObject({ name: 'tests', status: 'failed', summary: { diagnostics: 'Test evidence was lost.' } });
  expect(saved).not.toHaveProperty('qualityResults');
});

it('marks a result failed when its snapshot disappears before the receipt is recorded', () => {
  const checks = competingChecks();
  checks[0].evidence = [{ role: 'raw', title: 'Compiler output',
    snapshot: `.katatay/local/topic/checks/raw/20261104T120000.000Z_${'A'.repeat(43)}.txt` }];
  const earlier = { name: 'req:lint', status: 'ok', evidence: [], summary: { outcome: 'clean' } };
  checks.unshift(earlier);
  verifying(checks);
  expect(end().messages[0].code).toBe('verify_failed');
  expect(append.mock.calls[0][2].results[0]).toEqual(earlier);
  const result = append.mock.calls[0][2].results[1];
  expect(result).toMatchObject({ status: 'failed', reason: 'Verification evidence could not be validated.',
    summary: { outcome: 'clean', diagnostics: expect.stringContaining('ENOENT') } });
});

it('accepts reuse from the immediately preceding verification and validates it against the next sequence', () => {
  state.entries = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  const checks = competingChecks();
  Object.assign(checks[0], { status: 'reused', reason: 'Runs once per plan.', source: { seq: 3, fingerprint: 'a'.repeat(64) } });
  // Source-file integrity is covered by verification-results tests. Here the
  // boundary being proved is the hook's next-event sequence, including +1.
  // The analysis report reads the reused source too, so it is switched off.
  validateVerificationEvidence.mockImplementationOnce(() => {});
  analysisRequired.mockReturnValueOnce(false);
  verifying(checks);
  expect(end().messages[0].code).toBe('verified');
  expect(validateVerificationEvidence).toHaveBeenCalledWith(checks, expect.objectContaining({ before: 4 }));
  expect(append.mock.calls[0][2].results[0].source.seq).toBe(3);
});

it('builds the verified summary and the analysis request from the unified results', () => {
  readMutation.mockReturnValue({});
  readChecks.mockReturnValue({ testQuality: [
    { name: 'mutation', chain: 'testQuality', runs: 'oncePerPlan', onFailure: 'report' },
    { name: 'audit', chain: 'testQuality', runs: 'oncePerPlan', onFailure: 'report' },
  ], codeQuality: [] });
  const kept = name => `.katatay/local/topic/mutation/${name}/20261104T120000.000Z_${'A'.repeat(43)}.json`;
  const references = { raw: kept('raw'), findings: kept('findings') };
  readMutationSnapshot.mockImplementation((branch, refs) => {
    if (branch !== 'topic' || JSON.stringify(refs) !== JSON.stringify(references)) throw Error('unexpected mutation snapshots');
    return savedMutation;
  });
  const checks = competingChecks();
  checks.splice(0, 1, { name: 'audit', status: 'ok', reason: 'unified finding', evidence: [], summary: { outcome: 'findings', exitCode: 1 } });
  checks.find(item => item.name === 'coverage').reason = 'Coverage skipped by the unified results.';
  checks[checks.findIndex(item => item.name === 'mutation')] = { name: 'mutation', status: 'ok', reason: 'Measured.', evidence: [
    { role: 'raw', title: 'Raw mutation results', snapshot: references.raw },
    { role: 'analysis', title: 'Mutation findings and limitations', snapshot: references.findings },
  ], summary: mutationSummary(savedMutation.findings) };
  validateVerificationEvidence.mockImplementationOnce(() => {});
  verifying(checks);
  const [verified, request] = end().messages;
  expect(verified).toMatchObject({ code: 'verified', for: 'operator' });
  expect(verified.text).toContain('Findings:\naudit: FINDINGS\nunified finding\n\nmutation: FINDINGS\n1 survived · 0 killed · 1 mutants\nmodules/a.ts:1 EqualityOperator → a !== b');
  expect(verified.text).toContain('coverage: SKIPPED — Coverage skipped by the unified results.');
  expect(verified.text.endsWith('\n\nDetails: log/0003__verified.json')).toBe(true);
  expect(request).toMatchObject({ code: 'info', text: expect.stringContaining('Check audit') });
  expect(request.text).toContain('Mutants ');
  expect(request.text).toContain('payload.results and the snapshots its results name');
});

// The unified message path, against a real logbook and real snapshots in a
// temporary repository, so reuse validation and check text are read for real.
const nativeChain = await vi.importActual('../chain.mjs');
const rawCheck = { folder: 'checks/raw', extension: 'txt', label: 'check output' };
const snapshotAt = (folder, ext) => `.katatay/local/topic/${folder}/20261104T120000.000Z_${'A'.repeat(43)}.${ext}`;
const references = { raw: snapshotAt('mutation/raw', 'json'), findings: snapshotAt('mutation/findings', 'json') };
const mutationEvidence = [
  { role: 'raw', title: 'Raw mutation results', snapshot: references.raw },
  { role: 'analysis', title: 'Mutation findings and limitations', snapshot: references.findings },
];
const mutationOk = () => ({ name: 'mutation', status: 'ok', reason: 'Measured.', evidence: mutationEvidence, summary: mutationSummary(savedMutation.findings) });
function inRepository() {
  const root = mkdtempSync(join(tmpdir(), 'turn-end-unified-'));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  onTestFinished(() => { cwd.mockRestore(); rmSync(root, { recursive: true, force: true }); });
  readMutationSnapshot.mockImplementation((branch, refs) => {
    if (branch !== 'topic' || JSON.stringify(refs) !== JSON.stringify(references)) throw Error('unexpected mutation snapshots');
    return savedMutation;
  });
  const log = event => { state.live.push(event); state.entries.push(event); return event; };
  const add = (event, payload) => log(nativeChain.append(join(root, nativeChain.dirFor('topic')), event, payload, 'topic'));
  state.live = [];
  state.entries = [];
  add('plan_approved', approval());
  const text = value => publishSnapshot('topic', rawCheck, Buffer.from(value), root);
  const source = event => ({ seq: event.seq, fingerprint: nativeChain.sha256(readFileSync(join(root, nativeChain.dirFor('topic'), nativeChain.fileFor(event)))) });
  return { root, add, text, source };
}
/** A pass carrying unified results, whose evidence validation is covered elsewhere. */
function unifiedPass(checks, analysing = false) {
  analysisRequired.mockReturnValueOnce(analysing);
  validateVerificationEvidence.mockImplementationOnce(() => {});
  verifying(checks);
  return end();
}
const general = (name, status, outcome, reason, evidence = []) => ({ name, status, reason, evidence,
  summary: status === 'skipped' ? {} : { outcome } });
const rule = (name, chain, runs, onFailure) => ({ name, chain, runs, onFailure });

it('shows touched lines no test runs as coverage findings, read from the analysis snapshot', () => {
  readChecks.mockReturnValue({ testQuality: [rule('coverage', 'testQuality', 'everyVerify', 'block')], codeQuality: [] });
  const checks = competingChecks();
  const measurement = { folders: [{ folder: 'modules/', files: 1, lines: { covered: 1, total: 2, measured: 500, minimum: 0 },
    branches: { covered: 0, total: 0, measured: 1000, minimum: 0 } }], failures: [], touched: { covered: 0, total: 3, uncovered: [{ file: 'a.mjs', lines: [2, 3, 7] }] } };
  readCoverageSnapshot.mockReturnValue(measurement);
  checks[checks.findIndex(item => item.name === 'coverage')] = { name: 'coverage', status: 'ok', reason: 'Measured.', summary: coverageSummary(measurement), evidence: [
    { role: 'raw', title: 'Raw LCOV coverage', snapshot: snapshotAt('coverage', 'lcov') },
    { role: 'analysis', title: 'Coverage thresholds and changed lines', snapshot: snapshotAt('coverage', 'json') }] };
  const [verified] = unifiedPass(checks).messages;
  expect(readCoverageSnapshot).toHaveBeenCalledWith('topic', { raw: snapshotAt('coverage', 'lcov'), analysis: snapshotAt('coverage', 'json') }, readBaseline(approval().baseline), expect.any(String));
  expect(verified.text).toContain('Findings:\ncoverage: FINDINGS\n3 / 3 touched lines run by no test\na.mjs: 2-3, 7\n');
});

it.each([
  ['switched off in the rulebook', 'not checked: mutation (checks.testQuality.mutation is "none")'],
  ['deferred', 'Mutation testing deferred: not enough time.'],
])('shows a mutation result that is %s as skipped, by its reason, reading no snapshot', (_, reason) => {
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  const checks = competingChecks();
  checks[checks.findIndex(item => item.name === 'mutation')] = { name: 'mutation', status: 'skipped', reason, evidence: [], summary: {} };
  const [verified] = unifiedPass(checks).messages;
  expect(verified.code).toBe('verified');
  // A long reason wraps; the words are what matter here.
  expect(verified.text.replace(/\n(?!\n)/g, ' ')).toContain(`mutation: SKIPPED — ${reason}`);
  expect(readMutationSnapshot).not.toHaveBeenCalled();
});

it('shows a fresh mutation run as findings, and a reused one as stale, with how to run it again', () => {
  const { add, source } = inRepository();
  readMutation.mockReturnValue({});
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  const fresh = competingChecks();
  fresh[fresh.findIndex(item => item.name === 'mutation')] = mutationOk();
  const first = unifiedPass(fresh).messages[0];
  expect(first.text).toContain('mutation: FINDINGS\n1 survived');
  expect(first.text).not.toContain('REUSED');

  const original = add('verified', verifiedPayload({ treeFingerprint: 'a'.repeat(64), results: fresh }));
  const reusing = competingChecks();
  reusing[reusing.findIndex(item => item.name === 'mutation')] = { ...mutationOk(), status: 'reused', reason: 'Runs once per approved plan.', source: source(original) };
  add('verified', verifiedPayload({ treeFingerprint: 'b'.repeat(64), results: reusing }));
  const later = unifiedPass(reusing).messages[0];
  expect(later.code).toBe('verified');
  expect(later.text).toContain(`Reused:\nmutation: REUSED\nStale: these results are from verified #${original.seq}, on an earlier tree, and were not\nmeasured again.\n`
    + 'Run it again on its own: `workflow mutate`.\n1 survived · 0 killed · 1 mutants\nmodules/a.ts:1 EqualityOperator → a !== b');
  expect(later.text).not.toContain('Findings:');
});

it('lists a reporting check with findings by what it printed, and every other check as passed or skipped', () => {
  const { text } = inRepository();
  readChecks.mockReturnValue({
    testQuality: [rule('audit', 'testQuality', 'oncePerPlan', 'report'), rule('style', 'testQuality', 'everyVerify', 'report'),
      rule('gate', 'testQuality', 'everyVerify', 'block'), rule('ci', 'testQuality', 'oncePerPlan', 'block')],
    codeQuality: [rule('lint', 'codeQuality', 'everyVerify', 'report')],
  });
  const checks = competingChecks();
  checks.splice(0, 1,
    general('audit', 'ok', 'findings', 'one finding', [{ role: 'raw', title: 'audit output', snapshot: text('unused x\n\nunused y') }]),
    general('style', 'ok', 'clean', 'clean', [{ role: 'raw', title: 'style output', snapshot: text('noise') }]),
    general('gate', 'ok', 'clean', 'clean'),
    general('ci', 'skipped', null, 'skipped in CI'),
    general('lint', 'ok', 'findings', 'one lint finding', [{ role: 'raw', title: 'lint output', snapshot: text('lint x') }]),
  );
  const [verified] = unifiedPass(checks).messages;
  expect(verified.text).toBe([
    'Verification passed.',
    '',
    'Findings:',
    'audit: FINDINGS', 'one finding', 'unused x', 'unused y',
    '',
    'lint: FINDINGS', 'one lint finding', 'lint x',
    '',
    'Skipped:',
    'ci: SKIPPED — skipped in CI',
    'tests: SKIPPED — Not measured by this stub.',
    'coverage: SKIPPED — Not measured by this stub.',
    'mutation: SKIPPED — Not measured by this stub.',
    '',
    'Passed:',
    'style: PASSED',
    'gate: PASSED',
    '',
    'Details: log/0003__verified.json',
  ].join('\n'));
});

it('repeats a reused check as stale, with its results and the command that runs it again', () => {
  const { add, text, source } = inRepository();
  readChecks.mockReturnValue({ testQuality: [{ ...rule('audit', 'testQuality', 'oncePerPlan', 'report'), command: 'npm run audit' }], codeQuality: [] });
  const evidence = [{ role: 'raw', title: 'audit output', snapshot: text('unused x') }];
  const produced = competingChecks();
  produced.splice(0, 1, general('audit', 'ok', 'findings', 'two findings', evidence));
  const original = add('verified', verifiedPayload({ treeFingerprint: 'a'.repeat(64), results: produced }));
  add('checks_analysis', { verification: original.seq, summary: 'Analysis.',
    analysisSnapshot: `.katatay/local/topic/checks-analysis/20261105T000000.000Z_${'a'.repeat(43)}.txt` });
  const checks = competingChecks();
  checks.splice(0, 1, { ...general('audit', 'reused', 'findings', 'Runs once per approved plan.', evidence), source: source(original) });
  const [verified, request] = unifiedPass(checks, true).messages;
  expect(verified.code).toBe('verified');
  expect(verified.text).toContain(`Reused:\naudit: REUSED\nStale: these results are from verified #${original.seq}, on an earlier tree, and were not\nmeasured again.\n`
    + 'Run it again on its own: `npm run audit`.\n');
  // The producer's reason, not the reuse reason, which the stale line already says.
  expect(verified.text).toContain('`npm run audit`.\ntwo findings\nunused x\n');
  expect(verified.text).not.toContain('Runs once per approved plan.');
  expect(request.text).toContain('Limit audit [reused]');
});

it('fails the pass when evidence the summary reads cannot be read, before any receipt, and names verify as what failed', () => {
  readMutation.mockReturnValue({});
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  readMutationSnapshot.mockImplementation(() => { throw Error('the mutation snapshot is gone'); });
  const checks = competingChecks();
  checks[checks.findIndex(item => item.name === 'mutation')] = mutationOk();
  const [failed, note] = unifiedPass(checks).messages;
  expect(failed).toMatchObject({ code: 'verify_failed', for: 'operator' });
  expect(failed.text).toContain('Failures:\nverify: FAILED\nNo check failed: verify itself did.\nverify returned unusable check evidence: the mutation snapshot is gone');
  expect(note).toMatchObject({ code: 'info', for: 'agent', text: expect.stringContaining('the mutation snapshot is gone') });
  expect(append.mock.calls.map(call => call[1])).toEqual(['verify_failed']);
  expect(append.mock.calls[0][2]).toMatchObject({ results: checks, tail: expect.stringContaining('unusable check evidence') });
});

it('puts the review areas, settings warnings and a test-only plan\'s other files in the summary', () => {
  renderAreas.mockReturnValueOnce(['Must look:', '  Guarded. Read them whatever the tests say.', '  - guarded/check.mjs']);
  agentWarnings.mockReturnValueOnce(['a hook can approve plans.']);
  state.grant = { payload: { testOnly: true } };
  changedFiles.mockReturnValueOnce(['feature.mjs']);
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  const [verified] = unifiedPass(competingChecks()).messages;
  expect(verified.text).toContain('\n\nWarnings:\nThe plan declared this change test-only, and these are not tests:\nfeature.mjs\n\nsettings: a hook can approve plans.\n\n'
    + 'Review:\nGuarded. Read them whatever the tests say.\n- guarded/check.mjs\n\n');
});

it('fails the pass before any receipt when the coverage analysis cannot be read', () => {
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  readCoverageSnapshot.mockImplementation(() => { throw Error('the coverage analysis is gone'); });
  const checks = competingChecks();
  const measurement = { folders: [{ folder: 'modules/', files: 1, lines: { covered: 1, total: 1, measured: 1000, minimum: 0 },
    branches: { covered: 0, total: 0, measured: 1000, minimum: 0 } }], failures: [], touched: null };
  checks[checks.findIndex(item => item.name === 'coverage')] = { name: 'coverage', status: 'ok', reason: 'Measured.', summary: coverageSummary(measurement), evidence: [
    { role: 'raw', title: 'Raw LCOV coverage', snapshot: snapshotAt('coverage', 'lcov') },
    { role: 'analysis', title: 'Coverage thresholds and changed lines', snapshot: snapshotAt('coverage', 'json') }] };
  const [failed] = unifiedPass(checks).messages;
  expect(failed).toMatchObject({ code: 'verify_failed', text: expect.stringContaining('the coverage analysis is gone') });
  expect(append.mock.calls.map(call => call[1])).toEqual(['verify_failed']);
});

it('takes only the list\'s own two-space indent off the review lines, and adds no empty sections', () => {
  readChecks.mockReturnValue({ testQuality: [], codeQuality: [] });
  const [plain] = unifiedPass(competingChecks()).messages;
  expect(plain.text).not.toContain('Warnings:');
  expect(plain.text).not.toContain('Review:');
  renderAreas.mockReturnValueOnce(['Must look:', '  A reason.', '    - nested/file.mjs', 'Kept  as is.']);
  const [verified] = unifiedPass(competingChecks()).messages;
  expect(verified.text).toContain('\n\nReview:\nA reason.\n  - nested/file.mjs\nKept  as is.\n\n');
});
