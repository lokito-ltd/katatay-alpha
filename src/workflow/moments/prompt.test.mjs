import { verified } from '../../../tests/fixtures/workflow/events.mjs';
import { writeConfig } from '../../../tests/fixtures/workflow/adapter.mjs';
import { inRoot } from '../check-output.mjs';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedAnalysis } from '../checks-analysis.mjs';
import { changeReports, checksAnalyses, publishSnapshot, readSnapshot } from '../local-snapshot.mjs';
import { onPrompt } from './prompt.mjs';
import { append } from '../chain.mjs';
import { current, followTarget } from '../state.mjs';
import { runReferee } from '../runtime.mjs';
import { reportFor } from '../checks-report.mjs';

vi.mock('../chain.mjs', { spy: true });
vi.mock('../state.mjs', () => ({ current: vi.fn(), followTarget: vi.fn(), summarise: s => s.phase }));
vi.mock('../runtime.mjs', () => ({ runReferee: vi.fn() }));
vi.mock('../agent.mjs', () => ({ setupMessages: () => [] }));
// Saved analyses are read from a temporary folder, through the real code.
vi.mock('../local-snapshot.mjs', { spy: true });
const snapshots = await vi.importActual('../local-snapshot.mjs');
// The report is built from the receipt's results, which checks-report tests
// cover. Here it is the one the receipt's verification would give.
vi.mock('../checks-report.mjs', () => ({ reportFor: vi.fn() }));

