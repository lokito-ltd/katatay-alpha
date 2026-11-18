/**
 * The fixtures still carry what the hooks read.
 *
 * Every other test here builds on these files, which makes a stale fixture the
 * one failure that hides all the others: the suite would go green against a
 * payload shape that no longer exists. This case is the fixtures answering for
 * themselves.
 *
 * The table is written by hand on purpose. Deriving it from the hooks — by
 * parsing them, or by asking them what they read — would close the loop that
 * this whole change exists to open, and the table would agree with the hooks
 * for exactly the same bad reason the old payloads did. Someone adding a field
 * to a hook has to come here and say so.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, payload } from '../../fixtures/claude/payloads.mjs';

const HERE = fileURLToPath(new URL('../../fixtures/claude/', import.meta.url));

const PATHS = { home: '/fixture/home', repo: '/fixture/repo', scratchpad: '/fixture/scratch' };

/** Fixture → the fields some hook reads out of it, and who reads them. */
const READS = {
  'user-prompt-submit': { 'prompt': 'user-prompt.mjs' },
  'pre-tool-use-write': {
    'tool_name': 'pre-tool.mjs',
    'tool_input.file_path': 'pre-tool.mjs',
  },
  'pre-tool-use-bash': { 'tool_name': 'pre-tool.mjs' },
  'post-tool-use-exit-plan-mode': {
    'tool_response.plan': 'post-tool.mjs',
    'tool_response.filePath': 'post-tool.mjs',
  },
  'post-tool-use-exit-plan-mode-edited': {
    'tool_response.plan': 'post-tool.mjs',
    'tool_response.filePath': 'post-tool.mjs',
  },
  'stop': { 'stop_hook_active': 'turn-end.mjs' },
};

const at = (object, path) =>
  path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);

describe('the captured payloads', () => {
  for (const [fixture, reads] of Object.entries(READS)) {
    for (const [field, reader] of Object.entries(reads)) {
      it(`carries \`${field}\`, which ${reader} reads`, () => {
        expect(at(payload(fixture, {}, PATHS), field)).toBeDefined();
      });
    }
  }

  it('lists every file it ships', () => {
    for (const name of FIXTURES) {
      expect(() => readFileSync(join(HERE, `${name}.json`), 'utf8')).not.toThrow();
    }
    expect(Object.keys(READS).sort()).toEqual([...FIXTURES].sort());
  });

  // A fixture nobody scrubbed would put the capturing machine's home directory
  // into the repository, and would quietly stop being portable.
  it('carries no path from the machine it was captured on', () => {
    for (const name of FIXTURES) {
      const raw = readFileSync(join(HERE, `${name}.json`), 'utf8');
      expect(raw).not.toMatch(/\/Users\//);
      expect(raw).not.toMatch(/\/home\/[a-z]/);
    }
  });

  // The envelope is the reason these files exist. A "fixture" trimmed to the
  // fields the hooks read would be a hand-written payload with extra steps.
  it('keeps the fields no hook reads', () => {
    const real = payload('stop', {}, PATHS);
    expect(real.session_id).toBeDefined();
    expect(real.transcript_path).toBeDefined();
    expect(real.permission_mode).toBeDefined();
    expect(real.cwd).toBe(PATHS.repo);
  });
});
