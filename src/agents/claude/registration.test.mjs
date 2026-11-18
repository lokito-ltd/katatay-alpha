/**
 * The manifest is checked against settings objects written here, never against
 * the repository's own `.claude/settings.json`.
 *
 * Reading the live file would give the manifest real protection against rot,
 * and it would also be a trap: `.claude/` is locked by the rulebook, so
 * no session can repair a registration. A failure here would turn every
 * `workflow verify` red with nothing the agent could do about it. That is why
 * `cli/verify.mjs` warns instead, and why these cases are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { covers, hookTimeout, registrationProblems, stopTimeout } from './registration.mjs';

/** What the repository actually registers, written out rather than read in. */
const intact = () => ({
  hooks: {
    PreToolUse: [
      { matcher: 'Edit|Write|NotebookEdit|Bash|ExitPlanMode', hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/pre-tool.mjs' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/user-prompt.mjs' }] }],
    PostToolUse: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/post-tool.mjs' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/turn-end.mjs', timeout: 900 }] }],
  },
});

describe('the hooks this repository expects to be registered', () => {
  it('says nothing about settings that register all of them', () => {
    expect(registrationProblems(intact())).toEqual([]);
  });

  it('reports a hook that is no longer registered, and what stops working', () => {
    const settings = intact();
    delete settings.hooks.Stop;

    const [problem, ...rest] = registrationProblems(settings);
    expect(problem).toContain('src/agents/claude/hooks/turn-end.mjs');
    expect(problem).toMatch(/verify/);
    expect(rest).toEqual([]);
  });

  it('reports a registration pointing at some other script', () => {
    const settings = intact();
    settings.hooks.PostToolUse[0].hooks[0].command = 'node src/agents/claude/hooks/capture.mjs';

    expect(registrationProblems(settings)).toEqual([
      expect.stringContaining('src/agents/claude/hooks/post-tool.mjs'),
    ]);
  });

  // The matcher is checked for what it covers rather than for its exact text,
  // so reordering an alternation is not a finding and losing a tool from one is.
  it('reports a hook registered for fewer tools than it has to run for', () => {
    const settings = intact();
    settings.hooks.PreToolUse[0].matcher = 'Edit|Write';

    expect(registrationProblems(settings)).toEqual([
      expect.stringContaining('but not for NotebookEdit, Bash'),
    ]);
  });

  it('tells an operator with the old matcher how to activate the courtesy', () => {
    const settings = intact();
    settings.hooks.PreToolUse[0].matcher = 'Edit|Write|NotebookEdit|Bash';
    expect(registrationProblems(settings)).toEqual([expect.stringMatching(/not for ExitPlanMode.*before the approval dialog.*start a new session/)]);
  });

  it('accepts a matcher whose tools are in another order', () => {
    const settings = intact();
    settings.hooks.PreToolUse[0].matcher = 'ExitPlanMode|Bash|NotebookEdit|Write|Edit';

    expect(registrationProblems(settings)).toEqual([]);
  });

  // 60 seconds is Claude Code's default, and the suite takes longer than that.
  // A Stop hook killed partway through reports a verify failure that never
  // happened, which is worse than one that never ran.
  it('reports a Stop hook that would be killed before the suite finishes', () => {
    const settings = intact();
    delete settings.hooks.Stop[0].hooks[0].timeout;

    expect(registrationProblems(settings)).toEqual([
      expect.stringContaining('60-second timeout'),
    ]);
  });

  // 300 seconds was enough for verify alone. Mutation testing runs after it, in
  // the same hook, so the old figure now leaves it no time to run.
  it('reports a Stop hook with the timeout that was enough before mutation testing', () => {
    const settings = intact();
    settings.hooks.Stop[0].hooks[0].timeout = 300;

    expect(registrationProblems(settings)).toEqual([
      expect.stringContaining('300-second timeout; it runs the whole suite and mutation testing, and needs at least 900'),
    ]);
  });

  it('says nothing about hooks the operator has added of their own', () => {
    const settings = intact();
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node /home/me/notify.mjs' }] });
    settings.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'node /home/me/greet.mjs' }] }];

    expect(registrationProblems(settings)).toEqual([]);
  });

  it('reports every hook when there is nothing registered at all', () => {
    // The 2026-09-17 shape: the file replaced, and everything gone with it.
    expect(registrationProblems({})).toHaveLength(4);
    expect(registrationProblems({})).toEqual(registrationProblems({ hooks: {} }));
  });
});