const event = (event, treeFingerprint) => ({ event, payload: event === 'verified' ? verified({ treeFingerprint }) : { treeFingerprint } });
let state;
let root;
beforeEach(() => {
  vi.resetAllMocks();
  append.mockImplementation(() => {});
  // Change reports are written to a temporary folder, never the repository's.
  root = mkdtempSync(join(tmpdir(), 'prompt-report-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  publishSnapshot.mockImplementation((branch, kind, bytes) => snapshots.publishSnapshot(branch, kind, bytes, root));
  state = { branch: 'topic', dir: 'log', phase: 'verified', ...verified({ treeFingerprint: 'now' }), live: [event('plan_approved'), { ...event('verified', 'now'), seq: 3 },
    { event: 'checks_analysis', seq: 4, payload: { verification: 3, summary: 'Accepted summary',
      analysisSnapshot: `.katatay/local/topic/checks-analysis/20261105T000000.000Z_${'a'.repeat(43)}.txt` } }] };
  state.entries = state.live;
  current.mockReturnValue(state);
});
it.each(['reset', 'record'])('refuses %s on a broken chain without recording anything', prompt => {
  state.broken = 'bad link';
  expect(onPrompt({ prompt }).messages[0]).toMatchObject({ code: 'stop', text: expect.stringContaining('bad link') });
  expect(append).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});
// A missing recorded change file is the one breakage a reset mends: it
// abandons the change epoch the `recorded` event belongs to.
it('records a reset into a logbook broken only by a missing change file', () => {
  Object.assign(state, { broken: 'gone', resetRepairs: true, changeFiles: [], earlierChangeFiles: [] });
  expect(onPrompt({ prompt: 'reset' }).messages[0].code).toBe('reset');
  expect(append).toHaveBeenCalledWith('log', 'reset', { note: null }, 'topic');
});

it('names the change files on the branch in the reset, and tells the operator about them', () => {
  Object.assign(state, { changeFiles: ['requirements/changes/b.md'], earlierChangeFiles: ['requirements/changes/a.md'] });
  const [reset, info] = onPrompt({ prompt: 'reset: over' }).messages;
  expect(reset.code).toBe('reset');
  expect(append).toHaveBeenCalledWith('log', 'reset',
    { note: 'over', changeFiles: ['requirements/changes/a.md', 'requirements/changes/b.md'] }, 'topic');
  expect(info).toMatchObject({ code: 'info', for: 'operator' });
  expect(info.text).toContain('  requirements/changes/a.md\n  requirements/changes/b.md');
  expect(info.text).toMatch(/no longer count for the change/);
  expect(info.text).toContain('Delete any you do not want:\n\n');
});

it('names no change files in a reset when the branch has none', () => {
  Object.assign(state, { changeFiles: [], earlierChangeFiles: [] });
  expect(onPrompt({ prompt: 'reset' }).messages.map((m) => m.code)).toEqual(['reset', 'state']);
  expect(append).toHaveBeenCalledWith('log', 'reset', { note: null }, 'topic');
});

it('does not run a change report until the receipt matches this tree', () => {
  state.treeFingerprint = 'edited';
  expect(onPrompt({ prompt: 'record' }).messages[0].code).toBe('not_declared');
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('declares a verified tree without an analysis event when the rulebook turns the gate off', () => {
  writeConfig(root, { fields: { checks: { requireAnalysis: false, testQuality: { coverage: 'none', mutation: 'none' } } } });
  state.live.pop(); // Leave only the approval and its verification.
  const report = { lines: ['Change report'], summary: ['No gaps'], gaps: { uncoveredLines: 0, uncaughtMutants: 0 }, incomplete: [] };
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify(report) });
  const [reply] = inRoot(root, () => onPrompt({ prompt: 'record' })).messages;
  expect(reply.code).toBe('declared');
  expect(append).toHaveBeenCalledWith('log', 'declared', expect.objectContaining({
    treeFingerprint: 'now', summary: report.summary, gaps: report.gaps,
  }), 'topic', state.entries.length);
});
it.each([
  ['first record with gaps', [], 'record_held', 'held'],
  ['second record on the same tree', [event('record_held', 'now')], 'declared', 'declared'],
])('%s decides from the report for this tree', (_, past, entry, code) => {
  state.live.push(...past);
  const report = { lines: ['Change report'], summary: ['summary'], gaps: { uncoveredLines: 1, uncaughtMutants: 0 }, incomplete: [] };
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify(report) });
  const [said] = onPrompt({ prompt: 'record' }).messages;
  expect(said.code).toBe(code);
  const changeReportSnapshot = expect.stringMatching(/^\.katatay\/local\/topic\/change-report\//);
  expect(append).toHaveBeenCalledWith('log', entry, {
    treeFingerprint: 'now', note: null, gaps: report.gaps, ...(entry === 'declared' ? { summary: report.summary } : {}), changeReportSnapshot,
  }, 'topic', state.entries.length);
  // The reply links the event it appended, and the event names the full
  // report the decision was made on.
  const payload = append.mock.calls[0][2];
  expect(said.text).toContain(`\nDetails: log/${String(state.entries.length + 1).padStart(4, '0')}__${entry}.json\n`);
  const kept = JSON.parse(snapshots.readSnapshot('topic', changeReports, payload.changeReportSnapshot, root));
  expect(kept).toEqual({ version: 1, treeFingerprint: 'now', decision: entry, lines: report.lines, summary: report.summary, gaps: report.gaps });
});

it.each([
  { uncoveredLines: 2 },
  { uncaughtMutants: 3 },
  { uncoveredLines: 2, uncaughtMutants: 0 },
  { uncoveredLines: 0, uncaughtMutants: 3 },
])('keeps exactly the measured gap counts on a hold: %j', gaps => {
  const report = { lines: ['Change report'], summary: ['summary'], gaps, incomplete: [] };
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify(report) });
  expect(onPrompt({ prompt: 'record' }).messages[0].code).toBe('held');
  const [dir, event, payload, branch, length] = append.mock.calls[0];
  expect([dir, event, branch, length]).toEqual(['log', 'record_held', 'topic', state.entries.length]);
  expect(payload.gaps).toEqual(gaps);
  const kept = JSON.parse(snapshots.readSnapshot('topic', changeReports, payload.changeReportSnapshot, root));
  expect(kept.gaps).toEqual(gaps);
});
it('requests analysis for a new receipt before reading the report or counting a hold', () => {
  reportFor.mockReturnValue({ coverage: { status: 'complete', uncovered: [] }, mutation: { status: 'complete', survivors: [] }, checks: [] });
  state.live.push({ seq: 5, event: 'verified', payload: verified({ treeFingerprint: 'now' }) });
  const answer = onPrompt({ prompt: 'record' });
  expect(answer.messages[0]).toMatchObject({ code: 'not_declared', text: expect.stringContaining('Verification 5 needs its checks analysis') });
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});
// Lost evidence is said to the operator as lost, not as a state the hook
// could not read.
it('says a new receipt\'s evidence cannot be read, and declares nothing', () => {
  reportFor.mockImplementation(() => { throw new Error('the coverage evidence cannot be read: coverage analysis (x): SHA-256 digest mismatch'); });
  state.live.push({ seq: 5, event: 'verified', payload: verified({ treeFingerprint: 'now' }) });
  const [said] = onPrompt({ prompt: 'record' }).messages;
  expect(said).toMatchObject({ code: 'not_declared', for: 'operator' });
  expect(said.text).toBe('Verification 5 needs its checks analysis, but its evidence cannot be read: the coverage evidence cannot be read: '
    + 'coverage analysis (x): SHA-256 digest mismatch. Nothing was declared. Restore the files it names, and tell the operator.');
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});
it('refuses a failed report on every attempt, including after a previous quality hold', () => {
  runReferee.mockReturnValue({ status: 1, stderr: 'report failed' });
  for (let i = 0; i < 2; i++) {
    const answer = onPrompt({ prompt: 'record' }).messages[0];
    expect(answer).toMatchObject({ code: 'not_declared', text: expect.stringContaining('report failed') });
    state.live.push(event('record_held', 'now'));
  }
  expect(append).not.toHaveBeenCalled();
});
it('announces the old and new baseline and summarizes the state after a move', () => {
  current.mockReturnValueOnce({ ...state, baseline: 'old' }).mockReturnValueOnce({ ...state, baseline: 'new', phase: 'converging' });
  followTarget.mockReturnValue(true);
  expect(onPrompt({ prompt: 'ordinary prompt' }).messages).toMatchObject([
    { code: 'info', text: expect.stringContaining('from old to new') }, { code: 'state', text: 'converging' },
  ]);
});

