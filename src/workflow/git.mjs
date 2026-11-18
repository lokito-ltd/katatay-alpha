/**
 * The one way the workflow tools run git.
 *
 * Git writes to stderr whenever a command fails, and many failures here are
 * ordinary answers: no commits yet, a target that was never fetched, a path
 * git does not ignore. The caller catches those on purpose. But
 * `execFileSync` without a `stdio` option copies the child's stderr to this
 * process's own, so git's `fatal:` line was printed before the catch ran. Every
 * module used to choose for itself whether to print, discard or keep that
 * text, and one that forgot printed `fatal: ambiguous argument 'HEAD'` at the
 * top of every triage.
 *
 * So stderr is piped, never inherited. Any `stdio` option stops Node copying
 * it, and piping it, rather than discarding it, keeps git's text inside the
 * thrown error. A caller that lets the error reach the operator still says what
 * went wrong, and a caller that catches it prints nothing.
 *
 * The TypeScript tools under `src/evidence/` and `src/requirements/` use it
 * too: they already import from this directory, and a second helper would be
 * a second place to choose differently. `git.test.mjs` fails if a module in any
 * of the three runs git itself, so this stays the rule and not a habit.
 */
import { execFileSync } from 'node:child_process';

/**
 * Runs git and returns its stdout. Throws on a non-zero exit, with git's stderr
 * in the error's message and its stdout on `error.stdout`. Prints nothing.
 *
 * `options` go to `execFileSync` as they are, after the defaults, so a caller
 * can add a `cwd`, a `timeout` or an `env`.
 *
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string}
 */
export const gitText = (args, options = {}) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

/** `gitText`, split into its non-empty lines. */
export const gitLines = (args, options) => gitText(args, options).split('\n').filter(Boolean);
