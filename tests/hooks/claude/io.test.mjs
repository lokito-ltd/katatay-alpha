/**
 * What a hook writes reaches Claude Code whole, as one object, when the hook
 * exits through `leave`. Each case runs a stand-in hook as its own process,
 * because the exit is the thing under test, and reads its stdout through a
 * pipe as Claude Code does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IO = new URL('../../../src/agents/claude/hooks/io.mjs', import.meta.url).href;
const DRIFT = new URL('../../../src/agents/claude/hooks/drift.mjs', import.meta.url).href;

let dir;
const hook = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `
    import { send, leave } from ${JSON.stringify(IO)};
    import { expectFields } from ${JSON.stringify(DRIFT)};
    ${body}
  `);
  return spawnSync(process.execPath, [path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-io-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('leaving a hook', () => {
  // A turn-end block carries the verify tail, mutation survivors and review
  // areas. A pipe on macOS holds 64 KB, and an exit that did not wait kept
  // only that much.
  it('sends a block larger than the pipe holds whole, and exits 0', () => {
    const reason = 'x'.repeat(500_000);
    const result = hook('big.mjs', `send({ via: 'block', text: ${JSON.stringify(reason)} }); await leave();`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason });
  });

  it('writes nothing for a hook that has nothing to say', () => {
    const result = hook('quiet.mjs', 'send(null); await leave();');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('writes an unsaid drift warning on the way out, as the one object', () => {
    const result = hook('drift-alone.mjs', `
      expectFields({ hook_event_name: 'Stop' }, { stop_hook_active: 'a turn could be held in a loop' });
      await leave();
    `);
    expect(result.status).toBe(0);
    const { systemMessage } = JSON.parse(result.stdout);
    expect(systemMessage).toMatch(/^Claude Code sent no `stop_hook_active` to the Stop hook, so a turn could be held in a loop\./);
  });

  // Once a message has carried the warning, leaving must not write it again:
  // two objects on stdout are not JSON.
  it('does not write the drift warning twice when a message already carried it', () => {
    const result = hook('drift-carried.mjs', `
      expectFields({ hook_event_name: 'Stop' }, { stop_hook_active: 'a turn could be held in a loop' });
      send({ via: 'block', text: 'not verified' });
      await leave();
    `);
    expect(result.status).toBe(0);
    const { decision, reason } = JSON.parse(result.stdout);
    expect(decision).toBe('block');
    expect(reason).toMatch(/^Claude Code sent no `stop_hook_active`[\s\S]*\n\nnot verified$/);
  });
});
