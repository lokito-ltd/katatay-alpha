import { verified } from '../../../tests/fixtures/workflow/events.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecksAnalysis, submitAnalysis } from './checks-analysis.mjs';
import { append } from '../chain.mjs';
import { current } from '../state.mjs';
import { analysisRequired } from '../rulebook.mjs';
import { CLEAN, analysisSummary } from '../checks-analysis.mjs';
import { reportFor } from '../checks-report.mjs';
import { publishSnapshot, readSnapshot } from '../local-snapshot.mjs';

vi.mock('../state.mjs', () => ({ current: vi.fn() }));
vi.mock('../chain.mjs', { spy: true });
vi.mock('../rulebook.mjs', { spy: true });
// The report is built from the receipt's results, which checks-report tests
// cover. Here it is the one the receipt's verification would give.
vi.mock('../checks-report.mjs', () => ({ reportFor: vi.fn() }));
// The command saves the analysis under the working directory. Here it goes
// to a temporary folder instead, through the real snapshot code.
vi.mock('../local-snapshot.mjs', { spy: true });
const snapshots = await vi.importActual('../local-snapshot.mjs');
let state;
let evidenceRoot;
afterEach(() => rmSync(evidenceRoot, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  evidenceRoot = mkdtempSync(join(tmpdir(), 'checks-analysis-evidence-'));
  publishSnapshot.mockImplementation((branch, kind, bytes) => snapshots.publishSnapshot(branch, kind, bytes, evidenceRoot));
  readSnapshot.mockImplementation((branch, kind, reference) => snapshots.readSnapshot(branch, kind, reference, evidenceRoot));
  const report = { coverage: { status: 'complete', uncovered: [] }, mutation: { status: 'complete', survivors: [] }, checks: [] };
  reportFor.mockReturnValue(report);
  const entries = [{ seq: 1, event: 'plan_approved' }, { seq: 2, event: 'verified', payload: verified({ treeFingerprint: 'A' }) }];
  state = { dir: 'log', branch: 'work', phase: 'verified', ...entries[1].payload, live: entries, entries };
  current.mockReturnValue(state);
  analysisRequired.mockReturnValue(true);
  // As the real append does, it returns the event it wrote.
  append.mockImplementation((_dir, event, payload) => {
    const entry = { seq: entries.length + 1, event, payload };
    entries.push(entry);
    return entry;
  });
});
/** The clean analysis's compact summary, linking to the event at `seq`. */
const cleanSummary = (verification, seq) => `Agent's assessment for verification ${verification} checks results.\n\n`
  + `${CLEAN}\n\nFull analysis: log/${String(seq).padStart(4, '0')}__checks_analysis.json`;

