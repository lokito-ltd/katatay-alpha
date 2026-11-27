import { expect, it } from 'vitest';
import { CLAUDE_PAYLOADS, payload } from '../../../../tests/fixtures/cursor/payloads.mjs';
import { payload as claudePayload } from '../../../../tests/fixtures/claude/payloads.mjs';
import { runByCursor } from './cursor.mjs';

const PATHS = { home: '/home/operator', repo: '/work/repo' };

it('knows every payload Cursor sent the Claude Code hooks, and stands aside for it', () => {
  for (const name of CLAUDE_PAYLOADS) expect(runByCursor(payload(name, {}, PATHS)), name).toBe(true);
});

it('runs for Claude Code\'s own payloads, and for anything without a version Cursor would send', () => {
  expect(runByCursor(claudePayload('pre-tool-use-write', {}, PATHS))).toBe(false);
  for (const hook of [undefined, null, {}, { cursor_version: '' }, { cursor_version: 3 }]) expect(runByCursor(hook), JSON.stringify(hook)).toBe(false);
});
