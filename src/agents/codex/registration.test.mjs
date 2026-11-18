import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DEFAULT_TIMEOUT, EXPECTED, HOOKS_FILE, commandFor, hookRegistration, stopTimeout } from './registration.mjs';

describe('the hooks the workflow registers with Codex', () => {
  it('are the three the loop needs, each with a script that exists and what stops without it', () => {
    expect(EXPECTED.map(({ event }) => event)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop']);
    for (const { script, consequence } of EXPECTED) {
      expect(existsSync(script), script).toBe(true);
      expect(consequence).not.toBe('');
    }
  });

  // Codex starts a hook in the session's directory, which may be a subfolder.
  it('start each script from the git root', () => {
    expect(commandFor('tools/x.mjs')).toBe('node "$(git rev-parse --show-toplevel)/tools/x.mjs"');
  });

  it('are registered as .codex/hooks.json holds them', () => {
    const { hooks } = hookRegistration();
    expect(HOOKS_FILE).toBe('.codex/hooks.json');
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop']);
    expect(hooks.PreToolUse).toEqual([{ matcher: 'apply_patch|Bash', hooks: [{ type: 'command', command: commandFor('src/agents/codex/hooks/pre-tool.mjs') }] }]);
    // Without it Codex cuts the change report at about 2,500 tokens.
    expect(hooks.UserPromptSubmit[0]).toEqual({ hooks: [{ type: 'command', command: commandFor('src/agents/codex/hooks/user-prompt.mjs'), additionalContextLimit: 0 }] });
    expect(hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: commandFor('src/agents/codex/hooks/turn-end.mjs'), timeout: 900 }] });
  });
});

describe('the Stop hook\'s timeout', () => {
  const file = (timeout) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.mjs', timeout: 5 }, { type: 'command', command: commandFor('src/agents/codex/hooks/turn-end.mjs'), timeout }] }] } });

  it('is the one registered for the workflow\'s own Stop hook', () => {
    expect(stopTimeout(file(900))).toBe(900);
    expect(stopTimeout(JSON.stringify(hookRegistration()))).toBe(900);
  });

  it('is Codex\'s default when the file, the hook or the field is missing, or makes no sense', () => {
    expect(DEFAULT_TIMEOUT).toBe(600);
    for (const text of [null, 'not json', '{}', JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node other.mjs', timeout: 5 }] }] } }), file(undefined), file(0), file('900')]) {
      expect(stopTimeout(text)).toBe(DEFAULT_TIMEOUT);
    }
  });
});

describe('a hook registration of an unexpected shape', () => {
  const turnEnd = commandFor('src/agents/codex/hooks/turn-end.mjs');

  it('is read past, to the workflow\'s Stop hook where there is one', () => {
    const text = JSON.stringify({ hooks: { Stop: [null, { hooks: 'x' }, { hooks: [null, { command: 7 }, { command: turnEnd, timeout: 120 }] }] } });
    expect(stopTimeout(text)).toBe(120);
  });

  it('gives Codex\'s default when Stop is not a list', () => {
    expect(stopTimeout(JSON.stringify({ hooks: { Stop: { hooks: [{ command: turnEnd, timeout: 120 }] } } }))).toBe(DEFAULT_TIMEOUT);
  });
});
