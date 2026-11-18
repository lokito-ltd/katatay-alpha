import { readBaseline } from '../../src/workflow/phase.mjs';
import { mutationCommand } from '../fixtures/workflow/mutation-report.mjs';
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { submitFixtureAnalysis, ctx, approvePlan, events, git, machineFixture, phase, setCoverage, setMutate, setVerify, triage, reportedChangeFile } from '../support/machine/harness.mjs';
import { eventNamed, read, serverDown, targetGainsATest } from '../support/machine/baselines.mjs';
import { writeJUnitSnapshot } from '../../src/workflow/junit-snapshot.mjs';
import { append } from '../../src/workflow/chain.mjs';
import { mutationReferences, resultNamed } from '../../src/workflow/result-readers.mjs';
import { GUARD, VERIFY } from '../../src/workflow/moments/turn-end.mjs';
import { started, write, edit, said, codes, message, asked, prompt, approval, approve, turnEnd, realVerify, triageReply, goesOn, ends, allowed, put, breakLog, TEST_ONLY, treeNow } from '../support/workflow/deciding.mjs';

const verifiedChange = machineFixture({ verified: true });

describe('on write, decided', () => {
  it('denies a write before a plan, and allows it after', () => {
    expect(write(edit()).allow).toBe(false);
    expect(codes(write(edit()))).toEqual(['needs_plan/agent']);
    approvePlan();
    expect(write(edit())).toEqual(allowed);
  });
});

describe('on prompt, decided', () => {
  it('records a reset, and refuses one into a broken logbook', () => {
    expect(prompt('reset: over')).toMatch(/^The operator reset the workflow/);
    expect(events().at(-1)).toMatch(/__reset\.json$/);
    approvePlan();
    breakLog();
    expect(prompt('reset')).toMatch(/^Refused to record `reset`: the state chain is broken/);
    expect(codes(asked('reset'))).toEqual(['stop/operator', 'state/agent']);
  });

  it('refuses `record` before verification, and into a broken logbook', () => {
    approvePlan();
    expect(prompt('record')).toMatch(/typed `record`, but it was not recorded\. The change is implementing/);
    breakLog();
    expect(prompt('record')).toMatch(/^Refused to record `record`: the state chain is broken/);
  });

  it('records `record` on a verified tree', () => {
    verifiedChange();
    const answer = asked('record');
    expect(codes(answer)).toEqual(['declared/operator', 'state/agent']);
    const context = said(answer, '\n');
    // The change summary comes first, linked to the declaration, then the
    // agent's instructions.
    expect(context).toMatch(/^Show the operator this change summary verbatim, first in your reply:\n\nChange declared\./);
    expect(context).toContain(`\nDetails: ${relative(ctx.repo, join(ctx.logbook, eventNamed('declared')[0]))}\n`);
    expect(context).toMatch(/\nThe operator declared this change finished\. Write the change file now\./);
    expect(phase()).toBe('declared');
  });

  it('holds an uncovered line on first verify and declares on the first record after a test edit and reverify', () => {
    approvePlan();
    const file = 'modules/feature.mjs';
    put(file, 'export const enabled = true;\n');
    triage();
    setCoverage({ [file]: { total: 1, uncovered: [1] } });
    realVerify(900);
    submitFixtureAnalysis('Coverage modules/feature.mjs:1\nScenario: Import the exported flag.\nAssert: Its value matches the configured default.');
    expect(codes(asked('record'))).toContain('held/operator');

    put('feature.test.mjs', "import assert from 'node:assert/strict';\nimport { enabled } from './modules/feature.mjs';\nassert.equal(enabled, true);\n");
    expect(prompt('record')).toContain('Verify the edited tests');
    realVerify(900);
    submitFixtureAnalysis('Coverage modules/feature.mjs:1\nScenario: Import the exported flag.\nAssert: Its value matches the configured default.');
    const answer = asked('record');
    expect(codes(answer)).toContain('declared/operator');
    expect(answer.messages[0].text).toContain('\n\nChange declared. Tests changed since the verification before, so the gaps do not hold it.\n');
    expect(read(eventNamed('declared')[0]).payload.gaps.uncoveredLines).toBe(1);
  });

  it('refuses repeated declarations when a stored verification is missing results', () => {
    verifiedChange();
    const [file] = eventNamed('verified');
    const receipt = read(file);
    delete receipt.payload.results;
    writeFileSync(join(ctx.logbook, file), JSON.stringify(receipt));
    for (let i = 0; i < 2; i++) {
      expect(prompt('record')).toMatch(/state chain is broken[\s\S]*results is missing/);
      expect(phase()).toBe('broken');
    }
    expect(eventNamed('declared')).toHaveLength(0);
  });

  it('refuses repeated declarations with JUnit evidence from another branch', () => {
    verifiedChange();
    const receipt = read(eventNamed('verified')[0]).payload;
    const elsewhere = writeJUnitSnapshot('other', [{ name: 'reports/junit/run.xml', bytes: Buffer.from('<testsuites/>') }], ctx.repo);
    const tests = receipt.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'tests');
    tests.evidence.find(item => item.role === 'raw').snapshot = elsewhere[0].snapshot;
    append(ctx.logbook, 'verified', receipt, 'feat/x');
    for (let i = 0; i < 2; i++) {
      expect(prompt('record')).toContain('invalid JUnit XML reference');
      expect(phase()).toBe('verified');
    }
    expect(eventNamed('declared')).toHaveLength(0);
  });

  it('refuses every record while the verified JUnit evidence is unreadable', () => {
    verifiedChange();
    const tests = read(eventNamed('verified')[0]).payload.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'tests');
    writeFileSync(join(ctx.repo, tests.evidence[0].snapshot), 'not a report');
    for (let i = 0; i < 2; i++) {
      const answer = asked('record');
      expect(codes(answer)).toEqual(['not_declared/operator', 'state/agent']);
      expect(said(answer)).toMatch(/Could not be read[\s\S]*verified JUnit:[\s\S]*digest mismatch/);
      expect(phase()).toBe('verified');
    }
    expect(eventNamed('record_held')).toHaveLength(0);
    expect(eventNamed('declared')).toHaveLength(0);
  });
});

