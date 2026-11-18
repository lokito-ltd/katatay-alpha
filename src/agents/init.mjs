#!/usr/bin/env node
/**
 * `init` with every agent adapter this harness has: Claude Code and Codex.
 *
 * The referee knows no agent, so its `init` is told which adapters to set
 * up, as `--agent <label>=<defaults command>`. This launcher sits beside the
 * adapters and names them, by absolute path, so it works from any folder:
 * the project to set up is `--project <dir>`, or the folder npm was started
 * from, or the working directory (see `../workflow/cli/init.mjs`). Every
 * other argument is passed on, as stdin and the terminal are.
 *
 * Once the harness is packaged, its own command takes this file's place.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The referee's command. */
export const WORKFLOW = join(HERE, '..', 'workflow', 'cli', 'workflow.mjs');

/** Each adapter, by its label in the rulebook and its `defaults` script. */
export const ADAPTERS = [
  ['claude', join(HERE, 'claude', 'defaults.mjs')],
  ['codex', join(HERE, 'codex', 'defaults.mjs')],
];

/** The arguments `node` gets: the referee's `init`, every adapter, then `argv`. */
export const initArguments = (argv) => [
  WORKFLOW,
  'init',
  ...ADAPTERS.flatMap(([label, script]) => ['--agent', `${label}=node ${JSON.stringify(script)}`]),
  ...argv,
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = spawnSync(process.execPath, initArguments(process.argv.slice(2)), { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
