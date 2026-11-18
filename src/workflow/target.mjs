/**
 * Which branch a change is measured against and merges into.
 *
 * Read from the `targetBranch` field of the rulebook, `.katatay/rulebook.json`
 * (see `rulebook.mjs`):
 *
 *     { "version": 1, "targetBranch": "origin/main" }
 *
 * The value is a remote and a branch in one, split at the first `/`: the remote
 * the server is asked through, and the branch on it that changes merge into.
 * The tools compare against `origin/main`, the remote-tracking ref, rather than
 * a local `main`. The server is what a change is measured against, and the
 * remote-tracking ref is this repository's last reading of it.
 *
 * There is no default, on purpose. A default would let every script run in a
 * repository nobody configured, measuring changes against a branch nobody
 * chose. So a missing file, a missing key, a value that is not
 * `<remote>/<branch>`, or a remote git does not know are each refused, by every
 * entry point, with the same message.
 *
 * The file sits under `.katatay/`, which the referee's locks keep sessions
 * out of, so a session cannot point the tools at a branch of its choosing.
 */
import { CONFIG, TargetError, parseRulebook, parseTargetBranch, readConfig } from './rulebook.mjs';
import { gitLines } from './git.mjs';

export { CONFIG, TargetError };

/** The setting as written, parsed and checked, without asking git anything. */
export const parseTarget = (text) => parseTargetBranch(parseRulebook(text));

/**
 * The target, or a `TargetError` saying why there is none.
 *
 * Asks git whether the remote exists, because a remote named wrongly would
 * otherwise surface later as a fetch that fails, which the tools read as the
 * server being down. That is a different situation with a different fix.
 *
 * @returns {{ remote: string, branch: string, ref: string, name: string }}
 *   `ref` is the full remote-tracking ref, `name` the setting as written.
 */
export function target() {
  const parsed = parseTargetBranch(readConfig());
  const remotes = gitLines(['remote']);
  if (!remotes.includes(parsed.remote)) {
    throw new TargetError(
      `${CONFIG} names the remote "${parsed.remote}", and git has no remote by that name. The workflow refuses to run without it. The operator edits ${CONFIG}.`,
    );
  }
  return parsed;
}
