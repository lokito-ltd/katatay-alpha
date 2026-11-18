import { readBaseline } from '../../src/workflow/phase.mjs';
/** The rulebook's checks at the turn end: what the verified message says of
 *  the ones that report, and how a once-per-plan check's run is stored and
 *  repeated. The hook runs for real, and so does verify, against the
 *  fixture's stubs. How verify runs a check is proved in
 *  `../referee-verify.process.test.mjs`. */
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, machineFixture, approvedChange, events, git, phase, prompt, publish, setMutate, stop, submitText, triage } from '../support/machine/harness.mjs';

import { mutationCommand, mutant } from '../fixtures/workflow/mutation-report.mjs';
import { eventNamed, read } from '../support/machine/baselines.mjs';

machineFixture({ approved: true });

/** The fixture's rulebook with these checks. */
const setChecks = (checks) => {
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.checks = { ...checks, testQuality: { mutation: 'none', coverage: 'none', ...checks.testQuality } };
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

/** A check that counts its runs in a file in the fixture's home, outside the
 *  repository, prints `text`, and exits with `exit`, or with what the file
 *  `exitFile` in the home holds when it is there. */
const counted = (name, { text = '', exit = 0, exitFile = null } = {}) => {
  const runs = JSON.stringify(join(ctx.home, `${name}.runs`));
  const code = exitFile ? `require('fs').existsSync(${JSON.stringify(join(ctx.home, exitFile))}) ? Number(require('fs').readFileSync(${JSON.stringify(join(ctx.home, exitFile))}, 'utf8')) : ${exit}` : exit;
  return `node -e ${JSON.stringify(`require('fs').appendFileSync(${runs}, 'x'); ${text ? `console.log(${JSON.stringify(text)});` : ''} process.exit(${code})`)}`;
};
const runsOf = (name) => (existsSync(join(ctx.home, `${name}.runs`)) ? readFileSync(join(ctx.home, `${name}.runs`), 'utf8').length : 0);
const EXITS = { 0: 'clean', 1: 'findings' };

/** A check's result on each passing receipt, in order, with the receipt's seq. */
const stored = (name) => events().filter((file) => file.endsWith('__verified.json'))
  .map((file) => JSON.parse(readFileSync(join(ctx.logbook, file), 'utf8')))
  .map(({ seq, payload }) => ({ seq, ...payload.results.find((result) => result.name === name) }));

/** The approved change with a code edit, triaged. */
const change = () => {
  approvedChange();
  mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
  writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\n');
  triage();
};
/** An edit after a pass, so the next stop verifies a new tree. */
const edit = (text) => writeFileSync(join(ctx.repo, 'checks.test.mjs'), `// ${text}\n`);

describe('the checks at the turn end', () => {
  it('put what a code check that reports found under findings, and the pass still stands', () => {
    change();
    setChecks({ codeQuality: { lint: { command: counted('lint', { text: 'modules/feature.mjs:1 unused', exit: 1 }), exitCodes: EXITS, onFailure: 'report' } } });
    const { reason } = stop();
    expect(phase()).toBe('verified');
    expect(reason).toMatch(/Findings:\nlint: FINDINGS\nfindings \(exit 1\)\nmodules\/feature\.mjs:1 unused\n/);
  });

  it('show the first 5 lines of a long text, and say how many there are', () => {
    change();
    const lines = Array.from({ length: 50 }, (_, i) => `finding ${i + 1}`).join('\n');
    setChecks({ codeQuality: { lint: { command: counted('lint', { text: lines, exit: 1 }), exitCodes: EXITS, onFailure: 'report' } } });
    const { reason } = stop();
    expect(reason).toContain('finding 5\n[…] Output trimmed. All 50 lines are in the details file.');
    expect(reason).not.toContain('finding 6\n');
  });

  // A blank line is not an item.
  it('leave blank lines out of a check\'s items', () => {
    change();
    setChecks({ codeQuality: { lint: { command: counted('lint', { text: 'first\n\nsecond', exit: 1 }), exitCodes: EXITS, onFailure: 'report' } } });
    const { reason } = stop();
    expect(reason).toContain('lint: FINDINGS\nfindings (exit 1)\nfirst\nsecond\n');
  });

  it('store a once-per-plan check\'s run on a pass, skip it after, and repeat what it found', () => {
    change();
    setChecks({ codeQuality: { scan: { command: counted('scan', { text: 'one finding', exit: 1 }), exitCodes: EXITS, onFailure: 'report', runs: 'oncePerPlan', output: 'reports/scan.json' } } });
    const first = stop().reason;
    expect(first).toMatch(/Findings:\nscan: FINDINGS\nfindings \(exit 1\)\none finding\n/);
    const [run] = stored('scan');
    expect(run).toMatchObject({ status: 'ok', summary: { outcome: 'findings', exitCode: 1 } });
    expect(readFileSync(join(ctx.repo, run.evidence.find((item) => item.role === 'raw').snapshot), 'utf8')).toBe('one finding');
    const saved = readFileSync(join(ctx.repo, 'reports/scan.json'), 'utf8');

    edit('again');
    const second = stop().reason;
    expect(runsOf('scan')).toBe(1);
    expect(second).toContain(`Reused:\nscan: REUSED\nStale: these results are from verified #${run.seq}, on an earlier tree, and were not\nmeasured again.\nRun it again on its own: \``);
    // The command wraps like any prose; the first run's result follows it.
    expect(second).toMatch(/\nRun it again on its own: `[^`]+`\.\nfindings \(exit 1\)\none finding\n/);
    expect(stored('scan')).toEqual([run, expect.objectContaining({ status: 'reused', source: expect.objectContaining({ seq: run.seq }), evidence: run.evidence })]);
    expect(readFileSync(join(ctx.repo, 'reports/scan.json'), 'utf8')).toBe(saved);
  });

  it('reruns once-per-plan checks and mutation under new rulebook bytes or a new baseline', () => {
    change();
    setChecks({ codeQuality: { scan: { command: counted('scan'), exitCodes: EXITS, runs: 'oncePerPlan' } } });
    setMutate(mutationCommand('measured', 0, [mutant('Killed')],
      `fs.appendFileSync(${JSON.stringify(join(ctx.home, 'mutation.runs'))}, 'x');`));
    const pass = expectedRuns => {
      expect(stop().reason).toContain('Verification passed');
      expect([runsOf('scan'), runsOf('mutation')]).toEqual([expectedRuns, expectedRuns]);
      return read(eventNamed('verified').at(-1));
    };
    const stale = (receipt, field) => {
      expect(phase()).toBe('converging');
      expect(prompt('record').hookSpecificOutput.additionalContext).toContain(`The ${field} changed`);
      expect(submitText(receipt.seq, 'earlier analysis').stderr).toContain('not the current receipt');
      expect(eventNamed('declared')).toHaveLength(0);
    };
    const first = pass(1);
    edit('exercise this code');
    const second = pass(1);
    expect(second.payload.treeFingerprint).not.toBe(first.payload.treeFingerprint);
    expect(second.payload.results.find(result => result.name === 'scan').source.seq).toBe(first.seq);
    expect(second.payload.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'mutation').source.seq).toBe(first.seq);

    appendFileSync(join(ctx.repo, '.katatay/rulebook.json'), '\n');
    stale(second, 'rulebook');
    const third = pass(2);
    expect(third.payload.treeFingerprint).toBe(second.payload.treeFingerprint);
    expect(readBaseline(third.payload.baseline)).toBe(readBaseline(second.payload.baseline));
    expect(third.payload.rulebookFingerprint).not.toBe(second.payload.rulebookFingerprint);

    git('commit', '--quiet', '--allow-empty', '-m', 'advance the target with the same files');
    publish();
    prompt('continue'); // lets the referee record the target now merged into this branch
    stale(third, 'baseline');
    const fourth = pass(3);
    expect(fourth.payload.treeFingerprint).toBe(third.payload.treeFingerprint);
    expect(fourth.payload.rulebookFingerprint).toBe(third.payload.rulebookFingerprint);
    expect(readBaseline(fourth.payload.baseline)).toBe(git('rev-parse', 'HEAD').trim());
    expect(readBaseline(fourth.payload.baseline)).not.toBe(readBaseline(third.payload.baseline));
  });

});
