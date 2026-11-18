import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '../../../tests/fixtures/workflow/adapter.mjs';
import { snapshotGrant } from '../../../tests/fixtures/workflow/events.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { current } from '../state.mjs';
import { append } from '../chain.mjs';
import { frozenChanges, changedFiles } from '../frozen.mjs';
import { runTestCommand } from '../../evidence/test-run.ts';
import { compileErrors } from '../../evidence/typecheck.ts';
import { publishSnapshot } from '../local-snapshot.mjs';

// The command runs at import. Give each invocation its own module instance,
// keeping the prediction, test classification and event construction real.
vi.mock('../local-snapshot.mjs', { spy: true });
vi.mock('../state.mjs', () => ({ current: vi.fn() }));
vi.mock('../chain.mjs', async original => ({ ...await original(), append: vi.fn() }));
vi.mock('../frozen.mjs', { spy: true });
vi.mock('../../evidence/test-run.ts', { spy: true });
vi.mock('../../evidence/typecheck.ts', { spy: true });

let state, run;
// The real `append` returns the record it wrote, which the summaries link to.
const recorded = (_dir, event, payload) => ({ seq: event === 'triaged' ? 2 : 3, event, payload });
const linked = event => `\n\nDetails: log/${event === 'triaged' ? '0002' : '0003'}__${event}.json`;
const stderr = () => console.error.mock.calls.map(([text]) => text).join('\n');
const cwd = process.cwd();
let repo;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'snapshot-command-'));
  process.chdir(repo);
  writeConfig(repo);
  const real = await vi.importActual('../local-snapshot.mjs');
  publishSnapshot.mockReset().mockImplementation(real.publishSnapshot);
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(status => { throw Error('exit ' + status); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state = { dir: 'log', branch: 'topic', treeFingerprint: 'now', implementationFingerprint: 'code', entries: [], baseline: 'base', grant: snapshotGrant('topic', '# Plan\n\n```workflow\ntest-only: true\n```', repo) };
  state.grant.payload.testOnly = true;
  current.mockReturnValue(state);
  run = { cases: [{ file: 'a.test.ts', name: 'example', ids: [], scenarios: [], status: 'passed' }], leftOut: [], exit: 0 };
  runTestCommand.mockImplementation(({ capture }) => { capture([]); return run; });
  publishSnapshot.mockReturnValue('snapshot');
  compileErrors.mockReturnValue([]);
  frozenChanges.mockReturnValue([]);
  changedFiles.mockReturnValue([]);
  append.mockImplementation(recorded);
});
afterEach(() => { process.chdir(cwd); rmSync(repo, { recursive: true, force: true }); });
afterEach(() => vi.restoreAllMocks());

