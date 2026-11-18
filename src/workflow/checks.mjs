/**
 * Running one check: an entry of the rulebook's `checks` chains (see
 * `parseChecks` in `rulebook.mjs`), such as a lint, a security scan or the
 * build.
 *
 * The referee reads a check by its exit code and passes its text on. It never
 * reads a finding: what counts as one is the tool's business, and the
 * rulebook's `exitCodes` say which codes mean the tool found something, which
 * mean it found nothing, and which mean it could not check. A code nobody
 * listed means it could not check, so a crash never reads as a clean run.
 *
 * Two placeholders let a tool limit itself to this change. Without them, a
 * scanner switched on in old code finds hundreds of old problems and blocks
 * every change.
 *
 * - `{baseline}` is the sha the change is measured from.
 * - `{changedFiles}` is every file changed since the baseline that is still on
 *   disk, each quoted for a POSIX shell. When the command names it and no file
 *   changed, the check is skipped, because many tools given no file check the
 *   whole project.
 *
 * Verify runs every check (`referee-verify.ts`). This module only runs one and
 * says how it ended. Plain Node, as the rest of `src/workflow/`.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles } from './frozen.mjs';
import { gitText } from './git.mjs';
import { current } from './state.mjs';
import { target } from './target.mjs';
import { checkIdentity, invalidateOutput, saveCheckOutput } from './check-output.mjs';

/** A path quoted for a POSIX shell: in single quotes, with each single quote
 *  closed, escaped and reopened. */
export const shellQuote = (text) => `'${text.split("'").join("'\\''")}'`;

/** Which placeholders a command names. */
export const placeholdersIn = (command) => ({
  baseline: command.includes('{baseline}'),
  changedFiles: command.includes('{changedFiles}'),
});

/**
 * The command with its placeholders filled in.
 *
 * @param {string} command
 * @param {{ baseline?: string, files?: string[] }} values
 */
export const commandWith = (command, { baseline = '', files = [] }) =>
  command.split('{baseline}').join(baseline).split('{changedFiles}').join(files.map(shellQuote).join(' '));

/**
 * The sha this change is measured from: the one the logbook pinned, or, with
 * no live plan, where `HEAD` meets the target. Asked only when a command
 * names a placeholder, so a check that names none runs where there is no
 * target at all.
 *
 * `pinned` asks the logbook. A test gives its own.
 */
export function baselineSha({ pinned: logbook = () => current().baseline } = {}) {
  const pinned = logbook();
  if (pinned) return pinned;
  return gitText(['merge-base', 'HEAD', target().ref]).trim();
}

/** The files changed since `base` that are still files on disk, from the
 *  repository at `root`. A deleted file is no file for a tool to read. */
export function filesOnDisk(base, root = process.cwd()) {
  return changedFiles(base).filter((file) => {
    try {
      return statSync(join(root, file)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Runs one check and says how it ended.
 *
 * `outcome` is the meaning of its exit code, from the entry's `exitCodes`, or:
 *
 * - `broken` for a code the entry does not list, a signal, a run that could
 *   not start, and a run stopped at the time limit;
 * - `skipped` when the command names `{changedFiles}` and no file changed.
 *
 * `text` is what it printed, stdout and then stderr, with trailing space
 * taken off. `reason` says in words why it ended so, for a line of output.
 *
 * `baseline` and `files` are asked only when the command needs them, so a test
 * can give its own.
 *
 * @param {import('./rulebook.mjs').Check} check
 * @param {{ root?: string, baseline?: () => string, files?: (base: string) => string[], capture?: (stdout: string, stderr: string) => void }} [options]
 * @returns {{ outcome: 'clean' | 'findings' | 'broken' | 'skipped', code: number | null, text: string, reason: string }}
 */
export function executeCheck(check, { root = process.cwd(), baseline = baselineSha, files = (base) => filesOnDisk(base, root), capture } = {}) {
  const needs = placeholdersIn(check.command);
  const values = {};
  if (needs.baseline || needs.changedFiles) values.baseline = baseline();
  if (needs.changedFiles) {
    values.files = files(values.baseline);
    if (values.files.length === 0) {
      return { outcome: 'skipped', code: null, text: '', reason: 'skipped: no file changed since the baseline' };
    }
  }

  const line = commandWith(check.command, values);
  const run = spawnSync(line, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: check.timeLimitSeconds * 1000,
    maxBuffer: 512 * 1024 * 1024,
  });
  capture?.(run.stdout ?? '', run.stderr ?? '');
  const coverage = check.chain === 'testQuality' && check.name === 'coverage';
  const text = `${coverage ? '' : run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\s+$/, '');
  const broken = (reason) => ({ outcome: 'broken', code: run.status ?? null, text, reason });

  if (run.error?.code === 'ETIMEDOUT') return broken(`broke: still running after ${check.timeLimitSeconds} seconds, so it was stopped`);
  if (run.error) return broken(`broke: could not be started (${run.error.message})`);
  if (run.status === null) return broken(`broke: stopped by ${run.signal}`);
  if (coverage && run.status !== 0) return broken(`broke: coverage command exited ${run.status}`);
  const meaning = check.exitCodes[String(run.status)];
  if (meaning === undefined) {
    return broken(`broke: exited ${run.status}, which "checks.${check.chain}.${check.name}.exitCodes" does not list`);
  }
  if (meaning === 'broken') return broken(`broke: exited ${run.status}, which its exit codes say means broken`);
  return { outcome: meaning, code: run.status, text, reason: meaning === 'clean' ? 'clean' : `findings (exit ${run.status})` };
}

/**
 * Runs an ordinary check, and saves its result when the entry names an
 * output. Coverage uses `executeCheck` and saves only after reading its LCOV.
 *
 * An error raised here is thrown, never returned as a "broken" result. It
 * comes from the harness's own setup, such as no target to find the baseline
 * from or an output file git tracks, not from the check's command. Returned
 * as a result, a check whose `onFailure` is `report` would print it and let
 * verify go on. Thrown, verify refuses: the rulebook errors here are
 * `TargetError`s, which `runVerify` reports as a refusal, and anything else
 * is a bug, which fails verify with its stack.
 *
 * @returns {ReturnType<typeof executeCheck>}
 */
export function runCheck(check, options = {}) {
  const root = options.root ?? process.cwd();
  invalidateOutput(check, root);
  const identity = check.output ? checkIdentity(root) : null;
  const result = executeCheck(check, options);
  saveCheckOutput(check, result, identity, root);
  return result;
}
