import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { proposal } from './proposal.mjs';

const DEFAULTS = resolve('src/agents/codex/defaults.mjs');

/** Runs the command with `input` on stdin, as `init` would. */
const run = (input) => spawnSync('node', [DEFAULTS], { input, encoding: 'utf8' });

describe('the defaults command', () => {
  it('prints the proposal and exits 0', () => {
    const answer = run(JSON.stringify({ version: 1 }));
    expect(answer.status).toBe(0);
    expect(JSON.parse(answer.stdout)).toEqual(proposal());
  });

  it.each([
    ['not JSON', 'hello', 'not JSON'],
    ['not an object', '[1]', 'not a JSON object'],
    ['null', 'null', 'not a JSON object'],
    ['null version', JSON.stringify({ version: null }), '`version` must be 1, and is null'],
    ['another version', JSON.stringify({ version: 2 }), '`version` must be 1, and is 2'],
    ['string version', JSON.stringify({ version: '1' }), '`version` must be 1, and is "1"'],
    ['no version', JSON.stringify({}), 'is missing'],
  ])('refuses a request that is %s, with exit 2, nothing on stdout and a sentence on stderr', (_case, input, why) => {
    const answer = run(input);
    expect(answer.status).toBe(2);
    expect(answer.stdout).toBe('');
    expect(answer.stderr).toMatch(/^defaults: refused, /);
    expect(answer.stderr).toContain(why);
  });
});
