#!/usr/bin/env node
/**
 * The referee's one command. Each subcommand starts one of the referee's own files
 * and passes the rest of the arguments to it, so `workflow.mjs req guard
 * --record` is `guard.ts --record`. A project may give these aliases of its
 * own, such as npm scripts. The referee's messages name the subcommands as
 * `workflow <subcommand>`, and the project's instructions say how that is
 * started there.
 *
 * The files keep their own logic and exit codes. This only says which file
 * each subcommand is, and starts it through `../runtime.mjs`, the one file that
 * knows how the referee loads its TypeScript.
 */
import { fileURLToPath } from 'node:url';
import { runReferee } from '../runtime.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Subcommand, as typed after `workflow.mjs`, to the file it starts. */
export const ROUTES = {
  version: here('./version.mjs'),
  verify: here('./verify-change.ts'),
  // Verify and record the result, as the turn end would. Its own file, so the
  // verify the hook starts never records anything itself.
  'verify --rerun': here('./verify-rerun.mjs'),
  triage: here('./triage.ts'),
  replan: here('./replan.mjs'),
  'state show': here('./show.mjs'),
  'state verify': here('./verify.mjs'),
  areas: here('./areas.mjs'),
  coverage: here('./coverage.mjs'),
  mutate: here('../../evidence/mutate.ts'),
  // An agent adapter's defaults, as `init` asks them, for a person to read.
  defaults: here('./defaults.mjs'),
  // Sets up a project: git, the rulebook, the requirements folder and each
  // agent's instructions and hooks. See `../init.mjs`.
  init: here('./init.mjs'),
  'checks-analysis': here('./checks-analysis.mjs'),
  report: here('../../evidence/report.ts'),
  'req lint': here('../../requirements/lint.ts'),
  'req guard': here('../../requirements/guard.ts'),
  'req trace': here('../../evidence/trace.ts'),
  'req risk': here('../../evidence/risk.ts'),
  'req renumber': here('../../requirements/renumber.ts'),
  // The moments: the points where an agent hands control to the workflow.
  // An agent adapter starts these with JSON on stdin and reads JSON back. See
  // `../moments/io.mjs` and `src/agents/README.md`.
  'on write': here('../moments/write.mjs'),
  'on prompt': here('../moments/prompt.mjs'),
  'on plan-approved': here('../moments/plan-approved.mjs'),
  'on plan-presented': here('../moments/plan-presented.mjs'),
  'on turn-end': here('../moments/turn-end.mjs'),
};

/** The file and the arguments left over for it, or `null` for a subcommand the
 *  referee does not have. A two-word subcommand wins over its first word.
 *  Only names `ROUTES` defines itself count: `in` would also find `toString`
 *  and `constructor`, which every object inherits, and start a function. */
export function routeName(argv) {
  if (!argv[0] || argv[0].includes(' ')) return null;
  const two = `${argv[0]} ${argv[1]}`;
  if (Object.hasOwn(ROUTES, two)) return two;
  return Object.hasOwn(ROUTES, argv[0]) ? argv[0] : null;
}

export function route(argv) {
  const name = routeName(argv);
  if (name === null) return null;
  return { file: ROUTES[name], args: argv.slice(name.split(' ').length) };
}

export const usage = () => `usage: workflow.mjs <subcommand> [arguments]\n\nsubcommands:\n${Object.keys(ROUTES).map((name) => `  ${name}`).join('\n')}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = route(process.argv.slice(2));
  if (found === null) {
    console.error(usage());
    process.exit(2);
  }
  const run = runReferee(found.file, found.args, { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