describe('on plan-approved, decided', () => {
  it('returns a refusal to the operator without appending a logbook entry', () => {
    verifiedChange();
    prompt('record');
    put('requirements/changes/20260908T000000.000Z__x.md', reportedChangeFile());
    expect(goesOn(turnEnd())).toMatch(/^Recorded by/);
    const before = events();
    const refused = approval('# Plan\n\nNext.');
    expect(refused.recorded).toBe(false);
    expect(codes(refused)).toEqual(['refused/operator']);
    expect(said(refused)).toMatch(/already holds a recorded change/);
    expect(events()).toEqual(before);
  });
});

describe('on turn-end, decided', () => {
  it.each(['green', 'test-only'])('resumes %s triage once, then verifies an ordinary reply even without edits', (kind) => {
    approve(kind === 'test-only' ? TEST_ONLY : undefined);
    triage({ treeFingerprint: treeNow() });
    expect(goesOn(triageReply('reply'))).toContain('Continue the approved work now');
    expect(ends(triageReply('reply'))).toBe('');
    expect(eventNamed('convergence_requested')).toHaveLength(1);
    expect(started).toHaveLength(0);
    expect(phase()).toBe('converging');
    expect(ends(turnEnd(true))).toMatch(/(^|\n)Verification passed\.\n/);
    expect(started.filter(call => call.file === VERIFY)).toHaveLength(1);
  });

  it('leaves a failed verify one chance to request a fix after delivering red triage', () => {
    approve();
    setVerify(false);
    triage({ treeFingerprint: treeNow(), surprise: { failed: 1, total: 1, failures: ['a test failed'] } });
    expect(goesOn(triageReply('reply'))).toContain('Continue the approved work now');
    put('retry.test.mjs', '// first attempted fix');
    expect(ends(triageReply('reply'))).toBe('');
    expect(started).toHaveLength(0);
    expect(goesOn(turnEnd(true))).toContain('failed on the current working tree');
    expect(ends(turnEnd(true))).toContain('still fails');
    setVerify(true);
    expect(ends(turnEnd(true))).toMatch(/(^|\n)Verification passed\.\n/);
    expect(eventNamed('verify_failed')).toHaveLength(1);
    expect(started.filter(call => call.file === VERIFY)).toHaveLength(2);
  });

  it('does not let a refused triage or a reply from an earlier plan defer verification', () => {
    approve();
    append(ctx.logbook, 'triage_refused', { reason: 'typecheck_failed', files: ['src.ts'] }, 'feat/x');
    expect(codes(triageReply('refused'))).toEqual(['run_triage/agent']);
    expect(eventNamed('convergence_requested')).toHaveLength(0);
    triage({ treeFingerprint: treeNow() });
    expect(triageReply('old').keepWorking).toBe(true);
    approve('# Revised plan\nExtend the change.');
    triage({ treeFingerprint: treeNow() });
    expect(ends(triageReply('old'))).toMatch(/(^|\n)Verification passed\.\n/);
    expect(eventNamed('convergence_requested')).toHaveLength(1);
  });

  it('reports a green pre-change triage as planned under a test-only approval', () => {
    approve(TEST_ONLY);
    triage({ implemented: false });
    expect(ends(turnEnd(true))).toContain('on a tree with no implementation in it, as the plan said.');
  });

  it('passes, and lets the turn end with the triage and the result, after a refused stop too', () => {
    approve();
    triage({ implemented: false, surprise: { failed: 1, total: 2, failures: ['x.test.mjs — broke'], names: ['x.test.mjs — broke'] } });
    setVerify(true);
    expect(ends(turnEnd(true))).toMatch(/^Triage of plan's missed predictions and test regressions, on a tree with no implementation in it\.[\s\S]*Risk: LOW[\s\S]*1 surprise[\s\S]*\nx\.test\.mjs — broke\n[\s\S]*Details: [^\n]+__triaged\.json\n\nVerification passed\.\n/);
    expect(phase()).toBe('verified');
    // The reminder tells the agent to tell the operator. For the operator, an
    // adapter that refuses a stop to deliver a pass would refuse every stop
    // in this phase.
    const reminder = turnEnd();
    expect(codes(reminder)).toEqual(['verified/agent']);
    expect(ends(reminder)).toMatch(/^Verification passed on this working tree\. Tell the operator\./);
  });

  it('skips mutation testing without its whole limit, and runs it when the time is there', () => {
    approve();
    put('feature.mjs', 'export const on = true;\n');
    triage();
    setVerify(true);
    expect(ends(realVerify(100))).toContain('Mutation testing deferred');
    put('another.test.mjs', '// another pass\n');
    expect(ends(realVerify(900))).toMatch(/\nmutation: (PASSED|FINDINGS|PARTIAL)\n/);
    const receipt = read(eventNamed('verified').at(-1)).payload;
    const mutation = resultNamed(receipt.results, 'mutation');
    const run = JSON.parse(readFileSync(join(ctx.repo, mutationReferences(mutation).findings), 'utf8'));
    expect(receipt.treeFingerprint).toBe(treeNow());
    expect(mutation).toMatchObject({ status: 'ok', summary: { unproved: 0, errored: 0 } });
    expect(run).toMatchObject({ result: { exitCode: 0, outcome: 'clean' }, measurement: { toolOutcome: 'clean', findings: { counts: { total: 0, survived: 0 }, survivors: [] } } });
  });

  describe('once the operator has declared the change', () => {
    const changeFile = 'requirements/changes/20260908T000000.000Z__x.md';

    it('asks for the change file, and refuses one the guard rejects', () => {
      verifiedChange();
      prompt('record');
      expect(codes(turnEnd())).toEqual(['change_file/agent']);
      expect(goesOn(turnEnd())).toMatch(/no change file records it\. Write one under `requirements\/changes\/`/);
      put(changeFile, '---\n---\n\n# X\n');
      const refused = turnEnd();
      expect(codes(refused)).toEqual(['change_file/agent']);
      expect(goesOn(refused)).toMatch(/`workflow req guard` failed on the change file/);
    });

    // News for the operator, not work: nothing the agent does makes the server
    // answer, and the next turn end tries again.
    it('waits while the server does not answer, and lets the turn end', () => {
      verifiedChange();
      prompt('record');
      put(changeFile, reportedChangeFile());
      serverDown();
      const waiting = turnEnd();
      expect(codes(waiting)).toEqual(['info/operator']);
      expect(ends(waiting)).toMatch(/The change stays declared: its baseline is not proved/);
      expect(phase()).toBe('declared');
    });

    // Before `record` the approved plan can stand in for a change file. Here it
    // must not, and `--record` is what tells the guard so. The guard's own cases
    // prove what the flag does; this proves the turn end passes it.
    it('runs the guard in record mode, where only a change file accounts for a change', () => {
      verifiedChange();
      prompt('record');
      put(changeFile, reportedChangeFile());
      turnEnd();
      expect(started.filter((s) => s.file === GUARD)).toEqual([{ file: GUARD, args: ['--record'] }]);
    });

    it('records the change, stages everything, and asks for the commit message', () => {
      verifiedChange();
      prompt('record');
      put(changeFile, reportedChangeFile());
      // After a refused stop it cannot ask for more work, so the operator gets
      // the change summary and is told to type `record` for the message.
      const recorded = turnEnd(true);
      expect(codes(recorded)).toEqual(['recorded/operator']);
      expect(ends(recorded)).toMatch(/^Recorded by requirements\/changes\/20260908T000000\.000Z__x\.md[\s\S]*Change declared on this tree\.[\s\S]*Type `record` to have the agent write the commit message\. Nothing is committed without your yes\.$/);
      expect(git('diff', '--cached', '--name-only')).toContain(changeFile);
    });

    it('refuses a baseline the server\'s target never had', () => {
      verifiedChange();
      prompt('record');
      put(changeFile, reportedChangeFile());
      // The server's target replaced by a commit with no history in common.
      const orphan = git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'unrelated').trim();
      git('push', '--quiet', '--force', 'origin', `${orphan}:refs/heads/main`);
      const refused = turnEnd();
      expect(codes(refused)).toEqual(['stop/operator']);
      expect(goesOn(refused)).toMatch(/cannot be recorded: these baselines are not on origin\/main as the server has it/);
      expect(events().some((e) => e.endsWith('__recorded.json'))).toBe(false);
    });
  });
});

