import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { USAGE } from '../../../src/workflow/cli/defaults.mjs';

const WORKFLOW = resolve('src/workflow/cli/workflow.mjs');
/** The real Claude command, as a command line: the referee never imports it. */
const CLAUDE = ['node', resolve('src/agents/claude/defaults.mjs')];

describe('the defaults subcommand', () => {

  // Started as the npm script starts it, through the referee's one command.
  it('prints the answer through workflow.mjs, and the reason on stderr when there is none', () => {
    const shownRun = spawnSync(process.execPath, [WORKFLOW, 'defaults', ...CLAUDE], { encoding: 'utf8' });
    expect(shownRun.status).toBe(0);
    expect(shownRun.stdout).toMatch(/^Proposed by `node .*defaults\.mjs`:\n/);
    const failed = spawnSync(process.execPath, [WORKFLOW, 'defaults', 'exit', '3'], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('gave no answer: it exited with 3.');
    const bare = spawnSync(process.execPath, [WORKFLOW, 'defaults'], { encoding: 'utf8' });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toBe(`${USAGE}\n`);
  });
});