it('records the green pre-change suite as the baseline for a test-only change', async () => {
  // A real snapshot, so the summary reads back what the event recorded.
  publishSnapshot.mockImplementation((await vi.importActual('../local-snapshot.mjs')).publishSnapshot);
  await import('./triage.ts');
  expect(runTestCommand).toHaveBeenCalledWith({ shown: false, capture: expect.any(Function) });
  expect(append).toHaveBeenCalledWith('log', 'triaged', expect.objectContaining({
    treeFingerprint: 'now', implementationFingerprint: 'code', implemented: false, evidence: [{ role: 'analysis', title: 'Triage analysis', snapshot: expect.stringContaining('/topic/triage/') }], testCount: 1,
    predicted: { total: 0, failed: 0 }, surprise: expect.objectContaining({ failed: 0, total: 1 }),
  }), 'topic', state.entries.length);
  expect(append.mock.calls[0][2]).not.toHaveProperty('testOnly');
  expect(console.log).toHaveBeenCalledOnce();
  const [[printed]] = console.log.mock.calls;
  expect(printed).toMatch(/^Triage of plan's missed predictions and test regressions, on a tree with no implementation in it, as the plan said\./);
  expect(printed).toContain('Risk: LOW\n1 test ran, 0 failed\n');
  expect(printed).not.toContain('triage: ');
  // The report ends at its link. What the agent does next follows, apart.
  const [report, notes] = printed.split(linked('triaged'));
  expect(report).not.toContain('Next:');
  expect(notes).toBe('\n\nFor the agent, not part of the report:\n'
    + 'Next: the suite is green, so write the tests this change is for. Anything they turn red is something they found, and that is the whole point of them.\n'
    + 'Tests are editable. The implementation is frozen at this triage.');
});
it('records the surprise and over-prediction reasons in the order shown beside HIGH risk', async () => {
  const plan = ['# Plan', '```workflow', 'predicted-failures:', '  - a.test.ts::predicted break',
    '  - a.test.ts::still passes', '  - a.test.ts::also passes', '```'].join('\n');
  publishSnapshot.mockImplementation((await vi.importActual('../local-snapshot.mjs')).publishSnapshot);
  state.grant = snapshotGrant('topic', plan, repo);
  const test = run.cases[0];
  run.cases = [
    { ...test, name: 'predicted break', status: 'failed' },
    { ...test, name: 'unexpected break', status: 'failed' },
    { ...test, name: 'still passes' },
    { ...test, name: 'also passes' },
  ];
  run.exit = 1;
  await import('./triage.ts');

  const reasons = [
    'Raised to HIGH by surprise failures: 1 against 3 predicted, 20% or more.',
    'Raised to HIGH by over-predictions: 2 of 3 predicted failures passed, 20% or more.',
  ];
  expect(append).toHaveBeenCalledWith('log', 'triaged', expect.objectContaining({ level: 'HIGH', reasons }), 'topic', 0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(['Risk: HIGH', ...reasons, '4 tests ran, 2 failed'].join('\n')));
});

it('records sorted raw XML with verification titles followed by one triage analysis', async () => {
  publishSnapshot.mockImplementation((await vi.importActual('../local-snapshot.mjs')).publishSnapshot);
  const longFolder = 'z   ' + 'x'.repeat(245);
  const reports = [longFolder, 'fast'].map(folder => ({
    name: folder + '/run.xml', bytes: Buffer.from('<testsuite name="' + folder + '"/>\r\n'),
  }));
  runTestCommand.mockImplementationOnce(({ capture }) => { capture(reports); return run; });
  await import('./triage.ts');
  const { evidence, ...counts } = append.mock.calls[0][2];
  expect(evidence).toEqual([
    { role: 'raw', title: 'JUnit: fast/run.xml', snapshot: expect.stringContaining('/junit/') },
    { role: 'raw', title: ('JUnit: z ' + 'x'.repeat(245) + '/run.xml').slice(0, 255) + '…', snapshot: expect.stringContaining('/junit/') },
    { role: 'analysis', title: 'Triage analysis', snapshot: expect.stringContaining('/triage/') },
  ]);
  expect(readFileSync(join(repo, evidence[0].snapshot))).toEqual(reports[1].bytes);
  expect(readFileSync(join(repo, evidence[1].snapshot))).toEqual(reports[0].bytes);
  expect(counts).not.toHaveProperty('junitReports');
  expect(counts).not.toHaveProperty('triageFile');
});

it('refuses a test-only change when a previously existing test fails', async () => {
  run.cases[0].status = 'failed';
  run.cases[0].message = 'wrong answer';
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).toHaveBeenCalledWith('log', 'triage_refused', { reason: 'suite_not_green', evidence: [], failures: [expect.stringContaining('wrong answer')] }, 'topic');
  expect(stderr()).toMatch(/^Triage refused\.\n\nThis change is declared test-only, and the suite is not green:\n\n  a\.test\.ts .*wrong answer/);
  expect(stderr()).toContain('Fix these first, as their own change.');
  expect(stderr().endsWith(linked('triage_refused'))).toBe(true);
});
it('refuses changed frozen tests before running the suite, even on a test-only plan', async () => {
  frozenChanges.mockReturnValue(['a.test.ts']);
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).toHaveBeenCalledWith('log', 'triage_refused', { reason: 'tests_modified', files: ['a.test.ts'] }, 'topic');
  expect(runTestCommand).not.toHaveBeenCalled();
  expect(stderr()).toContain('\n\nThese differ from the baseline:\n  a.test.ts\n\nThis change is declared test-only, so the triage comes first');
  expect(stderr().endsWith(linked('triage_refused'))).toBe(true);
});
it('tells an ordinary change with changed frozen tests where a test-only declaration goes', async () => {
  state.grant.payload.testOnly = false;
  frozenChanges.mockReturnValue(['a.test.ts']);
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(stderr()).toContain('Unwind them and run this again.');
  expect(stderr()).toContain('`test-only: true` in its closing `workflow` block');
  expect(stderr()).not.toContain('frontmatter');
});
it('refuses an implementation error before measuring predictions', async () => {
  compileErrors.mockReturnValue([{ file: 'modules/a.ts', line: 3, message: 'not callable' }]);
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).toHaveBeenCalledWith('log', 'triage_refused', { reason: 'typecheck_failed', files: ['modules/a.ts'] }, 'topic');
  expect(runTestCommand).not.toHaveBeenCalled();
  expect(stderr()).toContain('nothing to classify.');
  expect(stderr()).toContain('\n\n  modules/a.ts:3 not callable\n\nFinish the implementation, then run this again.');
  expect(stderr().endsWith(linked('triage_refused'))).toBe(true);
});

