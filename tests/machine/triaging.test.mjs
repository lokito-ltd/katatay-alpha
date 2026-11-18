/**
 * The triage command itself, run in the fixture as the operator's agent runs
 * it, for what it stores. The other machine cases append a `triaged` event by
 * hand (`triage` in `harness.mjs`), because they test what reads it. This one
 * tests what writes it.
 *
 * The fixture's adapter has no compile step and a stub test command, so the
 * run costs a few processes and no suite.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { append } from '../../src/workflow/chain.mjs';
import { publishSnapshot } from '../../src/workflow/local-snapshot.mjs';
import { triageEvidence } from '../../src/workflow/triage-snapshot.mjs';
import { analysisPath } from '../fixtures/workflow/events.mjs';
import { triageReport } from '../../src/workflow/triage-summary.mjs';
import { ctx, machineFixture, approvePlan, attempt, cli, events, git, phase, planFile, prompt, publish, show, stop, submitFixtureAnalysis } from '../support/machine/harness.mjs';

machineFixture();

const WORKFLOW = resolve(import.meta.dirname, '../../src/workflow/cli/workflow.mjs');

const triageCommand = () =>
  spawnSync('node', [WORKFLOW, 'triage'], { cwd: ctx.repo, encoding: 'utf8', env: { ...process.env, HOME: ctx.home } });

/** A test file at the baseline, which the reports can name: the referee
 *  refuses a report naming a file outside the rulebook's tests. Committed and
 *  published before the approval, so the freeze finds it unchanged. */
