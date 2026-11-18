/** Two places the machine used to let something through without saying so: an
 *  edit made before the approval that the approval never named, and a gate
 *  that allowed the edit whenever it could not read the state.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ctx, cli, machineFixture, approvePlan, events, git, phase, show,
} from '../support/machine/harness.mjs';
import { write } from '../support/machine/baselines.mjs';

machineFixture();

/**
 * The approval used to find this work with `git diff <baseline> HEAD`, which
 * compares two commits. An edit made through the shell before the approval is
 * usually in neither, and when it falls in the same turn as the approval no
 * turn-end hook runs between them to warn about the dirty tree.
 */
describe('work already in the tree when the plan is approved', () => {
  it('names an edit that was never committed', () => {
    write('source.txt', 'changed before any plan\n');
    const decision = approvePlan();
    expect(decision.systemMessage).toMatch(/Plan approval recorded/);
    expect(decision.systemMessage).toMatch(/already changes 1 file\(s\) that are not on origin\/main: source\.txt/);
    expect(decision.systemMessage).toMatch(/committed or not, counts as this change's/);
  });

  it('names an edit that was staged and never committed', () => {
    write('source.txt', 'changed before any plan\n');
    git('add', 'source.txt');
    expect(approvePlan().systemMessage).toMatch(/already changes 1 file\(s\) that are not on origin\/main: source\.txt/);
  });

  it('names a file git has not been told about', () => {
    write('stray.txt', 'written before any plan\n');
    expect(approvePlan().systemMessage).toMatch(/already changes 1 file\(s\) that are not on origin\/main: stray\.txt/);
  });

  it('names committed and uncommitted work together, as one list', () => {
    write('source.txt', 'changed before any plan\n');
    git('commit', '--quiet', '-am', 'work from another branch');
    write('stray.txt', 'written before any plan\n');
    const said = approvePlan().systemMessage;
    expect(said).toMatch(/already changes 2 file\(s\)/);
    expect(said).toMatch(/source\.txt/);
    expect(said).toMatch(/stray\.txt/);
  });

  // Parked work is open to edit in any phase and is no part of a change.
  it('does not name FOLLOW-UPS.md', () => {
    write('FOLLOW-UPS.md', '# Follow-ups\n\n- Something for later.\n');
    const decision = approvePlan();
    expect(decision.systemMessage).toMatch(/Plan approval recorded/);
    expect(decision.systemMessage).not.toMatch(/already changes/);
  });

  it('says nothing on a clean tree', () => {
    expect(approvePlan().systemMessage).not.toMatch(/already changes/);
  });

  // By then the tree holds this change's own work, which is exactly what the
  // list would be.
  it('says nothing when a revised plan is approved', () => {
    approvePlan();
    write('source.txt', 'this change\n');
    const decision = approvePlan({ plan: '# Plan\n\nRevised.' });
    expect(decision.systemMessage).toMatch(/replaces the earlier approved plan/);
    expect(decision.systemMessage).not.toMatch(/already changes/);
  });
});

/**
 * Listing the logbook folder threw `ENOTDIR`. `state:show` and `state:verify`
 * crashed on it, and the gate allowed the edit.
 */
describe('a file where the logbook folder should be', () => {
  const logIsAFile = () => {
    rmSync(ctx.logbook, { recursive: true, force: true });
    mkdirSync(join(ctx.logbook, '..'), { recursive: true });
    writeFileSync(ctx.logbook, 'not a folder\n');
  };

  // A crash exits 1 as well, so the exit code alone would not tell a report
  // from a stack trace.
  it('is reported by state:verify, which no longer crashes on it', () => {
    logIsAFile();
    const verify = cli('verify.mjs');
    expect(verify.status).toBe(1);
    expect(verify.stderr).toMatch(/feat_x: .*cannot be read as a folder \(ENOTDIR\)/);
    expect(verify.stderr).not.toMatch(/scandir|^\s+at /m);
  });
});

/**
 * The one failure that still stays out of the way. A payload that is not JSON
 * names no tool and no path, so there is nothing to decide on, and every other
 * hook is broken by it in the same way.
 */
describe('a payload the gate cannot parse', () => {
  it('is let through, with nothing said', () => {
    if (!ctx.repo || !ctx.home) throw new Error('no fixture repository — refusing to run against the real one');
    const run = spawnSync('node', [resolve('src/agents/claude/hooks/pre-tool.mjs')], {
      cwd: ctx.repo, input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: ctx.home },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(events()).toEqual([]);
  });
});