/*
 * What mutation testing showed no case above would notice: a message cut
 * short, a branch taken when it should not be, a field left out of an event.
 * Each case below fails if one of those comes back.
 */

/** The current working-tree fingerprint, as the moments see it. */

describe('on prompt, said in full', () => {
  it('says the baseline moved when the target was merged into the branch', () => {
    approve();
    const pinned = readBaseline(read(events()[0]).payload.baseline);
    targetGainsATest();
    git('merge', '--quiet', '--no-edit', 'origin/main');
    const context = prompt('hello');
    const to = git('rev-parse', 'origin/main').trim();
    expect(context).toMatch(new RegExp(`^The target was merged into this branch, so the baseline moved forward from ${pinned.slice(0, 12)} to ${to.slice(0, 12)}\\.\nworkflow: implementing`));
    expect(eventNamed('baseline_moved')).toHaveLength(1);
  });
});

describe('on plan-approved, said in full', () => {
  it('tells the operator how to proceed after refusing a second plan', () => {
    verifiedChange();
    prompt('record');
    put('requirements/changes/20260908T000000.000Z__x.md', reportedChangeFile());
    turnEnd();
    expect(approve('# Plan\n\nNext.')).toBe(
      'The plan was approved, but not recorded: this branch already holds a recorded change, and a branch holds one change until it merges. '
        + 'Merge it first and start the next change after the merge, or have the operator type `reset`. '
        + 'A fix to the recorded change needs no new plan: edit, and it goes back to converging.',
    );
  });
});

