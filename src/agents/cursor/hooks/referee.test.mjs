/**
 * `ask`, against stand-ins for the referee that answer, crash, exit with a code,
 * or print something else. The real referee is asked by the machine suite, which
 * spawns the hooks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFEREE, ask } from './referee.mjs';

let dir;
const stub = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-referee-ask-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('asking the referee', () => {
  it('is the referee\'s one command', () => {
    expect(REFEREE).toMatch(/src\/workflow\/cli\/workflow\.mjs$/);
  });

  // The stand-in echoes what it was started with, so the case sees both the
  // arguments and the input.
  it('starts `on <moment>` with the input as JSON, and reads the answer', () => {
    const echo = stub('echo.mjs', `
      let raw = '';
      for await (const chunk of process.stdin) raw += chunk;
      process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: JSON.parse(raw) }));
    `);
    expect(ask('write', { write: true, exempt: false }, { program: echo }))
      .toEqual({ answer: { argv: ['on', 'write'], input: { write: true, exempt: false } } });
  });

  it('is a problem, not an answer, when the referee exits with a code other than 0', () => {
    const fails = stub('fails.mjs', 'process.stderr.write("on write: refused, `write` must be boolean.\\n"); process.exit(2);');
    const result = ask('write', {}, { program: fails });
    expect(result).not.toHaveProperty('answer');
    expect(result.problem).toBe('the referee (`on write`) exited with 2: on write: refused, `write` must be boolean.');
  });

  // The first lines, blank ones left out: a refusal's sentence and a crash's
  // error come first, and Node ends a crash with stack frames.
  it('keeps the first eight lines the referee wrote on stderr, and none of the blank ones', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const noisy = stub('noisy.mjs', `process.stderr.write(${JSON.stringify(`\n\n${lines.slice(0, 2).join('\n')}\n   \n${lines.slice(2).join('\n')}\n`)}); process.exit(3);`);
    expect(ask('write', {}, { program: noisy }).problem)
      .toBe(`the referee (\`on write\`) exited with 3: ${lines.slice(0, 8).join('\n')}`);
  });

  it('says only the exit code when the referee wrote nothing on stderr', () => {
    const quiet = stub('quiet.mjs', 'process.exit(4);');
    expect(ask('turn-end', { secondsLeft: 10 }, { program: quiet }))
      .toEqual({ problem: 'the referee (`on turn-end`) exited with 4' });
  });

  it('is a problem when the referee crashes', () => {
    const crashes = stub('crashes.mjs', 'throw new Error("kaboom");');
    expect(ask('prompt', {}, { program: crashes }).problem).toMatch(/^the referee \(`on prompt`\) exited with 1: [\s\S]*kaboom/);
  });

  it('is a problem when the referee prints something that is not JSON', () => {
    const chatty = stub('chatty.mjs', 'process.stdout.write("allowed, probably");');
    expect(ask('write', {}, { program: chatty })).toEqual({ problem: 'the referee (`on write`) printed something that is not JSON' });
  });

  it('is a problem when the referee prints JSON that is not an object', () => {
    for (const printed of ['true', '[]', 'null']) {
      const odd = stub(`odd-${printed}.mjs`, `process.stdout.write(${JSON.stringify(printed)});`);
      expect(ask('write', {}, { program: odd })).toEqual({ problem: 'the referee (`on write`) printed JSON that is not an object' });
    }
  });

  it('is a problem when the referee cannot be found', () => {
    expect(ask('write', {}, { program: join(dir, 'missing.mjs') }).problem).toMatch(/^the referee \(`on write`\) exited with 1/);
  });
});
