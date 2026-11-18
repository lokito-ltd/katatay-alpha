import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run the real executable through a pipe. Replace only the Stryker worker:
// thousands of survivors make its answer larger than a pipe buffer.
it('delivers the entire mutation report on stdout and worker diagnostics on stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'long-mutation-output-'));
  try {
    writeFileSync(join(root, 'worker.cjs'), `process.once('message', () => {
      console.log('worker diagnostic');
      const results = Array.from({ length: 6000 }, (_, i) => ({
        fileName: 'src.ts', location: { start: { line: i + 1 } }, mutatorName: 'EqualityOperator',
        replacement: 'true', status: 'Survived', testsCompleted: 1,
      }));
      process.send({ results }, () => process.disconnect());
    });`);
    writeFileSync(join(root, 'worker-stand-in.cjs'), `const cp = require('node:child_process');
      const fork = cp.fork;
      cp.fork = (path, ...args) => fork(path.endsWith('/stryker-child.mjs') ? require.resolve('./worker.cjs') : path, ...args);
      require('node:module').syncBuiltinESMExports();`);
    const r = spawnSync(process.execPath, ['--require', join(root, 'worker-stand-in.cjs'), '--import',
      resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/adapters/typescript/stryker-mutate.ts'), '--vitest-config', 'vitest.config.ts'],
    { cwd: root, encoding: 'utf8', input: JSON.stringify({ targets: [{ file: 'src.ts' }], budget: null }) });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('worker diagnostic');
    expect(r.stdout.split('\n')).toEqual(['6000 mutants: 0 caught, 6000 survived.', 'Survived:',
      ...Array.from({ length: 6000 }, (_, i) => `- src.ts:${i + 1} EqualityOperator → true`), '']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