describe('on turn-end, said in full', () => {

  describe('mutation testing', () => {
    const codeChange = () => {
      approve();
      put('feature.mjs', 'export const on = true;\n');
      triage();
      setVerify(true);
    };

    it('asks the command for the rulebook\'s whole limit, and records what it said', () => {
      codeChange();
      const asked = join(ctx.home, 'asked.json');
      setMutate(mutationCommand('0 mutants.', 0, [], `fs.writeFileSync(${JSON.stringify(asked)}, fs.readFileSync(0));`));
      realVerify(900);
      expect(JSON.parse(readFileSync(asked, 'utf8')).budget).toBe(240);
      const receipt = read(eventNamed('verified').at(-1)).payload;
      const mutation = resultNamed(receipt.results, 'mutation');
      const run = JSON.parse(readFileSync(join(ctx.repo, mutationReferences(mutation).findings), 'utf8'));
      expect(receipt.treeFingerprint).toBe(treeNow());
      expect(mutation.status).toBe('ok');
      expect(run).toMatchObject({ result: { exitCode: 0, text: expect.stringContaining('Mutation testing') } });
    });

    // A word nobody said must not decide whether the change is held.
    it('stores no outcome when the command died before it could answer', () => {
      codeChange();
      setMutate('kill -TERM $$');
      expect(said(realVerify(900))).toContain('failed at mutation');
      expect(eventNamed('verified')).toHaveLength(0);
    });
  });

  describe('once the operator has declared the change, said in full', () => {
    const changeFile = 'requirements/changes/20260908T000000.000Z__x.md';
    const declare = (body) => {
      verifiedChange();
      prompt('record');
      put(changeFile, body ?? reportedChangeFile());
    };

    it('passes on why the guard refused the change file', () => {
      declare('---\n---\n\n# X\n');
      const block = goesOn(turnEnd());
      expect(block).toMatch(/^`workflow req guard` failed on the change file, so nothing was recorded\.\n\nFix the change file so it tells the truth about the branch\.\n\n/);
      expect(block).toContain('Departures');
    });

    it('records which change files account for it, and asks for the commit message', () => {
      declare();
      const answered = turnEnd();
      expect(answered).toEqual({ version: 1, keepWorking: true, messages: [message('recorded', 'agent', expect.any(String))] });
      const [{ text }] = answered.messages;
      // The change summary rides along, in case the agent did not show it at `record`.
      expect(text.startsWith(`Recorded by ${changeFile}. The merge is the operator's.\n\n`
        + 'If this change summary is not already in the chat, show it to the operator verbatim:\n\n'
        + 'Change declared on this tree. This is the report recorded with that decision.\n')).toBe(true);
      expect(text).toMatch(/\nDetails: \.katatay\/state\/[^\n]*__declared\.json\n/);
      expect(text.endsWith('\n\nEvery file is staged, the `recorded` event included. Write the commit message now, show it in full, and commit only on the operator\'s yes.')).toBe(true);
      const [recorded] = eventNamed('recorded');
      expect(read(recorded).payload).toMatchObject({ files: [changeFile], treeFingerprint: treeNow() });
    });

    it('names the server\'s tip and the baselines it does not have', () => {
      declare();
      const baseline = readBaseline(read(eventNamed('plan_approved')[0]).payload.baseline);
      const orphan = git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'unrelated').trim();
      git('push', '--quiet', '--force', 'origin', `${orphan}:refs/heads/main`);
      expect(goesOn(turnEnd())).toBe(
        `The change cannot be recorded: these baselines are not on origin/main as the server has it (tip ${orphan.slice(0, 12)}):\n\n`
          + `  ${baseline}\n\n`
          + 'The change was measured from a commit the target never had, so its freeze and triage were measured from the wrong place. Stop and tell the operator.',
      );
    });
  });
});
