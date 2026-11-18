import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installFiles } from './install-files.mjs';
import { HOOKS_FILE, mergedHooks } from './registration.mjs';

const INSTALL = resolve('src/agents/codex/install.mjs');

const run = (input, cwd = undefined) => spawnSync('node', [INSTALL], { cwd, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });

const GOOD = { version: 1, instructions: '# The workflow\n', skills: [{ name: 'plan-change', description: 'Plan.', prompt: '# Plan\n' }] };

describe('the install command', () => {
  it('answers the files the transform gives, with the version, and exits 0', () => {
    // In a project with no registration yet, so the merge starts from nothing.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-')));
    try {
      const answered = run(GOOD, root);
      expect(answered.status).toBe(0);
      expect(JSON.parse(answered.stdout)).toEqual({ version: 1, files: installFiles(GOOD), registration: { path: HOOKS_FILE, text: mergedHooks(null, root) } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with exit 1, and answers nothing, when the project\'s registration cannot be merged into', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-')));
    try {
      mkdirSync(join(root, '.codex'));
      writeFileSync(join(root, '.codex/hooks.json'), '[]');
      const answered = run(GOOD, root);
      expect(answered.status).toBe(1);
      expect(answered.stdout).toBe('');
      expect(answered.stderr.startsWith('install: .codex/hooks.json is not a JSON object')).toBe(true);
      expect(answered.stderr.endsWith(', so the workflow\'s hooks cannot be merged into it.\n')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a plans folder that is not a path', () => {
    const answered = run({ ...GOOD, plansFolder: '' });
    expect(answered.status).toBe(2);
    expect(answered.stderr).toContain('`plansFolder` must be a path when it is given');
  });

  it('installs the instructions alone when there are no skills', () => {
    expect(JSON.parse(run({ ...GOOD, skills: [] }).stdout).files.map(({ path }) => path)).toEqual(['AGENTS.md']);
  });

  it.each([
    ['is not JSON', 'nope', 'the request is not JSON'],
    ['is not an object', '[1]', 'the request is not a JSON object'],
    ['has no version', { ...GOOD, version: undefined }, '`version` must be 1, and is missing'],
    ['has a null version', { ...GOOD, version: null }, '`version` must be 1, and is null'],
    ['has a string version', { ...GOOD, version: '1' }, '`version` must be 1, and is "1"'],
    ['has another version', { ...GOOD, version: 2 }, '`version` must be 1, and is 2'],
    ['has no instructions', { ...GOOD, instructions: '  ' }, '`instructions` must be'],
    ['has no skills list', { ...GOOD, skills: 'plan-change' }, '`skills` must be a list'],
    ['has a skill without a description', { ...GOOD, skills: [{ name: 'a', description: '', prompt: '' }] }, '`skills` must be a list'],
    ['has a skill whose name would leave its folder', { ...GOOD, skills: [{ name: '../x', description: 'D.', prompt: '' }] }, '`skills` must be a list'],
    ['has a skill without a prompt', { ...GOOD, skills: [{ name: 'a', description: 'D.' }] }, '`skills` must be a list'],
  ])('refuses a request that %s, with exit 2 and a sentence', (_case, input, why) => {
    const answered = run(input);
    expect(answered.status).toBe(2);
    expect(answered.stdout).toBe('');
    expect(answered.stderr).toContain(`install: refused, ${why}`);
  });
});