/**
 * A matcher, read the way Claude Code reads one. Whether this repository's own
 * hooks are registered only ever needed plain lists. Asking what somebody
 * else's hook covers needs all three forms: `settings.mjs` asks whether an
 * extra hook runs for `ExitPlanMode`, the tool whose dialog approves a plan.
 */
describe('which tools a matcher covers', () => {
  it('covers every tool when it is absent, empty or a star', () => {
    for (const matcher of [undefined, '', '*']) expect(covers(matcher, 'ExitPlanMode'), String(matcher)).toBe(true);
  });

  it('covers the names in a list separated by bars or commas, each matched whole', () => {
    expect(covers('Edit|Write', 'Write')).toBe(true);
    expect(covers('Bash,ExitPlanMode', 'ExitPlanMode')).toBe(true);
    expect(covers('Bash, ExitPlanMode', 'ExitPlanMode')).toBe(true);
    expect(covers('Edit|Write', 'NotebookEdit')).toBe(false);
    expect(covers('Bash', 'ExitPlanMode')).toBe(false);
  });

  // Anything with another character in it is a regular expression, and not
  // anchored. Read as a list, `Exit.*` covered nothing.
  it('reads anything else as an unanchored regular expression', () => {
    expect(covers('Exit.*', 'ExitPlanMode')).toBe(true);
    expect(covers('.*', 'ExitPlanMode')).toBe(true);
    expect(covers('Edit.*', 'NotebookEdit')).toBe(true);
    expect(covers('^Edit$', 'NotebookEdit')).toBe(false);
    expect(covers('mcp__.*', 'ExitPlanMode')).toBe(false);
  });

  it('covers nothing when the expression cannot be compiled', () => {
    expect(covers('Exit(', 'ExitPlanMode')).toBe(false);
  });

  it('still finds a required hook registered behind a regular expression', () => {
    const settings = {
      hooks: { PostToolUse: [{ matcher: '^ExitPlanMode$', hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/post-tool.mjs' }] }] },
    };
    expect(registrationProblems(settings).filter((problem) => problem.startsWith('PostToolUse'))).toEqual([]);
  });
});

describe('how long a hook is given', () => {
  const turnEnd = 'src/agents/claude/hooks/turn-end.mjs';

  it('is the timeout its registration names', () => {
    expect(hookTimeout(intact(), 'Stop', turnEnd)).toBe(900);
  });

  it('is Claude Code\'s 60-second default when the registration names none', () => {
    const settings = intact();
    delete settings.hooks.Stop[0].hooks[0].timeout;
    expect(hookTimeout(settings, 'Stop', turnEnd)).toBe(60);
  });

  // Claude Code runs every registration, so the one that lasts longest is the
  // one the hook can count on finishing within.
  it('is the longest when the hook is registered more than once', () => {
    const settings = intact();
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: `node ${turnEnd}`, timeout: 1200 }] });
    expect(hookTimeout(settings, 'Stop', turnEnd)).toBe(1200);
  });

  it('ignores the timeouts of other hooks on the same event', () => {
    const settings = intact();
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node /home/me/notify.mjs', timeout: 3000 }] });
    expect(hookTimeout(settings, 'Stop', turnEnd)).toBe(900);
  });

  it('is undefined when nothing runs the hook', () => {
    expect(hookTimeout({}, 'Stop', turnEnd)).toBeUndefined();
  });
});

describe('how long the hook has', () => {
  const settings = (timeout) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node src/agents/claude/hooks/turn-end.mjs', ...(timeout ? { timeout } : {}) }] }] } });

  it('is the timeout the project registers it with', () => {
    expect(stopTimeout(settings(900))).toBe(900);
  });

  // Too little time means no run, never an overrun.
  it('is Claude Code\'s default when the settings name none, are missing, or cannot be read', () => {
    expect(stopTimeout(settings())).toBe(60);
    expect(stopTimeout(null)).toBe(60);
    expect(stopTimeout('{ not json')).toBe(60);
    expect(stopTimeout('{}')).toBe(60);
  });
});
