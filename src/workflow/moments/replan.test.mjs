import { expect, it } from 'vitest';
import { replan } from '../cli/replan.mjs';
import { onTurnEnd, VERIFY } from './turn-end.mjs';
import { rerunVerify } from '../rerun.mjs';
import { current } from '../state.mjs';
import { events, git, machineFixture, publish, reportedChangeFile, setVerify, triage } from '../../../tests/support/machine/harness.mjs';
import { approve, asked, breakLog, codes, inFixture, put, referee, said, started, triageReply, turnEnd } from '../../../tests/support/workflow/deciding.mjs';

const verifiedChange = machineFixture({ verified: true });

const request = (...args) => inFixture(() => replan(args));

it('resumes only the named request and can request another revision under the same approval', () => {
  approve();
  triage();
  for (const sequence of [3, 5]) {
    request();
    request();
    expect(inFixture(current).replan).toMatchObject({ seq: sequence, payload: { approval: 1 } });
    request('--resume');
    request('--resume');
    const state = inFixture(current);
    expect(state).toMatchObject({ phase: 'converging', replan: null });
    expect(state.entries.at(-1)).toMatchObject({ seq: sequence + 1, event: 'replan_resumed', payload: { request: sequence } });
  }
});

it('blocks record when the tree returns to a previously verified receipt during replanning', () => {
  verifiedChange();
  setVerify(false);
  request();
  setVerify(true);
  expect(inFixture(current).phase).toBe('verified');
  const before = events();
  expect(codes(asked('record'))).toContain('not_declared/operator');
  expect(codes(turnEnd())).toEqual(['info/agent']);
  expect(events()).toEqual(before);
  request('--resume');
  expect(inFixture(current)).toMatchObject({ phase: 'verified', replan: null });
});

it('checks the recorded epoch before the phase when an edited change requests replanning', () => {
  verifiedChange();
  asked('record');
  put('requirements/changes/20261113T000000.000Z__replan.md', reportedChangeFile());
  expect(codes(turnEnd())).toContain('recorded/agent');
  const before = events();
  setVerify(false);
  expect(inFixture(current).phase).toBe('converging');
  expect(() => request()).toThrow(/already holds a recorded change.*Merge it first.*operator type `reset`/);
  const refused = approve('# Plan\n\nRevise the recorded change.');
  expect(refused).toMatch(/already holds a recorded change.*Merge it first.*operator type `reset`/);
  expect(refused).toContain('A fix to the recorded change needs no new plan');
  expect(events()).toEqual(before);
});

it('keeps the test freeze during a revision before triage', () => {
  approve();
  request();
  expect(codes(turnEnd())).toEqual(['info/agent']);
  put('new.test.mjs', '// premature test\n');
  const frozen = turnEnd();
  expect(frozen.keepWorking).toBe(true);
  expect(codes(frozen)).toEqual(['frozen/agent']);
  expect(said(frozen)).toContain('new.test.mjs');
  expect(said(frozen)).toContain('A plan revision is pending');
  expect(started).toHaveLength(0);
  request('--resume');
  expect(inFixture(current)).toMatchObject({ phase: 'implementing', replan: null });
});

it('keeps the implementation freeze and starts no verify during a post-triage revision', () => {
  approve();
  triage();
  request();
  expect(triageReply('the triage report').keepWorking).toBe(false);
  expect(turnEnd().keepWorking).toBe(false);
  expect(turnEnd(true).keepWorking).toBe(false);
  put('source.txt', 'implementation drift\n');
  const drift = turnEnd();
  expect(codes(drift)).toContain('stop/operator');
  expect(said(drift)).toContain('The implementation changed after triage');
  const rerun = inFixture(() => rerunVerify({ env: {}, referee }));
  expect(rerun.status).toBe(2);
  expect(said(rerun)).toContain('A plan revision is pending');
  expect(asked('record').messages[0]).toMatchObject({ code: 'not_declared', text: expect.stringContaining('revision is pending') });
  expect(started).toHaveLength(0);
});

it.each([true, false])('discards an in-flight verify outcome after a revision request, passing=%s', passes => {
  approve();
  setVerify(passes);
  triage();
  const answer = inFixture(() => onTurnEnd({ stopRefusedBefore: false, secondsLeft: 900 }, {
    referee(file, args, options) {
      expect(file).toBe(VERIFY);
      const result = referee(file, args, options);
      replan([]);
      // Even a request resolved before the verifier returns interrupted the run.
      if (passes) replan(['--resume']);
      return result;
    },
  }));
  expect(said(answer)).toContain('A plan revision was requested during verification');
  expect(events().some(name => /__(verified|verify_failed)\.json$/.test(name))).toBe(false);
  expect(started).toHaveLength(1);
});

it.each(['reset', 'merge'])('ends a pending request with the change epoch on %s', action => {
  approve();
  request();
  if (action === 'reset') asked('reset');
  else {
    git('add', '.katatay/state');
    git('commit', '-qm', 'Carry the logbook to the target');
    publish();
  }
  expect(inFixture(current)).toMatchObject({ phase: 'open', replan: null });
  expect(() => request()).toThrow('This change is open');
  approve();
  expect(codes(turnEnd())).toEqual(['run_triage/agent']);
});

it('refuses malformed arguments and a broken logbook before appending a request', () => {
  approve();
  expect(() => request('--other')).toThrow('Usage: workflow replan [--resume]');
  expect(() => request('--resume', '--resume')).toThrow('Usage: workflow replan [--resume]');
  breakLog();
  const before = events();
  expect(() => request()).toThrow(/Restore the event files/);
  expect(events()).toEqual(before);
});