it('stores exact bytes once, returns the accepted summary on a conflict, and ties acceptance to the receipt', () => {
  const original = CLEAN + '\n';
  expect(submitAnalysis('2', original)).toEqual({ text: cleanSummary(2, 3), conflict: null });
  expect(submitAnalysis('2', original)).toEqual({ text: cleanSummary(2, 3), conflict: null });
  const conflict = submitAnalysis('2', CLEAN);
  expect(conflict).toMatchObject({ text: cleanSummary(2, 3), conflict: expect.stringContaining('0003__checks_analysis.json') });
  expect(conflict.conflict).toContain('Its summary is on stdout.');
  expect(append).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledWith('log', 'checks_analysis',
    { verification: 2, summary: CLEAN, analysisSnapshot: expect.stringMatching(/^\.katatay\/local\/work\/checks-analysis\//) }, 'work', 2);
  const { analysisSnapshot } = append.mock.calls[0][2];
  expect(readFileSync(join(evidenceRoot, analysisSnapshot), 'utf8')).toBe(original + '\n\nEvidence\nNone.\n');
});

it('refuses a retry when the saved analysis is altered, missing or lists other evidence, naming the file', () => {
  submitAnalysis('2', CLEAN);
  const { analysisSnapshot } = state.live.at(-1).payload;
  const path = join(evidenceRoot, analysisSnapshot);
  const cannotRead = why => `The analysis accepted in 0003__checks_analysis.json cannot be read from ${analysisSnapshot}: ${why}`;
  writeFileSync(path, CLEAN + '\n\nEvidence\nNone.\nedited');
  expect(() => submitAnalysis('2', CLEAN)).toThrow(cannotRead('SHA-256 digest mismatch'));
  rmSync(path);
  expect(() => submitAnalysis('2', CLEAN)).toThrow(cannotRead('ENOENT'));
  writeFileSync(path, CLEAN + '\n\nEvidence\nNone.\n');
  expect(submitAnalysis('2', CLEAN)).toEqual({ text: cleanSummary(2, 3), conflict: null });
  state.live[1].payload.results = [{ name: 'lint', evidence: [{ role: 'raw', title: 'lint output', snapshot: 'x' }] }];
  expect(() => submitAnalysis('2', CLEAN)).toThrow(cannotRead('its evidence list does not match the verification'));
  expect(append).toHaveBeenCalledOnce();
});
it('writes nothing for an invalid report, wrong receipt, disabled switch, broken chain or changed phase', () => {
  expect(() => submitAnalysis('2', ' ')).toThrow('No analysis recorded');
  expect(() => submitAnalysis('1', CLEAN)).toThrow('not the current receipt');
  state.treeFingerprint = 'B';
  expect(() => submitAnalysis('2', CLEAN)).toThrow('not the current receipt');
  state.treeFingerprint = 'A'; state.phase = 'recorded';
  expect(() => submitAnalysis('2', CLEAN)).toThrow('verified change');
  analysisRequired.mockReturnValue(false);
  expect(() => submitAnalysis('2', CLEAN)).toThrow('is off');
  state.broken = 'bad link';
  expect(() => submitAnalysis('2', CLEAN)).toThrow('bad link');
  expect(append).not.toHaveBeenCalled();
});

// Lost evidence is not a fault in the agent's text, so it is never worded as one.
it('says the verification\'s evidence cannot be read, apart from an invalid analysis, and records nothing', () => {
  reportFor.mockImplementation(() => { throw new Error('the mutation evidence cannot be read: missing findings'); });
  expect(() => submitAnalysis('2', CLEAN)).toThrow(new Error('Verification 2\'s evidence cannot be read: the mutation evidence cannot be read: '
    + 'missing findings. Restore the files it names. No analysis recorded.'));
  expect(publishSnapshot).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('starts a new analysis when the tree repeats under a later verification', () => {
  submitAnalysis('2', CLEAN);
  state.live.push({ ...state.live[1], seq: 4 });
  expect(() => submitAnalysis('2', CLEAN)).toThrow('not the current receipt');
  const fresh = CLEAN + '\n';
  // The summary links to the second event, not the first.
  expect(submitAnalysis('4', fresh)).toEqual({ text: cleanSummary(4, 5), conflict: null });
  const saved = state.live.filter(e => e.event === 'checks_analysis').map(e => e.payload);
  expect(saved).toEqual([2, 4].map(verification => ({ verification, summary: CLEAN, analysisSnapshot: expect.any(String) })));
  expect(saved.map(({ analysisSnapshot }) => readFileSync(join(evidenceRoot, analysisSnapshot), 'utf8').split('\n\nEvidence')[0])).toEqual([CLEAN, fresh]);
});

it.each([[], ['0'], ['01'], ['-1'], ['2x'], ['12', 'extra']].map(args => ({ args })))(
  'rejects invalid arguments ($args) before reading input', ({ args }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(runChecksAnalysis(args, -1)).toBe(1);
      expect(error).toHaveBeenCalledWith('usage: workflow checks-analysis <verification-seq> (analysis on stdin)');
      expect(append).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

it('prints only the accepted summary on stdout and uses stderr and exit status for rejections', () => {
  reportFor.mockReturnValue({ ...reportFor(), checks: [{ name: 'lint', status: 'findings' }] });
  const accepted = 'Summary: Remove the unused import.\r\nCheck lint\r\nFinding: Unused import.\r\nAction: Remove it and rerun lint.\r\n';
  const root = mkdtempSync(join(tmpdir(), 'checks-analysis-input-'));
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  function submit(input) {
    const path = join(root, 'stdin');
    writeFileSync(path, input);
    const fd = openSync(path, 'r');
    try { return runChecksAnalysis(['2'], fd); }
    finally { closeSync(fd); }
  }
  try {
    expect(submit('')).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Verification 2: missing Summary. No analysis recorded.');
    expect(stdout).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    stderr.mockClear();
    expect(submit(accepted)).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(submit('Different analysis')).toBe(1);
    const printed = analysisSummary({ text: accepted, seq: 2, link: 'log/0003__checks_analysis.json' }) + '\n';
    expect(printed).toContain('Remove the unused import.');
    expect(printed).toContain('Check findings answered: 1 (lint).');
    expect(printed).not.toContain('Finding: Unused import.');
    expect(stdout.mock.calls).toEqual([[printed], [printed]]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('0003__checks_analysis.json'));
    expect(append).toHaveBeenCalledOnce();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
