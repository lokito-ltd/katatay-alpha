/**
 * The Claude adapter in a project the harness does not sit in: its scripts by
 * absolute path, its hooks merged into the project's settings, and its check
 * accepting exactly those hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED, HARNESS_ROOT, SETTINGS_FILE, commandFor, hookRegistration, mergedSettings, scriptFor, scriptOf } from './registration.mjs';
import { proposal } from './proposal.mjs';
import { settingsDifferences } from './settings.mjs';

let outside;
beforeEach(() => {
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'claude-merge-')));
});
afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

const commands = (settings) => Object.values(settings.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));

describe('naming a script for a project', () => {
  it('names it from the project root when the harness sits inside the project', () => {
    expect(scriptFor('src/agents/claude/check.mjs', HARNESS_ROOT)).toBe('src/agents/claude/check.mjs');
    expect(commandFor('src/agents/claude/check.mjs', HARNESS_ROOT)).toBe('node src/agents/claude/check.mjs');
  });

  it('names it by absolute path when the harness lives outside the project', () => {
    expect(scriptFor('src/agents/claude/check.mjs', outside)).toBe(join(HARNESS_ROOT, 'src/agents/claude/check.mjs'));
    expect(proposal(outside).commands).toEqual({
      check: `node ${join(HARNESS_ROOT, 'src/agents/claude/check.mjs')}`,
      install: `node ${join(HARNESS_ROOT, 'src/agents/claude/install.mjs')}`,
    });
    for (const command of commands(hookRegistration(outside))) expect(scriptOf(command).startsWith(HARNESS_ROOT)).toBe(true);
  });

  it('reads the script back from a command, with or without node and quotes', () => {
    expect(scriptOf('node "/a b/x.mjs"')).toBe('/a b/x.mjs');
    expect(scriptOf('  node   tools/x.mjs ')).toBe('tools/x.mjs');
    expect(scriptOf('tools/x.mjs')).toBe('tools/x.mjs');
  });

  it('takes off only a leading node and only quotes around the whole path', () => {
    expect(scriptOf('/opt/node x.mjs')).toBe('/opt/node x.mjs');
    expect(scriptOf('a "b"')).toBe('a "b"');
    expect(scriptOf('"a" b')).toBe('"a" b');
  });

  it('gives a hook with no timeout of its own no timeout key', () => {
    expect(Object.keys(hookRegistration(outside).hooks.PreToolUse[0].hooks[0]).sort()).toEqual(['command', 'type']);
  });
});

describe('merging the hooks into the project\'s settings', () => {
  it('registers every workflow hook in a project with no settings yet', () => {
    const merged = JSON.parse(mergedSettings(null, { root: outside }));
    expect(merged).toEqual(hookRegistration(outside));
    expect(Object.keys(merged.hooks).sort()).toEqual([...new Set(EXPECTED.map(({ event }) => event))].sort());
  });

  it('keeps every key and hook the settings already hold', () => {
    const existing = { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const merged = JSON.parse(mergedSettings(JSON.stringify(existing), { root: outside }));
    expect(merged.model).toBe('x');
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(merged.hooks.Stop).toHaveLength(2);
  });

  it('adds nothing for a hook that already runs, relative or absolute, so a second run changes nothing', () => {
    const once = mergedSettings(null, { root: outside });
    expect(mergedSettings(once, { root: outside })).toBe(once);
    const relative = `${JSON.stringify(hookRegistration(HARNESS_ROOT), null, 2)}\n`;
    expect(commands(JSON.parse(mergedSettings(relative, { root: outside })))).toEqual(commands(hookRegistration(HARNESS_ROOT)));
  });

  it('keeps an operator\'s changed registration, such as a longer timeout', () => {
    const changed = hookRegistration(outside);
    changed.hooks.Stop[0].hooks[0].timeout = 1800;
    expect(JSON.parse(mergedSettings(JSON.stringify(changed), { root: outside })).hooks.Stop[0].hooks[0].timeout).toBe(1800);
  });

  it('replaces a hooks value that is not an object, since nothing in it could run', () => {
    expect(JSON.parse(mergedSettings(JSON.stringify({ hooks: [] }), { root: outside })).hooks).toEqual(hookRegistration(outside).hooks);
  });

  it('refuses settings that are not JSON, or not an object, rather than throw them away', () => {
    expect(() => mergedSettings('{ nope', { root: outside })).toThrow(`${SETTINGS_FILE} is not JSON`);
    for (const text of ['[]', 'null', '1', '"x"']) expect(() => mergedSettings(text, { root: outside }), text).toThrow(`${SETTINGS_FILE} is not a JSON object`);
  });

  it('registers every hook when the settings hold hooks: null', () => {
    expect(JSON.parse(mergedSettings('{"hooks":null}', { root: outside })).hooks).toEqual(hookRegistration(outside).hooks);
  });

  it('sets plansDirectory only for a plans folder inside the project, which Claude Code honours', () => {
    expect(JSON.parse(mergedSettings(null, { root: outside, plansFolder: 'plans/' })).plansDirectory).toBe('plans');
    expect(JSON.parse(mergedSettings(null, { root: outside, plansFolder: 'docs/plans/' })).plansDirectory).toBe('docs/plans');
    expect(JSON.parse(mergedSettings(null, { root: outside, plansFolder: '~/.claude/plans', home: '/home/op' }))).not.toHaveProperty('plansDirectory');
    expect(JSON.parse(mergedSettings(null, { root: outside, plansFolder: '~', home: outside }))).not.toHaveProperty('plansDirectory');
  });
});

describe('the check, on hooks registered by absolute path', () => {
  const project = (settings) => [{ file: SETTINGS_FILE, scope: 'project', settings }];

  it('finds nothing extra in the hooks init registers outside the harness', () => {
    expect(settingsDifferences(project(hookRegistration(outside)))).toEqual([]);
  });

  it('still reports a look-alike script in another folder', () => {
    const lookalike = hookRegistration(outside);
    lookalike.hooks.PreToolUse[0].hooks[0].command = 'node /elsewhere/src/agents/claude/hooks/pre-tool.mjs';
    expect(settingsDifferences(project(lookalike)).join('\n')).toContain('/elsewhere/src/agents/claude/hooks/pre-tool.mjs');
  });
});
