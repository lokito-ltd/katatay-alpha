/** What happens when the operator types `record`: nothing is recorded or
 *  staged while the guard fails, and once it passes everything is staged and
 *  the commit message is asked for once.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvePlan, cli, ctx, machineFixture, events, git, phase, prompt, stop, reportedChangeFile, submitFixtureAnalysis, triage } from '../support/machine/harness.mjs';

const verifiedChange = machineFixture({ verified: true });

describe('the operator declares a change finished', () => {
  const changeFile = 'requirements/changes/20260908T000000.000Z__x.md';
  // A change file the real guard accepts, and one it refuses: it has no
  // `## Departures` section, and no `## Report`.
  const accepted = () => reportedChangeFile();
  const refused = '---\n---\n\n# X\n';
  const writeChangeFile = (body = accepted(), file = changeFile) => {
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(ctx.repo, file), body);
  };
  const recordChange = () => {
    prompt('record');
    writeChangeFile();
    stop();
    expect(phase()).toBe('recorded');
  };

  it('records nothing when the guard fails on the change file', () => {
    verifiedChange();
    prompt('record');
    writeChangeFile(refused);
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Departures');
    expect(events().some((e) => e.includes('recorded'))).toBe(false);
    expect(phase()).toBe('declared');
  });

  it('asks for the commit message on the turn that records, and only once', () => {
    verifiedChange();
    prompt('record');
    writeChangeFile();
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('commit-message');
    expect(stop({ stop_hook_active: true })?.decision).toBeUndefined();
    expect(stop()?.decision).toBeUndefined();
  });

  // The hook asks for the change file with a block, so the file arrives on
  // the stop after it. That stop used to check nothing, which left the change
  // declared until the operator's next message.
  it('records a change file written in answer to the block, on the same turn', () => {
    verifiedChange();
    prompt('record');
    expect(stop().reason).toMatch(/no change file/);
    writeChangeFile();
    const decision = stop({ stop_hook_active: true });
    expect(decision.decision).toBeUndefined();
    expect(phase()).toBe('recorded');
    expect(git('diff', '--cached', '--name-only').split('\n')).toContain(changeFile);
    // It cannot block to have Claude write the message, so it gives the
    // operator the change summary and tells them how to get the message.
    expect(decision.systemMessage).toContain('Change declared on this tree. This is the report recorded with that decision.');
    expect(decision.systemMessage).toMatch(/Type `record` to have the agent write the commit message\./);
  });

  // A lost handoff is recovered by typing `record` again. Declaring the same
  // tree twice used to add a `declared` event each time, and on a recorded
  // change it sent the phase back to `declared`.
  it('repeats the commit-message request on a record after recording, and adds nothing', () => {
    verifiedChange();
    recordChange();
    const before = events();
    const again = prompt('record').hookSpecificOutput.additionalContext;
    expect(again).toContain('Nothing new was declared');
    expect(again).toContain('Change declared on this tree. This is the report recorded with that decision.');
    expect(again).toMatch(/Write the commit message now[\s\S]*commit-message/);
    expect(events()).toEqual(before);
    expect(phase()).toBe('recorded');
  });

  it('repeats the report section on a record before the change file is written, and adds nothing', () => {
    verifiedChange();
    prompt('record');
    const before = events();
    const again = prompt('record').hookSpecificOutput.additionalContext;
    expect(again).toContain('Nothing new was declared');
    expect(again).toMatch(/Write the change file now[\s\S]*## Report/);
    expect(events()).toEqual(before);
    expect(phase()).toBe('declared');
  });

  // A `recorded` event vouches for the change files it names. Without them it
  // vouches for nothing, and the turn end used to write another one on top.
  describe('when a change file the recorded event names is gone', () => {
    it('writes nothing on top, and says how to mend it', () => {
      verifiedChange();
      recordChange();
      const before = events();
      rmSync(join(ctx.repo, changeFile));

      expect(phase()).toBe('broken');
      const decision = stop();
      expect(decision.decision).toBe('block');
      expect(decision.reason).toContain(`${changeFile}: named by`);
      expect(decision.reason).toContain('or the operator types `reset`');
      expect(events()).toEqual(before);
      const verify = cli('verify.mjs');
      expect(verify.status).toBe(1);
      expect(verify.stderr).toContain(`${changeFile}: named by`);
    });
  });

  // The case this change came from: a change recorded, reset, and a second
  // change recorded on top. The first change file belongs to the abandoned
  // change epoch, so deleting it leaves the second change as it was.
  it('leaves the next change recorded when a change file from before a reset is deleted', () => {
    verifiedChange();
    recordChange();
    prompt('reset: starting over');

    approvePlan({ plan: '# Plan\n\nChange source.txt again.' });
    triage();
    stop();
    submitFixtureAnalysis();
    prompt('record');
    const second = 'requirements/changes/20260909T000000.000Z__y.md';
    writeChangeFile(reportedChangeFile('Y'), second);
    stop();
    expect(phase()).toBe('recorded');
    const recorded = events().filter((e) => e.endsWith('__recorded.json')).at(-1);
    expect(JSON.parse(readFileSync(join(ctx.logbook, recorded), 'utf8')).payload.files).toEqual([second]);

    rmSync(join(ctx.repo, changeFile));
    expect(phase()).toBe('recorded');
  });
});
