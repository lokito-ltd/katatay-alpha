/** How the referee starts its own files: always its own Node, with `tsx` only for TypeScript. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refereeCommand, runReferee } from './runtime.mjs';

describe('starting a referee file', () => {
  it('runs a JavaScript file with the Node that is running, and nothing else', () => {
    expect(refereeCommand('/x/a.mjs', ['--flag'])).toEqual({ program: process.execPath, args: ['/x/a.mjs', '--flag'] });
  });

  it('loads a TypeScript file through tsx, ahead of the file and its arguments', () => {
    const { program, args } = refereeCommand('/x/a.ts', ['--flag']);
    expect(program).toBe(process.execPath);
    expect(args.slice(0, 1)).toEqual(['--import']);
    expect(args[1]).toMatch(/tsx/);
    expect(args.slice(2)).toEqual(['/x/a.ts', '--flag']);
  });

  it('takes no arguments as none', () => {
    expect(refereeCommand('/x/a.mjs').args).toEqual(['/x/a.mjs']);
  });

  it('runs both kinds of file and hands back what they printed and how they ended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), 'console.log(process.argv.slice(2).join(","));process.exit(3);');
      writeFileSync(join(dir, 'b.ts'), 'const n: number = 4; console.log(`ts ${n} ${process.argv.slice(2).join(",")}`);');
      const js = runReferee(join(dir, 'a.mjs'), ['x', 'y'], { encoding: 'utf8' });
      expect([js.stdout, js.status]).toEqual(['x,y\n', 3]);
      const ts = runReferee(join(dir, 'b.ts'), ['z'], { encoding: 'utf8' });
      expect([ts.stdout, ts.status]).toEqual(['ts 4 z\n', 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
