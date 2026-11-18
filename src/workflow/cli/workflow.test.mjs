/**
 * The referee's one command: which file each subcommand starts, and that the
 * `package.json` scripts, which are aliases for it, all reach one.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_SCHEMA_VERSION } from '../../schema-version.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROUTES, route, usage } from './workflow.mjs';

const WORKFLOW = fileURLToPath(new URL('./workflow.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const file = (path) => fileURLToPath(new URL(path, import.meta.url));

describe('the workflow command', () => {
  it('prints the shared schema version exactly once', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await import('./version.mjs');
      expect(output.mock.calls).toEqual([[HARNESS_SCHEMA_VERSION]]);
    } finally {
      output.mockRestore();
    }
  });

  it('prints the schema version from an empty directory with no rulebook', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'workflow-version-'));
    try {
      const run = spawnSync(process.execPath, [WORKFLOW, 'version'], { cwd, encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe(`${HARNESS_SCHEMA_VERSION}\n`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('starts a file that exists for every subcommand', () => {
    for (const [name, path] of Object.entries(ROUTES)) expect(existsSync(path), name).toBe(true);
  });

  it('passes the arguments after the subcommand on to the file', () => {
    expect(route(['req', 'guard', '--record'])).toEqual({ file: file('../../requirements/guard.ts'), args: ['--record'] });
    expect(route(['areas', '--staged'])).toEqual({ file: file('./areas.mjs'), args: ['--staged'] });
    expect(route(['mutate', '--budget', '30'])).toEqual({ file: file('../../evidence/mutate.ts'), args: ['--budget', '30'] });
  });

  it('reads a two-word subcommand as one, and a one-word subcommand with its arguments', () => {
    expect(route(['state', 'show'])).toEqual({ file: file('./show.mjs'), args: [] });
    expect(route(['state', 'verify'])).toEqual({ file: file('./verify.mjs'), args: [] });
    expect(route(['verify', 'state'])).toEqual({ file: file('./verify-change.ts'), args: ['state'] });
    expect(route(['verify', '--rerun'])).toEqual({ file: file('./verify-rerun.mjs'), args: [] });
    expect(route(['verify'])).toEqual({ file: file('./verify-change.ts'), args: [] });
  });

  // The moments an agent adapter starts, one file each.
  it('routes the moments to their files', () => {
    expect(route(['on', 'write'])).toEqual({ file: file('../moments/write.mjs'), args: [] });
    expect(route(['on', 'prompt'])).toEqual({ file: file('../moments/prompt.mjs'), args: [] });
    expect(route(['on', 'plan-approved'])).toEqual({ file: file('../moments/plan-approved.mjs'), args: [] });
    expect(route(['on', 'plan-presented'])).toEqual({ file: file('../moments/plan-presented.mjs'), args: [] });
    expect(route(['on', 'turn-end'])).toEqual({ file: file('../moments/turn-end.mjs'), args: [] });
    expect(route(['on'])).toBeNull();
  });

  // `in` would find these on every object, and start a function as a file.
  it('has no subcommand for a name every object inherits', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(route([name]), name).toBeNull();
      expect(route([name, 'x']), name).toBeNull();
    }
    const run = spawnSync(process.execPath, [WORKFLOW, 'toString'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toBe(`${usage()}\n`);
  });

  it('does not route a subcommand the referee does not have', () => {
    expect(route(['nonsense'])).toBeNull();
    expect(route(['state'])).toBeNull();
    expect(route([])).toBeNull();
  });

  it('lists every subcommand in its usage', () => {
    for (const name of Object.keys(ROUTES)) expect(usage().split('\n')).toContain(`  ${name}`);
  });

  it('is what every script that starts a referee file in package.json is an alias for', () => {
    const aliases = Object.entries(manifest.scripts).filter(([, command]) => command.includes('workflow.mjs'));
    expect(aliases.map(([name]) => name).sort()).toEqual([
      'agent:defaults', 'checks-analysis', 'coverage:check', 'mutate', 'replan', 'report', 'req:guard', 'req:lint', 'req:renumber', 'req:risk', 'req:trace', 'review:areas', 'state:show', 'state:verify', 'triage', 'verify', 'workflow:version',
    ]);
    for (const [name, command] of aliases) {
      const words = command.replace('node src/workflow/cli/workflow.mjs ', '').split(' ');
      expect(route(words), name).not.toBeNull();
    }
  });
});
