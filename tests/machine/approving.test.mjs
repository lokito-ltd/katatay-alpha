/** Approving a requirement change in plan mode, as the real `req:guard` sees it.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ctx, machineFixture, approvePlan, git, publish } from '../support/machine/harness.mjs';

machineFixture();

const ROOT = resolve(import.meta.dirname, '../..');
const GUARD = join(ROOT, 'src/requirements/guard.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

const BEFORE = 'A visitor can find a project again.';
const AFTER = 'A visitor can find a project again, in the browser that started it.';

const requirement = (statement) => `---\nstatus: active\n---\n\n${statement}\n`;

/**
 * A branch that rewords an active requirement and records it in a change file,
 * which is everything the guard asks for except the approval.
 */
function rewordOnBranch() {
  mkdirSync(join(ctx.repo, 'requirements/acceptance'), { recursive: true });
  mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
  const file = join(ctx.repo, 'requirements/acceptance/AC0001__find_again.md');
  writeFileSync(file, requirement(BEFORE));
  git('add', '-A');
  git('commit', '--quiet', '-m', 'a requirement');
  publish();

  writeFileSync(file, requirement(AFTER));
  writeFileSync(
    join(ctx.repo, 'requirements/changes/20260924T000000.000Z__reword.md'),
    `---\nrequirements:\n  - id: AC0001\n    status: active\n    statement: ${AFTER}\n---\n\n# Reword\n\n## Departures\n\nNone.\n`,
  );
}

/** The real guard, run in the fixture. `CI` is removed unless the case sets it,
 *  so the suite behaves the same when it is itself running in CI. */
function guard({ ci = false } = {}) {
  const env = { ...process.env, HOME: ctx.home };
  delete env.CI;
  delete env.CI_MERGE_REQUEST_DESCRIPTION;
  if (ci) env.CI = 'true';
  return spawnSync(TSX, [GUARD], { cwd: ctx.repo, encoding: 'utf8', env });
}

// The acceptance tests in tests/acceptance/requirements/ cover the other cases
// this file held: AC0059.2–.6 and AC0061.1. This one has no scenario of its own.
describe('a requirement change approved in plan mode', () => {
  // A branch that gathers several changes before they reach the target carries
  // each change's logbook. A carried logbook whose plan did not approve the
  // rewording approves nothing.
  describe('on a branch that carries the approved change', () => {
    const carryToBatch = () => {
      git('add', '-A');
      git('commit', '--quiet', '-m', 'the reworded change, recorded');
      git('checkout', '--quiet', '-b', 'batch');
    };

    it('still refuses it when the carried plan did not approve it', () => {
      rewordOnBranch();
      approvePlan();
      carryToBatch();
      const run = guard();
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/AC0001: statement of an active requirement was reworded/);
    });
  });
});
