import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The reporter in a real Vitest run, against files written to fail in the ways
 * Vitest's own JUnit reporter gets wrong. It runs as a process, so mutation
 * testing leaves this file out; `vitest-junit-reporter.test.ts` holds the cases that
 * run in process.
 */
describe('the JUnit reporter in a real run', () => {
  let root: string;
  let xml: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'junit-reporter-')));
    const write = (name: string, lines: string[]) => writeFileSync(join(root, name), `${lines.join('\n')}\n`);
    // One worker: this run sits inside the suite, and a pool per run across
    // every core starved the end-to-end tests of the run around it on 2026-10-20.
    write('vitest.config.ts', ["export default { test: { includeTaskLocation: true, maxWorkers: 1, fileParallelism: false, include: ['*.test.ts'] } };"]);
    write('mixed.test.ts', [
      "import { expect, it } from 'vitest';",
      "it('passes [AC0001.1]', () => {",
      '  expect(1).toBe(1);',
      '});',
      "it('fails', () => { expect(1).toBe(2); });",
      "it.fails('is inverted', () => { throw new Error('x'); });",
      "it.skip('is skipped', () => {});",
    ]);
    write('hook.test.ts', [
      "import { beforeAll, it } from 'vitest';",
      "beforeAll(() => { throw new Error('setup broke'); });",
      "it('never runs [AC0002.1]', () => {});",
    ]);
    write('broken.test.ts', ["import './missing.js';", "import { it } from 'vitest';", "it('cannot load [AC0003.1]', () => {});"]);
    // The worker's own variables would make the Vitest started here think it
    // is a worker of this run.
    const env: NodeJS.ProcessEnv = { ...process.env, JUNIT_REPORT: join(root, 'out.xml') };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
    const run = spawnSync('npx', ['vitest', 'run', '--root', root, '--reporter', resolve('src/adapters/typescript/vitest-junit-reporter.ts')], { encoding: 'utf8', env });
    expect(run.status, run.stderr).toBe(1);
    xml = readFileSync(join(root, 'out.xml'), 'utf8');
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names each test with its file and the lines it spans', () => {
    expect(xml).toMatch(/<testcase name="passes \[AC0001\.1\]" classname="mixed\.test\.ts" file="mixed\.test\.ts">\s*<properties>\s*<property name="line" value="2"\/>\s*<property name="endLine" value="4"\/>\s*<property name="inverted" value="false"\/>/);
  });

  it('marks a failure, a skip, and a test under .fails', () => {
    expect(xml).toMatch(/<testcase name="fails"[\s\S]*?<failure message="expected 1 to be 2[^"]*"\/>/);
    expect(xml).toMatch(/<testcase name="is inverted"[\s\S]*?<property name="inverted" value="true"\/>/);
    expect(xml).toMatch(/<testcase name="is skipped"[\s\S]*?<skipped\/>/);
  });

  // Vitest's own reporter writes the first as passed and the second as one
  // failure with no tags. Left out, the referee fails each whole file, with
  // every tag in it.
  it('leaves out a file whose hook threw, and a file that could not load', () => {
    expect(xml).not.toContain('hook.test.ts');
    expect(xml).not.toContain('never runs');
    expect(xml).not.toContain('broken.test.ts');
  });
});
