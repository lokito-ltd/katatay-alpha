/**
 * The target, for the throwaway repositories the unit tests build.
 *
 * Every workflow script refuses to run without `.katatay/rulebook.json` naming a
 * remote git knows, so a fixture repository needs both. The remote points at a
 * path that does not exist: these tests never fetch, and a fetch that did run
 * would fail at once rather than reach for the network.
 *
 * The config holds this repository's adapter section too, because the freeze
 * and every tool that asks which files are tests refuse without one. See
 * `adapter.mjs` beside this file.
 *
 * `markTarget` stands in for the target holding a commit. The tools compare
 * against the remote-tracking ref, so moving that ref is what "this is on the
 * target" means to them, with no server involved.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeConfig } from './adapter.mjs';

export const TARGET_REF = 'refs/remotes/origin/main';

export function configureTarget(repo) {
  writeConfig(repo);
  execFileSync('git', ['remote', 'add', 'origin', join(repo, '.no-such-remote')], { cwd: repo });
}

export function markTarget(repo, rev = 'HEAD') {
  execFileSync('git', ['update-ref', TARGET_REF, rev], { cwd: repo });
}
