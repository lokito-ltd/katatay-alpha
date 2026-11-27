/**
 * The guard is tested as a decision, never by letting it fail.
 *
 * The only faithful end-to-end case would spawn `turn-end.mjs` at this
 * repository from inside this suite — which is the runaway itself, and if the
 * guard were wrong the suite would start the suite, as it did on the afternoon
 * that produced this guard. So the decision takes every input as a parameter
 * and is exercised here, and the structural case at the bottom covers the one
 * thing that cannot be: that `turn-end.mjs` asks before it acts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OWN_REPO, runaway } from './runaway.mjs';

const FIXTURE = '/tmp/some-fixture-repo';

describe('a hook spawned from inside a test run', () => {
  it('refuses when a test runner has pointed it at its own repository', () => {
    expect(runaway(OWN_REPO, OWN_REPO, { VITEST: 'true' })).toMatch(/spawned from inside a test run/);
  });

  it('refuses on TEST as well as VITEST, and names the one it saw', () => {
    expect(runaway(OWN_REPO, OWN_REPO, { TEST: 'true' })).toContain('TEST is set');
    expect(runaway(OWN_REPO, OWN_REPO, { VITEST: 'true' })).toContain('VITEST is set');
  });

  it('says what would have happened, not just that it stopped', () => {
    const reason = runaway(OWN_REPO, OWN_REPO, { VITEST: 'true' });
    expect(reason).toContain('Nothing was read, recorded or run');
    expect(reason).toMatch(/harness/);
    expect(reason).toContain('would append to the real logbook and have the referee run the real verify, which starts the suite that spawned it.');
  });

  // The case the environment alone cannot get right. These spawns are the
  // contract the machine suite exists to test, and they all carry VITEST.
  it('allows a test run that gave the hook a fixture repository', () => {
    expect(runaway(FIXTURE, OWN_REPO, { VITEST: 'true' })).toBeNull();
  });

  it('allows a real turn, which is always at its own repository', () => {
    expect(runaway(OWN_REPO, OWN_REPO, {})).toBeNull();
  });

  it('does not care about a trailing separator', () => {
    expect(runaway(`${OWN_REPO}/`, OWN_REPO, { VITEST: 'true' })).toMatch(/test run/);
  });

});

describe('turn-end.mjs', () => {
  const source = readFileSync(new URL('./turn-end.mjs', import.meta.url), 'utf8');

  /**
   * Structural, and it is the substitute for the case that cannot be written.
   * What matters is not that the guard is called but that nothing happens
   * first. The hook records nothing and runs nothing itself: `ask` starts the
   * referee's `on turn-end`, which writes to the logbook and starts the suite, so an
   * `ask` before the check would be the whole failure.
   */
  it('asks the guard before it records anything or shells out', () => {
    const asks = source.indexOf('runaway()');
    expect(asks).toBeGreaterThan(-1);

    // The call and not its argument: Stryker rewrites the string literals of
    // the files it mutates, so `ask('turn-end'` is not in the source it runs.
    const shellsOut = source.indexOf('ask(');
    expect(shellsOut, 'the hook no longer asks the referee').toBeGreaterThan(-1);
    expect(shellsOut, 'the referee is asked before the guard').toBeGreaterThan(asks);
    // Nothing that records or starts a process may come back into the hook.
    for (const acts of ['append(', 'runReferee(', 'spawnSync(']) {
      expect(source.includes(acts), `${acts} is back in the hook`).toBe(false);
    }
  });
});
