import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * What `outside-ci.ts` promises. Run under `CI=true`, as GitLab runs it, both
 * fail if the setup file stops being registered or stops removing `CI`. The
 * script-parity fixture also runs these cases in its fast project with CI=true.
 */
it('runs every fast test without CI in its environment, whatever the runner sets', () => {
  expect(process.env.CI).toBeUndefined();
});

it('starts a process without CI too, because a child inherits the worker\'s environment', () => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.CI))'], { encoding: 'utf8' });
  expect(child.stdout).toBe('undefined');
});
