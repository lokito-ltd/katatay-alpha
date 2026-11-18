import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXPECTED } from './registration.mjs';

const CHECK = resolve('src/agents/claude/check.mjs');

/**
 * Runs the check in a repository holding `settings`, with a home that holds
 * nothing. `request` is what the referee sends on stdin; `root` in it is
 * filled in with the repository the check runs in. The workflow's
 * instructions are installed unless `instructions` is false, so a case about
 * the settings is not also a case about them.
 */
function ask(settings, request = { version: 1, extraHooks: { acknowledged: [] } }, user = undefined, { instructions = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-check-')));
  try {
    if (instructions) {
      mkdirSync(join(root, '.claude/rules'), { recursive: true });
      writeFileSync(join(root, '.claude/rules/workflow.md'), '# The workflow\n');
    }
    if (settings) {
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(settings));
    }
    // The operator's own settings, where `CLAUDE_CONFIG_DIR` below points.
    if (user) {
      mkdirSync(join(root, 'none'));
      writeFileSync(join(root, 'none/settings.json'), JSON.stringify(user));
    }
    const input = typeof request === 'string' ? request : JSON.stringify({ root, ...request });
    const run = spawnSync('node', [CHECK], { cwd: root, input, encoding: 'utf8', env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'none') } });
    return { run, answer: run.status === 0 ? JSON.parse(run.stdout) : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The settings that register every hook this repository expects. */
const registered = () => {
  const hooks = {};
  for (const { event, matcher, command, timeout } of EXPECTED) {
    hooks[event] ??= [];
    hooks[event].push({ ...(matcher.length > 0 ? { matcher: matcher.join('|') } : {}), hooks: [{ type: 'command', command: `node ${command}`, ...(timeout ? { timeout } : {}) }] });
  }
  return { hooks };
};

describe('the agent check', () => {
  it('prints a JSON object with a list of warnings and exits 0', () => {
    const { run, answer } = ask(null);
    expect(run.status).toBe(0);
    expect(Array.isArray(answer.warnings)).toBe(true);
  });

  it('reports each hook missing from the settings, and what stops working', () => {
    const { answer } = ask(null);
    for (const { command, consequence } of EXPECTED) {
      expect(answer.warnings.some((warning) => warning.includes(command) && warning.includes(consequence)), command).toBe(true);
    }
  });

  it('warns when the workflow\'s instructions are not installed, and says where they belong', () => {
    const { answer } = ask(registered(), undefined, undefined, { instructions: false });
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings[0]).toContain('.claude/rules/workflow.md is missing');
    expect(answer.warnings[0]).toContain('without the workflow\'s instructions');
  });

  it('has nothing to report when every expected hook is registered', () => {
    expect(ask(registered()).answer.warnings).toEqual([]);
  });

  it('reports disableAllHooks', () => {
    const { answer } = ask({ ...registered(), disableAllHooks: true });
    expect(answer.warnings).toEqual([expect.stringContaining('disableAllHooks')]);
  });

  it('answers with the contract\'s version', () => {
    expect(ask(registered()).answer.version).toBe(1);
  });

  // The extra-hooks section is the referee's to parse, and it sends what it
  // read. Nothing acknowledged lists the hook; acknowledged, or the check
  // switched off with null, it is not.
  describe('the extra hooks the referee sends', () => {
    const extra = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'audit.sh' }] }] } };
    const said = (extraHooks) => ask(registered(), { version: 1, extraHooks }, extra).answer.warnings;

    it('lists an extra hook nobody acknowledged', () => {
      expect(said({ acknowledged: [] })).toEqual([expect.stringContaining('registers an extra Stop hook: `audit.sh`')]);
    });

    it('leaves out a hook the operator acknowledged', () => {
      expect(said({ acknowledged: [{ event: 'Stop', matcher: '', command: 'audit.sh' }] })).toEqual([]);
      expect(said({ acknowledged: [{ event: 'Stop', command: 'audit.sh' }] })).toEqual([]);
    });

    it('lists no extra hook when the rulebook switches the check off', () => {
      expect(said(null)).toEqual([]);
    });
  });
});
