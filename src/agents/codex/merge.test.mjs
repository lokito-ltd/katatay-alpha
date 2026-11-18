/**
 * The Codex adapter in a project the harness does not sit in: its scripts by
 * absolute path, its hooks merged into the project's hooks file, its
 * instructions marked shared, and its check accepting exactly those hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXPECTED, HARNESS_ROOT, HOOKS_FILE, commandFor, harnessCommand, harnessInside, hookRegistration, mergedHooks, projectCommand } from './registration.mjs';
import { proposal } from './proposal.mjs';
import { INSTRUCTIONS_FILE, installFiles } from './install-files.mjs';
import { setupWarnings } from './setup.mjs';
import { payload } from '../../../tests/fixtures/codex/payloads.mjs';

let outside;
beforeEach(() => {
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'codex-merge-')));
});
afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

const commands = (file) => Object.values(file.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));

describe('naming a script for a project', () => {
  it('names it from the git root when the harness sits inside the project', () => {
    expect(harnessInside(HARNESS_ROOT)).toBe(true);
    expect(commandFor('tools/x.mjs', HARNESS_ROOT)).toBe(projectCommand('tools/x.mjs'));
    expect(proposal(HARNESS_ROOT).commands).toEqual({ check: 'node src/agents/codex/check.mjs', install: 'node src/agents/codex/install.mjs' });
  });

  it('counts the harness inside a project that holds it in a subfolder', () => {
    expect(harnessInside(dirname(HARNESS_ROOT))).toBe(true);
  });

  it('counts a project folder that does not exist as not holding the harness', () => {
    expect(harnessInside('/no/such/folder')).toBe(false);
  });

  it('names it by absolute path when the harness lives outside the project', () => {
    expect(harnessInside(outside)).toBe(false);
    expect(commandFor('tools/x.mjs', outside)).toBe(`node "${join(HARNESS_ROOT, 'tools/x.mjs')}"`);
    expect(commandFor('tools/x.mjs', outside)).toBe(harnessCommand('tools/x.mjs'));
    expect(proposal(outside).commands).toEqual({
      check: harnessCommand('src/agents/codex/check.mjs'),
      install: harnessCommand('src/agents/codex/install.mjs'),
    });
    for (const command of commands(hookRegistration(outside))) expect(command).not.toContain('git rev-parse');
  });
});

describe('merging the hooks into the project\'s hooks file', () => {
  it('registers every workflow hook in a project with no hooks file yet', () => {
    expect(JSON.parse(mergedHooks(null, outside))).toEqual(hookRegistration(outside));
  });

  it('keeps every key and hook the file already holds, its description included', () => {
    const existing = { description: 'Ours.', extra: 1, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const merged = JSON.parse(mergedHooks(JSON.stringify(existing), outside));
    expect(merged.description).toBe('Ours.');
    expect(merged.extra).toBe(1);
    expect(merged.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(Object.keys(merged.hooks).sort()).toEqual([...new Set(EXPECTED.map(({ event }) => event))].sort());
  });

  it('adds nothing for a hook that already runs, so a second run changes nothing', () => {
    const once = mergedHooks(null, outside);
    expect(mergedHooks(once, outside)).toBe(once);
    const inside = JSON.stringify(hookRegistration(HARNESS_ROOT));
    expect(commands(JSON.parse(mergedHooks(inside, outside)))).toEqual(commands(hookRegistration(HARNESS_ROOT)));
  });

  it('refuses a hooks file that is not JSON, or not an object, rather than throw it away', () => {
    expect(() => mergedHooks('{ nope', outside)).toThrow(`${HOOKS_FILE} is not JSON`);
    for (const text of ['"x"', 'null', '1', '[]']) expect(() => mergedHooks(text, outside), text).toThrow(`${HOOKS_FILE} is not a JSON object`);
  });

  it('registers every hook when the file holds hooks: null', () => {
    expect(JSON.parse(mergedHooks('{"hooks":null}', outside)).hooks).toEqual(hookRegistration(outside).hooks);
  });

  it('finds the workflow\'s hook in a group that holds another hook beside it', () => {
    const turnEnd = commandFor('src/agents/codex/hooks/turn-end.mjs', outside);
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: turnEnd }] }] } };
    expect(JSON.parse(mergedHooks(JSON.stringify(existing), outside)).hooks.Stop).toEqual(existing.hooks.Stop);
  });

  it('reads past groups and hooks that are null or run no command', () => {
    for (const Stop of [[null], [{ hooks: [null] }], [{ hooks: [{ type: 'prompt' }] }]]) {
      const merged = JSON.parse(mergedHooks(JSON.stringify({ hooks: { Stop } }), outside));
      expect(merged.hooks.Stop, JSON.stringify(Stop)).toEqual([...Stop, hookRegistration(outside).hooks.Stop[0]]);
    }
  });
});

describe('the instructions', () => {
  it('are marked shared, because the project keeps its own text in the same file', () => {
    const files = installFiles({ instructions: '# The workflow\n', skills: [{ name: 'plan-change', description: 'Plan.', prompt: '# Plan\n' }] });
    expect(files.find(({ path }) => path === INSTRUCTIONS_FILE).shared).toBe(true);
    expect(files.filter(({ shared }) => shared)).toHaveLength(1);
  });
});

describe('the check, on hooks registered by absolute path', () => {
  const root = '/repo';
  const captured = payload('app-server-hooks-list', {}, { home: '/home/op', repo: root });
  const config = payload('app-server-config-read', {}, { home: '/home/op', repo: root });
  const template = captured.data[0].hooks[0];
  const camel = (event) => event.charAt(0).toLowerCase() + event.slice(1);
  const listed = (command) => ({ data: [{ ...captured.data[0], hooks: EXPECTED.map((expected) => ({
    ...template,
    eventName: camel(expected.event),
    matcher: expected.matcher.length > 0 ? expected.matcher.join('|') : null,
    command: command(expected.script),
  })) }] });
  const warnings = (command) => setupWarnings({ root, hooksList: listed(command), config, extraHooks: { acknowledged: [] }, instructions: true });

  it('finds the workflow\'s own hooks registered by absolute path', () => {
    expect(warnings(harnessCommand).filter((warning) => warning.includes('does not register'))).toEqual([]);
  });

  it('still misses a look-alike script in another folder', () => {
    expect(warnings((script) => `node "/elsewhere/${script}"`).filter((warning) => warning.includes('does not register'))).toHaveLength(EXPECTED.length);
  });
});