it('sends the evidence, submission command and next operator action when a receipt lacks analysis', () => {
  state.live.pop();
  const coverage = { status: 'complete', uncovered: [{ file: 'orders.ts', line: 42 }] };
  const security = { chain: 'codeQuality', name: 'security', status: 'deferred', reason: 'Budget exhausted.' };
  reportFor.mockReturnValue({ coverage, mutation: { status: 'complete', survivors: [] }, checks: [security] });
  const message = onPrompt({ prompt: 'record' }).messages[0];
  expect(message).toMatchObject({ for: 'operator', code: 'not_declared' });
  for (const required of ['Coverage orders.ts:42', 'Limit security [deferred]', 'Budget exhausted.',
    'workflow checks-analysis 3', 'Wait for the operator to type `record` again']) expect(message.text).toContain(required);
  expect(reportFor).toHaveBeenCalledWith(state.live[1], state.live);
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it.each([
  ['uncovered lines', { status: 0, stdout: JSON.stringify({ lines: ['Coverage gap'], summary: ['Gap'],
    gaps: { uncoveredLines: 1, uncaughtMutants: 0 }, incomplete: [] }) }],
])('relays the accepted analysis\'s compact summary and its logbook location on a hold for %s', (_, run) => {
  const accepted = 'Summary: Remove the import.\nCheck lint\nFinding: Unused import.\nAction: Remove it and run lint.';
  const root = mkdtempSync(join(tmpdir(), 'prompt-analysis-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  readSnapshot.mockImplementation((branch, kind, reference) => snapshots.readSnapshot(branch, kind, reference, root));
  const receipt = state.live[1];
  receipt.payload.results = [{ name: 'lint', evidence: [{ role: 'raw', title: 'lint output', snapshot: 'lint.txt' }] }];
  state.live[2].payload.analysisSnapshot = snapshots.publishSnapshot('topic', checksAnalyses, savedAnalysis(accepted, receipt), root);
  runReferee.mockReturnValue(run);
  const message = onPrompt({ prompt: 'record' }).messages[0];
  expect(message).toMatchObject({ for: 'operator', code: 'held' });
  expect(message.text).toContain('If its summary is missing from this chat, show it verbatim:\n\n'
    + 'Agent\'s assessment for verification 3 checks results.\n\nRemove the import.\n\n'
    + 'Check findings answered: 1 (lint).\n\nFull analysis: log/0004__checks_analysis.json');
  // The full analysis and its evidence list stay in the file, out of what
  // the agent shows.
  expect(message.text).not.toContain('Finding: Unused import.');
  expect(message.text).not.toContain('lint.txt');
  expect(message.text).not.toContain(state.live[2].payload.analysisSnapshot);
  expect(message.text).toContain('`record` again');
});

it('shows the stored summary on a hold when the full analysis cannot be read, and still holds', () => {
  // An empty folder, so the case never depends on what the repository holds.
  const root = mkdtempSync(join(tmpdir(), 'prompt-analysis-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  readSnapshot.mockImplementation((branch, kind, reference) => snapshots.readSnapshot(branch, kind, reference, root));
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify({ lines: ['Coverage gap'], summary: ['Gap'],
    gaps: { uncoveredLines: 1, uncaughtMutants: 0 }, incomplete: [] }) });
  const message = onPrompt({ prompt: 'record' }).messages[0];
  expect(message).toMatchObject({ for: 'operator', code: 'held' });
  // A line is never wrapped, so the path stays on the line that names it.
  expect(message.text).toContain(`The full analysis cannot be read from ${state.live[2].payload.analysisSnapshot}: ENOENT`);
  expect(message.text).toContain('\n\nAccepted summary\n\nFull analysis: log/0004__checks_analysis.json');
  expect(append).toHaveBeenCalledWith('log', 'record_held', expect.anything(), 'topic', expect.any(Number));
});

it('refuses a declaration if tests change while the report runs', () => {
  const split = { implementationFingerprint: 'code', testFingerprint: 'tests' };
  Object.assign(state, split);
  Object.assign(state.live[1].payload, split);
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, treeFingerprint: 'edited', testFingerprint: 'new tests' });
  const report = { lines: ['Change report'], summary: ['summary'], gaps: { uncoveredLines: 0, uncaughtMutants: 0 }, incomplete: [] };
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify(report) });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({ code: 'not_declared', text: expect.stringContaining('Verify the edited tests') });
  expect(append).not.toHaveBeenCalled();
});

