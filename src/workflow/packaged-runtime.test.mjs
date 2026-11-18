import { expect, it, vi } from 'vitest';
import { refereeCommand } from './runtime.mjs';
import { route } from './cli/workflow.mjs';
import { PROBE, startedAs } from './init.mjs';
import { GUARD } from './moments/turn-end.mjs';
import { VERIFY } from './verify-record.mjs';

vi.mock('../distribution.mjs', () => ({ packaged: true }));

it('starts compiled referee programs from the installation for both the CLI and hook children', () => {
  for (const [program, ending] of [
    [route(['req', 'lint']).file, '/requirements/lint.js'],
    [route(['on', 'write']).file, '/moments/write.mjs'],
    [PROBE, '/evidence/probe.js'], [GUARD, '/requirements/guard.js'], [VERIFY, '/cli/verify-change.js'],
  ]) {
    const child = refereeCommand(program, ['--flag']);
    expect(child.program).toBe(process.execPath);
    expect(child.args).toEqual([expect.stringMatching(/^\//), '--flag']);
    expect(child.args[0].endsWith(ending)).toBe(true);
  }
});

it('tells the operator how to run the installed command without naming the install or project directory', () => {
  const how = startedAs('/project path', '/first prefix/workflow.mjs');
  expect(how).toContain('`ktty verify`');
  expect(how).not.toMatch(/project path|first prefix/);
});

it('preserves install directories containing .ts when selecting a child program', () => {
  const dir = '/releases/suite.ts/katatay';
  expect(refereeCommand(`${dir}/probe.ts`).args).toEqual([`${dir}/probe.js`]);
  expect(refereeCommand(`${dir}/turn-end.mjs`).args).toEqual([`${dir}/turn-end.mjs`]);
});