it('refuses unreadable approval evidence before running tests or appending an event', async () => {
  state.grant = { seq: 7, payload: { planSnapshot: 'wrong', testOnly: false } };
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('approval 7 wrong: invalid approved plan reference'));
  expect(stderr()).toMatch(/^Triage refused\.\n\n[^]*\n\nNo logbook event was recorded\.$/);
  expect(runTestCommand).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('propagates an unexpected runner error without recording a triage', async () => {
  const failure = new Error('runner bug');
  runTestCommand.mockImplementationOnce(() => { throw failure; });
  await expect(import('./triage.ts')).rejects.toBe(failure);
  expect(console.error).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it('refuses to record a triage if the implementation changes while the suite runs', async () => {
  current.mockReturnValueOnce(state).mockReturnValue({ ...state, implementationFingerprint: 'edited' });
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(runTestCommand).toHaveBeenCalledOnce();
  expect(stderr()).toBe('Triage refused.\n\nThe working tree or approval changed during the run.\n\nRun triage again.' + linked('triage_refused'));
  expect(append.mock.calls.map(call => call.slice(1, 3))).toEqual([['triage_refused', { reason: 'measurement_changed', evidence: [] }]]);
});

it('refuses to measure a replacement implementation under the existing approval', async () => {
  state.drift = true;
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append.mock.calls.map(call => call.slice(1, 3))).toEqual([['triage_refused', { reason: 'implementation_changed' }]]);
  expect(stderr()).toContain('Restore the triaged implementation or approve a revised plan and triage it again.');
  expect(stderr().endsWith(linked('triage_refused'))).toBe(true);
  expect(runTestCommand).not.toHaveBeenCalled();
});

it('retains the JUnit reports on refusal when the triage snapshot cannot be published', async () => {
  runTestCommand.mockImplementationOnce(({ capture }) => { capture([{ name: 'run.xml', bytes: Buffer.from('<testsuites/>') }]); return run; });
  publishSnapshot.mockReturnValueOnce('xml snapshot').mockImplementationOnce(() => { throw Error('disk full'); });
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(stderr()).toBe('Triage refused.\n\nCould not publish the triage snapshot: disk full' + linked('triage_refused'));
  expect(append).toHaveBeenCalledWith('log', 'triage_refused', { evidence: [{ role: 'raw', title: 'JUnit: run.xml', snapshot: 'xml snapshot' }], reason: 'snapshot_failed', message: 'disk full' }, 'topic');
});

it('records the captured JUnit reports when parsing fails after publication', async () => {
  runTestCommand.mockImplementationOnce(({ capture }) => {
    capture([{ name: 'bad.xml', bytes: Buffer.from('<') }]);
    throw Error('bad.xml: invalid XML');
  });
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append.mock.calls).toEqual([['log', 'triage_refused', {
    reason: 'invalid_test_run', evidence: [{ role: 'raw', title: 'JUnit: bad.xml', snapshot: 'snapshot' }], message: 'bad.xml: invalid XML',
  }, 'topic']]);
  expect(console.error.mock.calls).toEqual([['Triage refused.\n\nbad.xml: invalid XML' + linked('triage_refused')]]);
});

// The refusals that record nothing: there is no logbook to write to, or no
// change for the refusal to be part of. Each says so where the link would be.
// The error class is imported after the module reset, so it is the one the
// command checks against.
const targetError = async message => new (await import('../target.mjs')).TargetError(message);

it('refuses without recording when the rulebook names no target', async () => {
  const error = await targetError('the rulebook names no target');
  current.mockImplementation(() => { throw error; });
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).not.toHaveBeenCalled();
  expect(stderr()).toBe('Triage refused.\n\nthe rulebook names no target\n\nNo logbook event was recorded.');
});

it('refuses without recording on a broken logbook, and says to stop', async () => {
  state.broken = 'event 3 does not link to event 2';
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).not.toHaveBeenCalled();
  expect(stderr()).toBe('Triage refused.\n\nThe workflow state chain is broken: event 3 does not link to event 2\n\n'
    + 'Stop and tell the operator. Do not work around it.\n\nNo logbook event was recorded.');
});

it('refuses without recording when no plan has been approved', async () => {
  state.grant = null;
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).not.toHaveBeenCalled();
  expect(runTestCommand).not.toHaveBeenCalled();
  expect(stderr()).toBe('Triage refused.\n\nNo plan has been approved on this branch, so there is no change to triage.\n\nNo logbook event was recorded.');
});

it('refuses without recording when the compile step cannot run', async () => {
  const error = await targetError('code.compile is not configured');
  compileErrors.mockImplementation(() => { throw error; });
  await expect(import('./triage.ts')).rejects.toThrow('exit 1');
  expect(append).not.toHaveBeenCalled();
  expect(runTestCommand).not.toHaveBeenCalled();
  expect(stderr()).toBe('Triage refused.\n\ncode.compile is not configured\n\nNo logbook event was recorded.');
});
