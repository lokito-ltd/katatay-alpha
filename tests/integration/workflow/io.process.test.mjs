/**
 * `serve`, run as a command the way an agent adapter runs a moment: started
 * with its input on stdin and its stdout read through a pipe.
 *
 * The moments' decisions have their own suites. This one is about the answer
 * reaching the reader whole. Every case starts a process, so mutation testing
 * leaves this file out; `io.test.mjs` checks the input's shape in process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IO = new URL('../../../src/workflow/moments/io.mjs', import.meta.url).href;

let moment;
let dir;

beforeAll(() => {
  // The real path, because `serve` compares the started file with its own URL,
  // and the temp folder on macOS sits behind a symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'moment-io-')));
  moment = join(dir, 'echo-size.mjs');
  writeFileSync(moment, `
    import { serve } from ${JSON.stringify(IO)};
    await serve(import.meta.url, 'echo-size', { size: 'number' }, ({ size }) => {
      if (size < 0) throw new Error('a size below zero');
      return { text: 'x'.repeat(size) };
    });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (input) => spawnSync(process.execPath, [moment], {
  input: JSON.stringify(input),
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
});

describe('a moment command', () => {
  // A pipe on macOS holds 64 KB. Exiting straight after the write kept exactly
  // that much of a larger answer.
  it('writes an answer larger than the pipe holds, whole, before it exits', () => {
    const size = 500_000;
    const result = run({ size });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(JSON.stringify({ text: 'x'.repeat(size) }).length);
    expect(JSON.parse(result.stdout)).toEqual({ text: 'x'.repeat(size) });
  });

  it('writes a small answer and exits 0', () => {
    const result = run({ size: 3 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"text":"xxx"}');
  });

  // The decision crashing is a bug in the moment, and its stack says where.
  // It used to read "the answer could not be written", which sent the reader
  // to stdout.
  it('says the decision failed, with where, when it throws, and exits 1 with no answer', () => {
    const result = run({ size: -1 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^on echo-size: the decision failed: Error: a size below zero\n\s+at /);
    expect(result.stderr).not.toContain('could not be written');
  });

  it('refuses input that does not match its shape, with exit 2 and no answer', () => {
    const result = run({ size: 'big' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('on echo-size: refused, `size` must be number, and is "big".\n');
  });
});
