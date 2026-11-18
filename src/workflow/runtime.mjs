/**
 * How the referee starts its own files. This is the one place that knows the referee
 * is partly TypeScript and loads it through `tsx`.
 *
 * Everything that starts a referee file goes through here: the `workflow.mjs`
 * command, and the `Stop` hook when it runs the verify, the mutation testing
 * and the guard. The program is always the Node that is already running, so
 * nothing is looked up on `PATH`, and a repository in another language needs
 * nothing installed for the referee to start itself.
 *
 * Which loader the referee uses is a fact about the referee, not about the project
 * it checks. If the TypeScript ever becomes plain JavaScript, only this file
 * changes.
 */
import { packaged } from '../distribution.mjs';
import { spawnSync } from 'node:child_process';

/**
 * The program and arguments that start `file` with `args`. `tsx` is resolved
 * only for a `.ts` file, so a hook that starts nothing written in TypeScript
 * never needs anything from `node_modules`.
 */
export function refereeCommand(file, args = []) {
  if (packaged) return { program: process.execPath, args: [file.replace(/\.ts$/, '.js'), ...args] };
  const loader = file.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
  return { program: process.execPath, args: [...loader, file, ...args] };
}

/** `spawnSync` on a referee file. `options` go to it as they are. */
export function runReferee(file, args = [], options = {}) {
  const { program, args: argv } = refereeCommand(file, args);
  return spawnSync(program, argv, options);
}
