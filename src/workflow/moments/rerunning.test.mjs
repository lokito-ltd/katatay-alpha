import { readBaseline } from '../phase.mjs';
/** `workflow verify --rerun`, decided in process: when it refuses, what it
 *  records, and what the next turn end makes of it. The fixture and the fake
 *  verify are the fast deciding tests'. `tests/machine/rerunning.test.mjs`
 *  walks the same through real processes. */
import { describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, git, machineFixture, setVerify, triage } from '../../../tests/support/machine/harness.mjs';
import { eventNamed, read, targetGainsATest } from '../../../tests/support/machine/baselines.mjs';
import { createHash } from 'node:crypto';
import { onTurnEnd, VERIFY } from './turn-end.mjs';
import { rerunVerify, PASSED, FAILED, REFUSED } from '../rerun.mjs';
import { inFixture, referee, started, approve, turnEnd, said, codes, goesOn, ends, breakLog, put } from '../../../tests/support/workflow/deciding.mjs';

machineFixture();

const rerun = (env = {}) => inFixture(() => rerunVerify({ env, referee }));
const verifies = () => started.filter((run) => run.file === VERIFY).length;
const verifyArgs = () => started.find((run) => run.file === VERIFY).args;
const FINISHED = ' Tell the operator. The change is finished only when they say so: they type `record`, and the change file is written after that.';

describe('verify --rerun, refused', () => {
  it('refuses under CI=true, and records nothing', () => {
    approve();
    triage();
    setVerify(true);
    const answer = rerun({ CI: 'true' });
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/refused, and recorded nothing: `CI=true`/);
    expect(verifies()).toBe(0);
    expect(eventNamed('verified')).toHaveLength(0);
  });

  it('refuses before the triage, while the implementation is still being written', () => {
    approve();
    const answer = rerun();
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/the phase is `implementing`/);
    expect(verifies()).toBe(0);
    expect(eventNamed('verify_failed')).toHaveLength(0);
  });

  it('refuses once the tree is verified, as there is nothing to rerun', () => {
    approve();
    triage();
    turnEnd();
    const answer = rerun();
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/the phase is `verified`/);
    expect(eventNamed('verified')).toHaveLength(1);
  });

  it('refuses when the implementation changed after the triage, and starts no verify', () => {
    approve();
    put('feature.mjs', 'export const on = true;\n');
    triage();
    put('feature.mjs', 'export const on = false;\n');
    const answer = rerun();
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/refused, and recorded nothing: The implementation changed after triage\./);
    expect(verifies()).toBe(0);
    expect(eventNamed('verified')).toHaveLength(0);
  });

  // Verify can take minutes. A pass measured on a tree that moved meanwhile
  // describes neither tree.
  it('refuses to record a pass when the tree changed while verify ran', () => {
    approve();
    triage();
    const editing = (file, args, options) => {
      if (file === VERIFY) put('during.test.mjs', '// written while verify ran\n');
      return referee(file, args, options);
    };
    const answer = inFixture(() => rerunVerify({ env: {}, referee: editing }));
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/refused, and recorded nothing: The working tree or approval changed during verify\. Run verification again\.$/);
    expect(eventNamed('verified')).toHaveLength(0);
  });

  it('refuses a rerun pass when rulebook whitespace changed during verify', () => {
    approve();
    triage();
    const editing = (file, args, options) => {
      const result = referee(file, args, options);
      if (file === VERIFY) appendFileSync(join(ctx.repo, '.katatay/rulebook.json'), '\n');
      return result;
    };
    const answer = inFixture(() => rerunVerify({ env: {}, referee: editing }));
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toContain('The rulebook changed during verify');
    expect(eventNamed('verified')).toHaveLength(0);
    expect(eventNamed('verify_failed')).toHaveLength(0);
  });

  it('refuses on a broken logbook', () => {
    approve();
    breakLog();
    const answer = rerun();
    expect(answer.status).toBe(REFUSED);
    expect(said(answer)).toMatch(/state chain is broken/);
    expect(verifies()).toBe(0);
  });
});