it('tells the operator a revision is pending when its request arrives while the change report runs', () => {
  const request = { event: 'replan_requested', seq: 5, payload: { approval: 1 } };
  const events = [...state.live, request];
  runReferee.mockImplementation(() => {
    current.mockReturnValue({ ...state, live: events, entries: events, replan: request });
    const report = { lines: ['Change report'], summary: ['No gaps'], gaps: { uncoveredLines: 0, uncaughtMutants: 0 }, incomplete: [] };
    return { status: 0, stdout: JSON.stringify(report) };
  });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({
    for: 'operator', code: 'not_declared', text: expect.stringContaining('A plan revision is pending'),
  });
  expect(append).not.toHaveBeenCalled();
});

it('requires another record when a new receipt supersedes the one used to build the report', () => {
  const newer = { ...state.live[1], seq: 6 };
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, live: [...state.live, newer] });
  const report = { lines: ['Change report'], summary: ['summary'], gaps: { uncoveredLines: 0, uncaughtMutants: 0 }, incomplete: [] };
  runReferee.mockReturnValue({ status: 0, stdout: JSON.stringify(report) });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({
    code: 'not_declared', text: expect.stringContaining('verification changed while the report ran'),
  });
  expect(append).not.toHaveBeenCalled();
});

it('identifies implementation drift from the latest verified receipt', () => {
  Object.assign(state.live[1].payload, { implementationFingerprint: 'original', testFingerprint: 'tests' });
  Object.assign(state, { treeFingerprint: 'edited', implementationFingerprint: 'edited code', testFingerprint: 'tests' });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({
    code: 'not_declared', text: expect.stringContaining('implementation changed since the latest successful verification'),
  });
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('declines record when the receipt disappears while the report runs', () => {
  const after = { ...state, phase: 'converging', live: [state.live[0]] };
  current.mockReturnValueOnce(state).mockReturnValue(after);
  runReferee.mockReturnValue({ status: 1, stderr: 'report unavailable' });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({
    code: 'not_declared', text: expect.stringContaining('only a verified working tree'),
  });
  expect(append).not.toHaveBeenCalled();
});

it('returns the triage recovery action even before a first successful verify', () => {
  state.live = [state.live[0]];
  state.drift = true;
  state.why = 'Restore the triaged implementation or approve a revised plan.';
  expect(onPrompt({ prompt: 'record' }).messages[0]).toMatchObject({ code: 'not_declared', text: state.why });
  expect(append).not.toHaveBeenCalled();
  expect(runReferee).not.toHaveBeenCalled();
});

// A `record` on a tree already declared must not declare it again, nor send a
// recorded change back to `declared`. It repeats the handoff from the logbook.
it.each([
  ['declared', [], 'declared', 'operator', /Write the change file now/],
  ['declared', ['requirements/changes/x.md'], 'declared', 'operator', /The next turn end checks it and records the change\./],
  ['recorded', ['requirements/changes/x.md'], 'recorded', 'agent', /Write the commit message now/],
])('repeats the handoff on a record in %s with change files %j, and adds nothing', (phase, changeFiles, code, audience, next) => {
  const declaration = { seq: 5, event: 'declared', payload: { treeFingerprint: 'now', summary: ['risk LOW'] } };
  Object.assign(state, { phase, changeFiles, declaration });
  const [reply] = onPrompt({ prompt: 'record' }).messages;
  expect(reply).toMatchObject({ code, for: audience });
  expect(reply.text).toContain('Change declared on this tree. This is the report recorded with that decision.');
  expect(reply.text).toContain('Details: log/0005__declared.json');
  expect(reply.text).toContain('Nothing new was declared');
  expect(reply.text).toMatch(next);
  expect(runReferee).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('judges a record on a drifted declared tree as before, without repeating the handoff', () => {
  Object.assign(state, { phase: 'declared', changeFiles: [], drift: true, why: 'the implementation changed',
    declaration: { seq: 5, event: 'declared', payload: { treeFingerprint: 'now', summary: ['risk LOW'] } } });
  expect(onPrompt({ prompt: 'record' }).messages[0]).toEqual({ code: 'not_declared', for: 'operator', text: 'the implementation changed' });
  expect(append).not.toHaveBeenCalled();
});