const TEST_FILE = 'checks.test.mjs';
// The compact refusal wraps at 76 columns, so a long path takes a line of its
// own. What it says is the same with every run of whitespace as one space.
const flat = text => text.replace(/\s+/g, ' ');
function testFileAtBaseline(cases = [], file = TEST_FILE) {
  outcomes(cases, file);
  writeFileSync(join(ctx.repo, file), "it('one', () => {});\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'a test file');
  publish();
}

/** The fixture's test outcomes, each a test in `TEST_FILE`. */
const outcomes = (list, file = TEST_FILE) =>
  writeFileSync(join(ctx.repo, 'outcomes.json'), `${JSON.stringify({ outcomes: list.map((o) => ({ file, ...o })) })}\n`);

const triaged = () => {
  const file = readdirSync(ctx.logbook).find((name) => name.endsWith('__triaged.json'));
  return JSON.parse(readFileSync(join(ctx.logbook, file), 'utf8')).payload;
};

const plan = (predictions) =>
  `# Plan\n\nBreak one test.\n\n\`\`\`workflow\npredicted-failures:\n${predictions.map((p) => `  - '${p}'`).join('\n')}\n\`\`\`\n`;

describe('predictions used by triage and risk', () => {
  const commands = [['req', 'risk'], ['triage']];
  const run = args => cli('workflow.mjs', ...args);
  const readEvent = name => JSON.parse(readFileSync(join(ctx.logbook, name), 'utf8'));
  const assertPredicted = args => {
    const result = run(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('predicted 1/1 failed · 0 surprises');
  };

  it('uses the revised snapshot after the same working file is edited or removed', () => {
    testFileAtBaseline([{ title: 'second', failed: true }]);
    const original = plan([TEST_FILE + '::first']);
    const revision = plan([TEST_FILE + '::second']);
    approvePlan({ plan: original });
    approvePlan({ plan: revision });
    const [first, second] = events().map(name => readEvent(name).payload);
    expect(first).not.toHaveProperty('planFile');
    expect(second).not.toHaveProperty('planFile');
    expect(first.planSnapshot).not.toBe(second.planSnapshot);
    expect(readFileSync(join(ctx.repo, first.planSnapshot), 'utf8')).toBe(original);
    expect(readFileSync(join(ctx.repo, second.planSnapshot), 'utf8')).toBe(revision);
    approvePlan({ plan: revision });
    expect(events()).toHaveLength(2);
    writeFileSync(planFile(), original);
    assertPredicted(commands[0]);
    unlinkSync(planFile());
    assertPredicted(commands[1]);
  });

  it('keeps a committed approval readable without evidence and refuses measurement until the bytes are restored', () => {
    testFileAtBaseline([{ title: 'one', failed: true }]);
    approvePlan({ plan: plan([TEST_FILE + '::one']) });
    const ref = readEvent(events()[0]).payload.planSnapshot;
    const path = join(ctx.repo, ref);
    const bytes = readFileSync(path);
    git('add', '.katatay/state');
    git('commit', '--quiet', '-m', 'checkpoint approval');
    unlinkSync(path);
    expect(phase()).toBe('implementing');
    const structural = run(['state', 'verify']);
    expect(structural.status, structural.stderr).toBe(0);
    const report = join(ctx.repo, 'reports/junit/run.xml');
    if (existsSync(report)) unlinkSync(report);
    for (const damage of ['ENOENT', 'digest mismatch']) {
      if (damage === 'digest mismatch') writeFileSync(path, 'replacement');
      for (const args of commands) {
        const result = run(args);
        expect(result.status).toBe(1);
        expect(flat(result.stderr)).toContain('approval 1 ' + ref);
        expect(result.stderr).toContain(damage);
        expect(flat(result.stderr)).toContain('Restore the exact approved snapshot');
        expect(result.stdout).not.toContain('risk:');
        expect(existsSync(report)).toBe(false);
      }
      expect(events()).toHaveLength(1);
    }
    writeFileSync(path, bytes);
    for (const args of commands) assertPredicted(args);
  });

  it('rejects a live grant with only inline predictions before measuring the suite', () => {
    testFileAtBaseline([{ title: 'one', failed: true }]);
    approvePlan({ plan: plan([TEST_FILE + '::one']) });
    const name = events()[0];
    const event = readEvent(name);
    unlinkSync(join(ctx.repo, event.payload.planSnapshot));
    delete event.payload.planSnapshot;
    event.payload.predictedFailures = [TEST_FILE + '::one'];
    writeFileSync(join(ctx.logbook, name), JSON.stringify(event));
    unlinkSync(planFile());
    for (const args of commands) {
      const result = run(args);
      expect(result.status).toBe(1);
      // Reading ignores the old inline field; the missing snapshot reference
      // is what breaks the logbook.
      expect(result.stderr).toContain('planSnapshot is missing');
      expect(result.stdout).not.toContain('risk:');
    }
  });
});

describe('the triaged event, as the triage command stores it', () => {
  it('keeps the failing invariant name in the snapshot and its reason in the event', () => {
    const file = 'checks.acceptance.test.mjs';
    const title = 'A stored decision survives reopening. [INV0001]';
    testFileAtBaseline([{ title, failed: true }, { title: 'still passes', failed: false }], file);
    approvePlan({ plan: plan([file + '::still passes']) });
    const run = triageCommand();
    expect(run.status, run.stderr).toBe(0);
    const event = JSON.parse(readFileSync(join(ctx.logbook, events().find(name => name.endsWith('__triaged.json')))));
    const { payload } = event;
    const reasons = [
      'Raised to HIGH by failing invariants, named below.',
      'Raised to HIGH by surprise failures: 1 against 1 predicted, 20% or more.',
      'Raised to HIGH by over-predictions: 1 of 1 predicted failures passed, 20% or more.',
    ];
    expect(payload).toMatchObject({ level: 'HIGH', reasons });
    expect(JSON.stringify(payload)).not.toContain(title);
    const path = join(ctx.repo, analysisPath(payload));
    expect(JSON.parse(readFileSync(path)).details.invariants).toEqual([file + ' — ' + title]);
    const riskLines = ['Risk: HIGH', ...reasons].join('\n');
    expect(run.stdout).toContain(riskLines);
    expect(run.stdout).toContain(`\nFailing invariants:\n${file} — ${title}\n`);
    expect(show()).toContain(`           Failing invariants:\n           ${file} — ${title}\n`);
    unlinkSync(path);
    expect(triageReport(event, { branch: 'feat/x', dir: ctx.logbook, root: ctx.repo, testOnly: false })).toContain(riskLines);
    expect(show()).toContain(['Risk: HIGH', ...reasons].join('\n           '));
  });

  it.each([
    ['invalid', "printf 'broken XML' > reports/junit/bad.xml", 'invalid_test_run', ['broken XML']],
    ['empty', 'exit 1', 'suite_not_green', []],
  ])('retains the %s report set on a refused test-only triage', (_, command, reason, contents) => {
    testFileAtBaseline();
    approvePlan({ plan: '# Tests\n\n```workflow\ntest-only: true\n```' });
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path));
    config.tests.run.command = 'mkdir -p reports/junit && ' + command;
    writeFileSync(path, JSON.stringify(config));
    const result = triageCommand();
    expect(result.status, result.stderr).toBe(1);
    const last = JSON.parse(readFileSync(join(ctx.logbook, events().at(-1))));
    expect(last).toMatchObject({ event: 'triage_refused', payload: { reason } });
    expect(last.payload.evidence).toEqual(contents.map(() => ({
      role: 'raw', title: 'JUnit: reports/junit/bad.xml', snapshot: expect.any(String),
    })));
    expect(last.payload.evidence.map(file => readFileSync(join(ctx.repo, file.snapshot), 'utf8'))).toEqual(contents);
  });

  it('publishes the baseline titles before recording the snapshot reference', () => {
    testFileAtBaseline([{ title: 'two', failed: false }, { title: 'one', failed: false }]);
    approvePlan({ plan: '# Only tests\n\n```workflow\ntest-only: true\n```' });
    const result = triageCommand();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Risk: LOW\n2 tests ran, 0 failed');
    expect(show()).toContain('           Risk: LOW\n           2 tests ran, 0 failed\n');

    const payload = triaged();
    expect(payload).toMatchObject({ testCount: 2, level: 'LOW', reasons: [] });
    expect(payload).not.toHaveProperty('testOnly');
    expect(payload).not.toHaveProperty('unlistedFileCount');
    expect(payload).not.toHaveProperty('testIdsFile');
    expect(payload).not.toHaveProperty('tests');
    const path = join(ctx.repo, analysisPath(payload));
    const bytes = readFileSync(path);
    expect(analysisPath(payload)).toMatch(/^\.katatay\/local\/feat_x\/triage\/\d{8}T\d{6}\.\d{3}Z_/);
    expect(analysisPath(payload).endsWith('_' + createHash('sha256').update(bytes).digest('base64url') + '.json')).toBe(true);
    expect(readdirSync(join(ctx.repo, '.katatay/local/feat_x')).sort()).toEqual(['junit', 'plans', 'triage']);
    expect(JSON.parse(bytes)).toEqual({ version: 1, identities: { tests: [{ file: TEST_FILE, titles: ['one', 'two'] }], unlisted: [] },
      details: { surprises: [], surpriseNames: [], overPredictions: [], notRun: { predicted: [], unpredicted: [] }, invariants: [] } });
  });

  it('uses the current approval for the CLI advice and the report relayed at turn end after a plan revision', () => {
    testFileAtBaseline([{ title: 'one', failed: false }]);
    const cases = [
      { plan: '# Tests only\n\n```workflow\ntest-only: true\n```', titleEnding: 'in it, as the plan said.', next: 'the suite is green, so write the tests this change is for.' },
      { plan: '# Revised plan\n\nChange the implementation.', titleEnding: 'in it.', next: 'nothing failed. Write the tests this change needs.' },
    ];
    for (const { plan, titleEnding, next } of cases) {
      approvePlan({ plan });
      const result = triageCommand();
      expect(result.status, result.stderr).toBe(0);
      const [report, notes] = result.stdout.split('\n\nFor the agent, not part of the report:\n');
      const name = events().at(-1);
      expect(report.split('\n')[0]).toBe("Triage of plan's missed predictions and test regressions, on a tree with no implementation " + titleEnding);
      expect(report.endsWith('Details: ' + join('.katatay/state/feat_x', name))).toBe(true);
      expect(notes).toContain('Next: ' + next);
      const relayed = stop().reason;
      expect(relayed).toContain(report);
      expect(relayed).not.toContain(next);
    }
  });

});

