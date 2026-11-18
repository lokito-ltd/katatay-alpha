/**
 * The referee's one command, started as a process: what reaches stdin and
 * stdout through it, and the exit code. Mutation testing leaves this file out,
 * because a mutant is never on in another process; which file each subcommand
 * starts is read in process in `workflow.test.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW = fileURLToPath(new URL('../../../src/workflow/cli/workflow.mjs', import.meta.url));

describe('the workflow command', () => {
  // stdin is passed through to the moment, and its answer and exit code back.
  it('carries a moment\'s input and answer through, and its refusal of bad input', () => {
    const refused = spawnSync(process.execPath, [WORKFLOW, 'on', 'write'], { input: '{"version":1,"writes":"yes"}', encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('on write: refused, `writes` must be list of { path, delete }, and is "yes"; `command` must be string or null, and is missing.');
    const notJson = spawnSync(process.execPath, [WORKFLOW, 'on', 'prompt'], { input: 'hello', encoding: 'utf8' });
    expect(notJson.status).toBe(2);
    expect(notJson.stderr).toMatch(/^on prompt: the input is not JSON/);
  });

  it.each([undefined, null, '1', 2, 1])('reads a write request with version %j', version => {
    const input = JSON.stringify({ version, writes: [], command: null });
    const run = spawnSync(process.execPath, [WORKFLOW, 'on', 'write'], { input, encoding: 'utf8' });
    if (version === 1) {
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ version: 1, allow: true });
    } else {
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('`version` must be 1, and is ' + (JSON.stringify(version) ?? 'missing'));
      expect(run.stdout).toBe('');
    }
  });

  it('exits with 2 and prints the usage on a subcommand it does not have', () => {
    const run = spawnSync(process.execPath, [WORKFLOW, 'nonsense'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: workflow.mjs');
  });

  it("starts the file, a TypeScript one included, and exits with the file's own code", () => {
    const run = spawnSync(process.execPath, [WORKFLOW, 'req', 'lint'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('catalogue OK');
    expect(run.status).toBe(0);
  });
});
