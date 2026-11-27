import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DEFAULT_TIMEOUT, EXPECTED, HARNESS_ROOT, HOOKS_FILE, commandFor, harnessCommand, harnessInside, hookRegistration, mergedHooks, projectCommand, stopTimeout } from './registration.mjs';

describe('the hooks the workflow registers with Cursor', () => {
  it('registers the three hooks in .cursor/hooks.json, with the gate failing closed and no follow-up cap', () => {
    expect(HOOKS_FILE).toBe('.cursor/hooks.json');
    expect(hookRegistration(HARNESS_ROOT)).toEqual({
      version: 1,
      hooks: {
        preToolUse: [{ command: 'node src/agents/cursor/hooks/pre-tool.mjs', matcher: 'Write|Delete|Shell', timeout: 60, failClosed: true }],
        beforeSubmitPrompt: [{ command: 'node src/agents/cursor/hooks/user-prompt.mjs', timeout: 60 }],
        stop: [{ command: 'node src/agents/cursor/hooks/turn-end.mjs', timeout: 900, loop_limit: null }],
      },
    });
    expect(EXPECTED.map(({ event }) => event)).toEqual(['preToolUse', 'beforeSubmitPrompt', 'stop']);
  });

  it('names a script from the project root inside the harness, and by absolute path outside it', () => {
    expect(harnessInside(HARNESS_ROOT)).toBe(true);
    expect(harnessInside('/somewhere/else')).toBe(false);
    expect(projectCommand('src/agents/cursor/check.mjs')).toBe('node src/agents/cursor/check.mjs');
    expect(harnessCommand('src/agents/cursor/check.mjs')).toBe(`node ${JSON.stringify(join(HARNESS_ROOT, 'src/agents/cursor/check.mjs'))}`);
    expect(commandFor('src/agents/cursor/check.mjs', '/somewhere/else')).toBe(harnessCommand('src/agents/cursor/check.mjs'));
    expect(commandFor('src/agents/cursor/check.mjs', HARNESS_ROOT)).toBe('node src/agents/cursor/check.mjs');
  });
});

describe('the stop hook\'s timeout', () => {
  const file = (stop) => JSON.stringify({ version: 1, hooks: { stop } });

  it('is the registered one for the workflow\'s stop hook', () => {
    expect(stopTimeout(file([{ command: 'echo other', timeout: 5 }, { command: 'node src/agents/cursor/hooks/turn-end.mjs', timeout: 1200 }]))).toBe(1200);
  });

  it('is the default when the file, the hook or a usable timeout is missing', () => {
    expect(DEFAULT_TIMEOUT).toBe(60);
    for (const text of [null, 'not json', '{}', file([{ command: 'echo other', timeout: 5 }]),
      file([{ command: 'node src/agents/cursor/hooks/turn-end.mjs' }]), file([{ command: 'node src/agents/cursor/hooks/turn-end.mjs', timeout: 0 }]),
      JSON.stringify({ hooks: { stop: 'nope' } })]) {
      expect(stopTimeout(text), text).toBe(DEFAULT_TIMEOUT);
    }
  });
});

describe('merging the workflow\'s hooks into the project\'s file', () => {
  it('writes the whole registration into a project with no file', () => {
    expect(JSON.parse(mergedHooks(null, HARNESS_ROOT))).toEqual(hookRegistration(HARNESS_ROOT));
  });

  it('keeps every other key and hook, adds only what is missing, and adds nothing on a second run', () => {
    const own = { command: 'node src/agents/cursor/hooks/turn-end.mjs', timeout: 1800 };
    const text = JSON.stringify({ version: 1, custom: true, hooks: { stop: [{ command: 'echo done' }, own], afterFileEdit: [{ command: 'prettier' }] } });
    const merged = JSON.parse(mergedHooks(text, HARNESS_ROOT));
    expect(merged.custom).toBe(true);
    expect(merged.hooks.stop).toEqual([{ command: 'echo done' }, own]);
    expect(merged.hooks.afterFileEdit).toEqual([{ command: 'prettier' }]);
    expect(merged.hooks.preToolUse).toEqual(hookRegistration(HARNESS_ROOT).hooks.preToolUse);
    expect(merged.hooks.beforeSubmitPrompt).toEqual(hookRegistration(HARNESS_ROOT).hooks.beforeSubmitPrompt);
    expect(mergedHooks(mergedHooks(text, HARNESS_ROOT), HARNESS_ROOT)).toBe(mergedHooks(text, HARNESS_ROOT));
  });

  it('replaces a hooks value that is not an object, and an event list that is not a list', () => {
    expect(JSON.parse(mergedHooks(JSON.stringify({ hooks: [] }), HARNESS_ROOT)).hooks).toEqual(hookRegistration(HARNESS_ROOT).hooks);
    expect(JSON.parse(mergedHooks(JSON.stringify({ hooks: { stop: 'x' } }), HARNESS_ROOT)).hooks.stop).toEqual(hookRegistration(HARNESS_ROOT).hooks.stop);
  });

  it('refuses to merge into a file that is not a JSON object', () => {
    expect(() => mergedHooks('{', HARNESS_ROOT)).toThrow(/\.cursor\/hooks\.json is not JSON/);
    expect(() => mergedHooks('[]', HARNESS_ROOT)).toThrow('.cursor/hooks.json is not a JSON object, so the workflow\'s hooks cannot be merged into it');
    expect(() => mergedHooks('null', HARNESS_ROOT)).toThrow(/not a JSON object/);
  });
});

describe('edge cases the mutation run found', () => {
  it('counts a harness one folder down from the project as inside it', () => {
    expect(harnessInside(join(HARNESS_ROOT, '..'))).toBe(true);
    expect(commandFor('src/agents/cursor/check.mjs', join(HARNESS_ROOT, '..'))).toBe('node src/agents/cursor/check.mjs');
  });

  it('reads the stop timeout past an entry that is null', () => {
    expect(stopTimeout(JSON.stringify({ hooks: { stop: [null, { command: 'node src/agents/cursor/hooks/turn-end.mjs', timeout: 1200 }] } }))).toBe(1200);
  });

  it('refuses a file that is a number or a string', () => {
    for (const text of ['3', '"x"']) expect(() => mergedHooks(text, HARNESS_ROOT), text).toThrow('.cursor/hooks.json is not a JSON object');
  });

  it('replaces a hooks value that is a string or a list, and keeps a null entry beside its own', () => {
    for (const hooks of ['abc', ['x']]) {
      expect(JSON.parse(mergedHooks(JSON.stringify({ hooks }), HARNESS_ROOT)).hooks, JSON.stringify(hooks)).toEqual(hookRegistration(HARNESS_ROOT).hooks);
    }
    expect(JSON.parse(mergedHooks(JSON.stringify({ hooks: { stop: [null] } }), HARNESS_ROOT)).hooks.stop).toEqual([null, ...hookRegistration(HARNESS_ROOT).hooks.stop]);
  });
});
