
/** A change reaches `recorded` only once its baselines are proved on the
 *  server's target.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  submitFixtureAnalysis,
  ctx,
  cli,
  machineFixture,
  git,
  phase,
  prompt,
  stop,
  reportedChangeFile,
} from '../support/machine/harness.mjs';
import { eventNamed, head, write, serverDown, serverUp } from '../support/machine/baselines.mjs';

const verifiedChange = machineFixture({ verified: true });

describe('reaching recorded', () => {
  const writeChangeFile = () => write('requirements/changes/20260925T000000.000Z__x.md', reportedChangeFile());

  it('waits in declared while the server does not answer, and says why', () => {
    verifiedChange();
    prompt('record');
    writeChangeFile();
    serverDown();
    // News, not work: nothing the agent does makes the server answer, so the
    // stop is not refused, and the next turn end tries again.
    const decision = stop();
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/server behind origin\/main did not answer/);
    expect(phase()).toBe('declared');

    serverUp();
    stop();
    expect(phase()).toBe('recorded');
  });

  it('is refused for a baseline that is not on the server\'s target, and CI fails it too', () => {
    verifiedChange();
    // A baseline moved to the branch's own commit while the server was down.
    write('baseline.test.mjs', '// another commit\n');
    git('add', 'baseline.test.mjs');
    git('commit', '--quiet', '-m', 'this change');
    serverDown();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    prompt('hello');
    expect(eventNamed('baseline_moved')).toHaveLength(1);
    serverUp();

    // Verify and declare the tree as it now stands, so only the baseline is wrong.
    stop();
    submitFixtureAnalysis();
    prompt('record');
    writeChangeFile();
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/baselines are not on origin\/main as the server has it/);
    expect(decision.reason).toContain(head());
    expect(phase()).toBe('declared');

    // The same check CI runs, against a fresh fetch.
    execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: ctx.repo });
    const verify = cli('verify.mjs');
    expect(verify.status).toBe(1);
    expect(verify.stderr).toMatch(new RegExp(`baseline ${head()} is not on origin/main`));
  });
});