describe('the implementation measured at triage', () => {
  const write = (path, text) => writeFileSync(join(ctx.repo, path), text);
  const file = path => readFileSync(join(ctx.repo, path), 'utf8');
  const denied = path => attempt(path)?.hookSpecificOutput.permissionDecision;
  const record = () => prompt('record').hookSpecificOutput.additionalContext;

  it.each(['ordinary', 'test-only'])('holds both freezes through real hooks on a %s plan', kind => {
    approvePlan(kind === 'test-only' ? { plan: '# Only tests\n\n```workflow\ntest-only: true\n```' } : {});
    expect(denied(TEST_FILE)).toBe('deny');
    expect(denied('tests/helper.txt')).toBe('deny');
    write(TEST_FILE, 'premature');
    expect(triageCommand().stderr).toContain('differ from the baseline');
    const refusal = JSON.parse(readFileSync(join(ctx.logbook, events().at(-1)), 'utf8'));
    expect(refusal.event).toBe('triage_refused');
    expect(refusal.payload).toEqual({ reason: 'tests_modified', files: [TEST_FILE] });
    unlinkSync(join(ctx.repo, TEST_FILE));
    expect(triageCommand().status).toBe(0);
    const fingerprint = triaged().implementationFingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(denied(TEST_FILE)).toBeUndefined();
    expect(denied('source.txt')).toBe('deny');
    expect(denied('requirements/changes/20260101T000000.000Z__x.md')).toBeUndefined();
    expect(denied('reports/checks/cache.json')).toBeUndefined();
    const original = file('source.txt');
    write('source.txt', 'external edit');
    expect(show()).toContain('Restore the triaged implementation');
    expect(stop().reason).toContain('implementation changed after triage');
    expect(record()).toContain('implementation changed after triage');
    expect(triageCommand().stderr).toContain('Restore the triaged implementation');
    expect(events().filter(name => name.endsWith('__triaged.json'))).toHaveLength(1);
    write('source.txt', original);
    stop();
    expect(phase()).toBe('verified');
    approvePlan({ plan: '# Revised scope\n\nChange the implementation.' });
    expect(phase()).toBe('implementing');
    expect(denied('source.txt')).toBeUndefined();
    write('source.txt', 'approved repair');
    expect(triageCommand().status).toBe(0);
    const newest = events().filter(name => name.endsWith('__triaged.json')).at(-1);
    expect(JSON.parse(fileFromLog(newest)).payload.implementationFingerprint).not.toBe(fingerprint);
  });

  const fileFromLog = name => readFileSync(join(ctx.logbook, name), 'utf8');

  it('regenerates a versioned triage snapshot with the baseline tests and preserves the old bytes', () => {
    testFileAtBaseline([{ title: 'one', failed: false }]);
    approvePlan();
    expect(triageCommand().status).toBe(0);
    const payload = triaged();
    const original = JSON.parse(file(analysisPath(payload)));
    const { version, ...unversioned } = original;
    expect(version).toBe(1);
    const bytes = Buffer.from(JSON.stringify(unversioned));
    const path = publishSnapshot('feat/x', { folder: 'triage', extension: 'json' }, bytes, ctx.repo);
    payload.evidence.find(item => item.role === 'analysis').snapshot = path;
    const invalid = append(ctx.logbook, 'triaged', payload, 'feat/x');
    const problem = triageEvidence('feat/x', invalid, ctx.repo).problem;
    expect(problem).toContain(path);
    expect(problem).toContain('triage.version has unsupported schema version missing');
    write(TEST_FILE, "it('added after triage', () => {});\n");
    const edits = file(TEST_FILE);
    git('restore', '--', TEST_FILE);
    const rerun = triageCommand();
    expect(rerun.status, rerun.stderr).toBe(0);
    const fresh = JSON.parse(fileFromLog(events().at(-1)));
    expect(fresh.event).toBe('triaged');
    expect(fresh.seq).toBeGreaterThan(invalid.seq);
    expect(JSON.parse(file(analysisPath(fresh.payload))).version).toBe(1);
    expect(triageEvidence('feat/x', fresh, ctx.repo).identities).toEqual(original.identities);
    write(TEST_FILE, edits);
    expect(readFileSync(join(ctx.repo, path))).toEqual(bytes);
  });

  it('requires a fresh triage and verification when the selected snapshot is lost', () => {
    testFileAtBaseline();
    approvePlan();
    expect(triageCommand().status).toBe(0);
    const ref = analysisPath(triaged());
    const path = join(ctx.repo, ref);
    const snapshot = readFileSync(path);
    // A valid copy under a newer timestamp must not substitute for the event's reference.
    writeFileSync(path.replace(/\d{8}T\d{6}/, '20990101T000000'), snapshot);
    stop();
    submitFixtureAnalysis();
    const junit = join(ctx.repo, 'reports/junit/run.xml');
    const verifiedRun = readFileSync(junit);
    writeFileSync(junit, '<testsuites/>');
    expect(cli('workflow.mjs', 'report').stdout).not.toContain('Could not be read');
    writeFileSync(junit, verifiedRun);
    for (const damage of ['missing', 'changed']) {
      if (damage === 'missing') unlinkSync(path);
      else writeFileSync(path, 'different bytes');
      const display = show();
      expect(display).toContain('           Risk: LOW\n');
      expect(display).toContain('           The triage snapshot cannot be read: triage 2 ' + ref);
      expect(cli('workflow.mjs', 'state', 'verify').status).toBe(0);
      for (let i = 0; i < 2; i++) {
        const reply = record();
        expect(reply).toContain('triage 2 ' + ref);
        expect(reply).toContain(damage === 'missing' ? 'ENOENT' : 'digest mismatch');
        expect(reply).toContain('re-triage');
        expect(phase()).toBe('verified');
      }
    }
    expect(events().some(name => /__(record_held|declared)\.json$/.test(name))).toBe(false);
    expect(triageCommand().status).toBe(0);
    expect(phase()).toBe('converging');
    expect(record()).toContain('only a verified working tree');
    stop();
    submitFixtureAnalysis();
    record();
    expect(phase()).toBe('declared');
  });

  it('uses pass B after pass A and a failed verify, and requires fresh verification on returning to A', () => {
    testFileAtBaseline();
    approvePlan();
    expect(triageCommand().status).toBe(0);
    const original = file('outcomes.json');
    stop();
    submitFixtureAnalysis();
    const receipts = () => events().filter(name => name.endsWith('__verified.json')).map(name => JSON.parse(fileFromLog(name)));
    const [a] = receipts();
    outcomes([{ title: 'edited test', failed: true }]);
    expect(record()).toContain('The implementation still matches');
    expect(stop().reason).toContain('failed on the current working tree');
    expect(record()).toContain('Verify the edited tests');
    const failed = JSON.parse(fileFromLog(events().findLast(name => name.endsWith('__verify_failed.json'))));
    const reportsOf = payload => payload.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'tests').evidence.map(item => item.snapshot);
    expect(file(reportsOf(failed.payload)[0])).toContain('<failure');
    outcomes([{ title: 'edited test', failed: false }]);
    stop();
    const b = receipts()[1];
    expect(reportsOf(b.payload)).not.toEqual(reportsOf(a.payload));
    expect(file(reportsOf(b.payload)[0])).toContain('edited test');
    expect(b.payload.testFingerprint).not.toBe(a.payload.testFingerprint);
    expect(b.payload.implementationFingerprint).toBe(triaged().implementationFingerprint);
    expect(record()).toContain(`Verification ${b.seq} needs its checks analysis`);
    submitFixtureAnalysis();
    expect(record()).toContain('Change declared.');
    write('outcomes.json', original);
    expect(phase()).toBe('converging');
    expect(record()).toContain('Verify the edited tests');
    expect(events().filter(name => name.endsWith('__declared.json'))).toHaveLength(1);
    expect(events().filter(name => name.endsWith('__record_held.json'))).toHaveLength(0);
  });
});