describe('verify --rerun, recorded', () => {
  it('records a pass as a rerun, and says so to the operator', () => {
    approve();
    triage();
    const answer = rerun();
    expect(answer.status).toBe(PASSED);
    expect(codes(answer)[0]).toBe('verified/operator');
    expect(said(answer)).toMatch(/^Verification passed\.\n\nWarnings:\nThis run came from `workflow verify --rerun`, not from a turn end\. It ran in\nthe shell of whoever started it/);
    const [receipt] = eventNamed('verified');
    expect(read(receipt).payload.trigger).toBe('rerun');
  });

  it('records a failure as a rerun, and the next turn end repeats it without verifying', () => {
    approve();
    triage();
    setVerify(false);
    const answer = rerun();
    expect(answer.status).toBe(FAILED);
    expect(codes(answer)).toEqual(['verify_failed/operator', 'info/agent']);
    expect(said(answer)).toMatch(/a test failed/);
    const [failure] = eventNamed('verify_failed');
    expect(read(failure).payload.trigger).toBe('rerun');
    const runs = verifies();
    const repeated = turnEnd();
    expect(goesOn(repeated)).toMatch(/still fails/);
    // The rerun and the turn end show one summary, read from the same event:
    // the same failures and the same link, each with its own warning.
    const failures = (text) => text.slice(text.indexOf('Failures:'), text.indexOf('\n\nWarnings:'));
    const [rerunSummary, turnEndSummary] = [answer.messages[0].text, repeated.messages[0].text];
    expect(failures(turnEndSummary)).toBe(failures(rerunSummary));
    expect(turnEndSummary.split('\n').at(-1)).toBe(rerunSummary.split('\n').at(-1));
    expect(rerunSummary).toContain('This run came from `workflow verify --rerun`');
    expect(turnEndSummary).toContain('Verify was not run again');
    expect(verifies()).toBe(runs);
    expect(eventNamed('verify_failed')).toHaveLength(1);
  });

  it('lets the next turn end take a rerun pass without verifying again, and name it', () => {
    approve();
    triage();
    rerun();
    const runs = verifies();
    const text = ends(turnEnd());
    expect(verifies()).toBe(runs);
    expect(text.startsWith('Verification passed on this working tree. The pass came from `workflow verify --rerun`, not from a turn end: say so.' + FINISHED)).toBe(true);
  });

  it('leaves the trigger off the turn end\'s own events', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    expect(read(eventNamed('verify_failed')[0]).payload).not.toHaveProperty('trigger');
    setVerify(true);
    turnEnd();
    expect(read(eventNamed('verified')[0]).payload).not.toHaveProperty('trigger');
    const text = ends(turnEnd());
    expect(text.startsWith('Verification passed on this working tree.' + FINISHED)).toBe(true);
    expect(text).not.toMatch(/--rerun/);
  });

  it('points at the rerun when the turn end will not verify an unchanged failure', () => {
    approve();
    triage();
    setVerify(false);
    turnEnd();
    expect(goesOn(turnEnd())).toMatch(/If the cause lay outside the working tree, such as the network or the environment, and is fixed now, run `workflow verify --rerun` to verify again and record the result\.$/);
  });
});

describe('verify --rerun, as it starts verify', () => {
  // A hand run has no turn end waiting on it, so verify gets no deadline.
  it('gives verify a results file and no deadline', () => {
    approve();
    triage();
    rerun();
    expect(verifyArgs()).toEqual(['--results', expect.stringMatching(/workflow-checks-.*\.json$/)]);
  });

  it('catches up a target merged in since the last turn, and verifies from the new baseline', () => {
    approve();
    triage();
    targetGainsATest();
    git('merge', '--quiet', '--no-edit', 'origin/main');
    const answer = rerun();
    expect(eventNamed('baseline_moved')).toHaveLength(1);
    expect(answer.status, said(answer)).toBe(PASSED);
    expect(eventNamed('verified')).toHaveLength(1);
  });

  // The output is cut for the message and again for the logbook, from the
  // end, with the blank lines around it dropped first.
  it('keeps the last 40 lines of a failure for the message, and the last 20 for the logbook', () => {
    approve();
    triage();
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const failing = (file, args, options) => (file === VERIFY
      ? { status: 1, stdout: `\n\n${lines.join('\n')}\n\n`, stderr: '' }
      : referee(file, args, options));
    const answer = inFixture(() => rerunVerify({ env: {}, referee: failing }));
    expect(answer.status).toBe(FAILED);
    expect(said(answer).endsWith(`green.\n\n${lines.slice(20).join('\n')}`)).toBe(true);
    expect(read(eventNamed('verify_failed')[0]).payload.tail).toBe(lines.slice(40).join('\n'));
  });
});

describe('the turn end, as it starts verify', () => {
  // Mutation testing budgets its run against this deadline.
  it('records a failure under the starting rulebook and retries under the edited bytes', () => {
    approve();
    triage();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const fingerprint = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const startingHash = fingerprint();
    const baseline = readBaseline(read(eventNamed('plan_approved')[0]).payload.baseline);
    const failing = file => {
      expect(file).toBe(VERIFY);
      appendFileSync(path, '\n');
      return { status: 1, stderr: 'a check failed' };
    };
    inFixture(() => onTurnEnd({ stopRefusedBefore: false, secondsLeft: 900 }, { referee: failing }));
    const failure = read(eventNamed('verify_failed')[0]);
    expect(failure.payload).toMatchObject({ baseline, rulebookFingerprint: startingHash });
    expect(fingerprint()).not.toBe(startingHash);
    turnEnd();
    expect(read(eventNamed('verified')[0]).payload).toMatchObject({
      treeFingerprint: failure.payload.treeFingerprint, baseline, rulebookFingerprint: fingerprint(),
    });
  });

  it('gives verify the time the turn end has left as an absolute deadline', () => {
    approve();
    triage();
    const before = Date.now();
    turnEnd(false, 900);
    const after = Date.now();
    const args = verifyArgs();
    const deadline = Number(args[args.indexOf('--deadline') + 1]);
    expect(deadline).toBeGreaterThanOrEqual(Math.floor(before + 900_000));
    expect(deadline).toBeLessThanOrEqual(after + 900_000);
  });

  it('lists a file that gains a check\'s suppression comment where review should look', () => {
    approve();
    put('modules/quiet.mjs', 'export const x = 1; // eslint-disable-line\n');
    triage();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.codeQuality = { lint: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' }, suppressions: ['eslint-disable'] } };
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    expect(ends(turnEnd())).toMatch(/\nReview:\n[\s\S]*New suppressions of the lint check\. Each silences it where it sits\.\n- modules\/quiet\.mjs\n/);
  });
});
