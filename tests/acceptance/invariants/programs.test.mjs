import { it } from 'vitest';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { whenKttyRuns } from '../support/ktty.mjs';
import {
  givenAWorkingBranch, givenFileContents, givenRulebookChanges, planFile, whenHookRuns,
} from '../support/project.mjs';
import { givenACheck, givenCoverage, givenMutation } from '../support/checks.mjs';
import { thenContains, thenValuesEqual } from '../support/assertions.mjs';

// The marker a command named by the rulebook or the command line exports, so
// every shim it reaches logs as named rather than as the referee's own.
const marker = 'KTTY_NAMED_COMMAND';
const named = command => `export ${marker}=1; ${command}`;

// Every program name on the folder's PATH, after the ktty launcher, gets a
// shim. A shim logs who started it and its name, then runs the real program
// with the real PATH, so only what ktty itself starts by name is logged.
// Returns the folder with the shims on its PATH and the log's path.
function givenLoggingShims(folder) {
  const root = dirname(folder.cwd);
  const [launcher, ...real] = folder.env.PATH.split(delimiter);
  const shims = join(root, 'shims');
  const log = join(root, 'programs.log');
  const script = join(root, 'shim.sh');
  mkdirSync(shims);
  writeFileSync(script, [
    '#!/bin/sh',
    `if test -n "$${marker}"; then who=named; else who=referee; fi`,
    'printf \'%s %s\\n\' "$who" "${0##*/}" >> "$SHIM_LOG"',
    'PATH="$SHIM_REAL_PATH" exec "${0##*/}" "$@"', '',
  ].join('\n'), { mode: 0o755 });
  for (const dir of real) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const target = join(shims, name);
      if (existsSync(target)) continue;
      try {
        if (!statSync(join(dir, name)).isFile()) continue;
        accessSync(join(dir, name), constants.X_OK);
      } catch { continue; }
      symlinkSync(script, target);
    }
  }
  const env = { ...folder.env, PATH: [launcher, shims].join(delimiter), SHIM_LOG: log, SHIM_REAL_PATH: real.join(delimiter) };
  return { shimmed: { ...folder, env }, log };
}

// Each command the rulebook names, wrapped so it exports the marker.
function givenTheRulebookCommandsAreMarked(folder) {
  const mark = node => {
    if (Array.isArray(node)) return node.forEach(mark);
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'command' || key === 'checkCommand') && typeof value === 'string' && value !== 'none') node[key] = named(value);
      else mark(value);
    }
  };
  givenRulebookChanges(folder, mark);
}

const whenProgramsAreRead = log => existsSync(log)
  ? readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' '))
  : [];

// It runs every referee command in turn, so it takes about 22 seconds alone,
// the slowest case in the suite. The slow run's default 30 seconds left too
// little room under load, so it gets its own limit.
it("Every referee command run through ktty, with logging shims on PATH, starts only git, its own runtime and the commands the rulebook or its arguments name. [INV0004.1]", () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenMutation(folder);
  givenACheck(folder, 'codeQuality', 'lint');
  givenTheRulebookCommandsAreMarked(folder);
  const { shimmed, log } = givenLoggingShims(folder);
  const agents = ['--agent', 'claude=' + named('ktty agent claude defaults'), '--agent', 'codex=' + named('ktty agent codex defaults')];
  const run = args => whenKttyRuns(args, { in: shimmed });
  const moment = (name, fields) => whenHookRuns(shimmed, name, fields);

  for (const args of [['version'], ['path'], ['help'], ['state', 'show'], ['state', 'verify'], ['areas'],
    ['req', 'lint'], ['req', 'trace'], ['req', 'guard'], ['req', 'risk'], ['req', 'renumber', 'AC0001', 'AC0002'],
    ['init', '--probe', ...agents], ['defaults', named('ktty agent claude defaults')]]) run(args);
  moment('prompt', { prompt: 'Hello.' });
  moment('write', { writes: [{ path: 'src/add.sh', delete: false }], command: null });
  moment('plan-presented', { planFile });
  moment('plan-approved', { planFile });
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  for (const args of [['triage'], ['coverage'], ['replan'], ['replan', '--resume'], ['verify'], ['verify', '--rerun'],
    ['checks-analysis', '1'], ['mutate']]) run(args);
  moment('write', { writes: [], command: 'cat src/add.sh' });
  moment('turn-end', { stopRefusedBefore: false, secondsLeft: 300 });
  moment('prompt', { prompt: 'record' });
  run(['report']);
  moment('turn-end', { stopRefusedBefore: false, secondsLeft: 300 });
  moment('prompt', { prompt: 'reset' });
  run(['state', 'show']);

  // `node` by name is allowed as the runtime: `init --probe` runs the agent
  // adapters' install commands, which their defaults name as `node <file>`.
  // The launcher's folder holds no shims, so a `ktty` it starts, such as the
  // default adapters ktty adds to init, is not logged at all.
  const programs = whenProgramsAreRead(log);
  const own = [...new Set(programs.filter(([who]) => who === 'referee').map(([, name]) => name))].sort();
  const others = programs.filter(([who]) => who === 'named').map(([, name]) => name);
  thenValuesEqual(own.filter(name => name !== 'git' && name !== 'node'), []);
  thenContains(own, 'git');
  thenContains(others, 'cat');
}, 90_000);
