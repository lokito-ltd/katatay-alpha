/** What the machine says about its own logbook, about its triage, and about a
 *  change nobody approved.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx,
  cli,
  machineFixture,
  approvedChange,
  events,
  git,
  prompt,
  show,
  stop,
  triage,
  userSettings,
} from '../support/machine/harness.mjs';

machineFixture({ approved: true });

/**
 * The triage counts are a record, and for a while nothing on the line said so.
 *
 * The operator read `surprise 4/317` as four tests failing right now, on a tree
 * the machine had already recorded as `verified`. The numbers are what the
 * suite looked like when the triage ran, which is the whole point of the phase.
 * This block is injected every turn, so the reading had to be closed.
 */
describe('the triage block in state:show', () => {
  it('says its counts are a record of when the triage ran', () => {
    approvedChange();
    triage({
      predicted: { failed: 2, total: 3 },
      surprise: { failed: 4, total: 317, failures: ['a.test.ts — x', 'a.test.ts — z', 'c.test.ts — x', 'd.test.ts — y'],
        names: ['a.test.ts — x', 'a.test.ts — z', 'c.test.ts — x', 'd.test.ts — y'] },
      overPredicted: { count: 1, total: 3, tests: ['b.test.ts — y'] },
    });

    const text = show();
    expect(text).toMatch(/triage\s+recorded \S+\. Its counts are the suite's as it stood then\.\n\s+Triage of plan's missed predictions and test regressions\.\n\n\s+Risk: LOW\n/);
    expect(text).toMatch(/\n\s+320 tests ran, 6 failed\n\s+predicted 2\/3 failed · 4 surprises \(133%\) · 1 over-prediction \(33%\)\n\n\s+Surprises:\n\s+a\.test\.ts — x\n/);
    expect(text).toMatch(/\n\s+Over-predictions:\n\s+b\.test\.ts — y\n/);
  });
});

/**
 * Claude Code merges the project's settings with files this repository does
 * not hold, and a session can write those through the shell. Nothing here can
 * stop that, so it is said out loud: by `state:verify`, by `state:show`, and
 * in the summary each turn starts with. `src/agents/claude/settings.test.mjs` covers what is
 * reported. These cases cover that the commands and the hook report it.
 */
describe('settings outside the repository', () => {
  const approves = { hooks: { PreToolUse: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'approve.sh' }] }] } };
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } };
  const acknowledge = (...hooks) => {
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.agent.adapters.claude.extraHooks.acknowledged = hooks;
    writeFileSync(path, JSON.stringify(config));
  };

  it('are not mentioned when they hold nothing unexpected', () => {
    userSettings({ outputStyle: 'Concise' });
    const { stdout, stderr } = cli('verify.mjs');
    expect(`${stdout}${stderr}`).not.toMatch(/settings\.json/);
    expect(show()).not.toMatch(/WARNING/);
  });

  it('state:verify warns about a hook in the user settings that can answer the plan dialog, and still passes', () => {
    userSettings(approves);
    const { stdout, stderr, status } = cli('verify.mjs');
    const said = `${stdout}${stderr}`;
    expect(said).toMatch(/WARNING — claude: ~\/\.claude\/settings\.json registers an extra PreToolUse hook on ExitPlanMode: `approve\.sh`/);
    expect(said).toMatch(/can answer the plan dialog/);
    // A warning, not a failure: only the operator can remove the hook.
    expect(status).toBe(0);
  });

  it('state:show carries the same warning', () => {
    userSettings(approves);
    expect(show()).toMatch(/^WARNING {4}claude: ~\/\.claude\/settings\.json registers an extra PreToolUse hook on ExitPlanMode/m);
  });

  it('the summary a turn starts with carries it, and asks for it to be passed on', () => {
    userSettings({ disableAllHooks: true });
    const said = prompt('carry on').hookSpecificOutput.additionalContext;
    expect(said).toMatch(/^settings: claude: ~\/\.claude\/settings\.json sets disableAllHooks.*Tell the operator\.$/m);
  });

  it('delivers one warning per command with the approval risk first and the acknowledgement advice once', () => {
    const events = ['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd',
      'SessionStart', 'Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit'];
    const registration = [{ hooks: [{ type: 'command', command: '/tools/cc-status' }] }];
    userSettings({ hooks: Object.fromEntries(events.map((event) => [event, registration])) });
    const said = prompt('carry on').hookSpecificOutput.additionalContext;
    expect(said.match(/settings: claude:/g)).toHaveLength(1);
    expect(said).toContain('~/.claude/settings.json has 10 extra hook registrations for `/tools/cc-status`');
    expect(said).toContain("Can affect plan approval: PermissionRequest, PreToolUse.\n  - Outside the workflow's gate: Notification, PostToolUse, SessionEnd, SessionStart, Stop, StopFailure, SubagentStop, UserPromptSubmit.");
    expect(said).toContain('runs for ExitPlanMode and can answer the plan dialog');
    expect(said.match(/extraHooks\.acknowledged/g)).toHaveLength(1);
  });

  it('the summary says nothing about settings when there is nothing to say', () => {
    expect(prompt('carry on').hookSpecificOutput.additionalContext).not.toMatch(/settings/);
  });

  it('warn about the local settings file, which git ignores', () => {
    mkdirSync(join(ctx.repo, '.claude'), { recursive: true });
    writeFileSync(join(ctx.repo, '.claude/settings.local.json'), JSON.stringify({ env: { CI: '1' } }));
    expect(show()).toMatch(/WARNING {4}claude: \.claude\/settings\.local\.json sets CI in env/);
  });

  // The operator's own hook would otherwise be reported on every turn of
  // every change, and the line would stop being read.
  it('stop warning about a hook the operator acknowledged in .katatay/rulebook.json', () => {
    userSettings(mine);
    expect(show()).toMatch(/WARNING.*rtk hook claude/);
    acknowledge({ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' });
    const display = cli('show.mjs');
    expect(display.status).toBe(0);
    expect(display.stdout).not.toMatch(/WARNING/);
    const { stdout, stderr, status } = cli('verify.mjs');
    expect(status).toBe(0);
    expect(`${stdout}${stderr}`).not.toMatch(/rtk hook claude/);
  });

  it('still warn about a hook when the acknowledged entry is for a narrower matcher', () => {
    userSettings({ hooks: { PreToolUse: [{ matcher: 'Bash|ExitPlanMode', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } });
    acknowledge({ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' });
    expect(show()).toMatch(/WARNING.*rtk hook claude.*can answer the plan dialog/);
  });
});

describe('an unapproved change is reported, not blocked', () => {
  // Blocking asked the agent to fix something only the operator can fix, and it
  // fired on every turn that ended with the tree still dirty.
  it('warns without blocking when the tree changed with no approved plan', () => {
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed by the shell\n');
    const decision = stop();
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/no plan has been approved/);
  });

  it('says nothing at all when the tree is clean', () => {
    expect(stop()).toBeNull();
  });
});
