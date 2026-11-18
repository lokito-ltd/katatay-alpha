#!/usr/bin/env node
/**
 * `workflow mutate` — mutation testing on the lines this change added or
 * changed since its baseline. This manual command and verify's quality check
 * call the same mutation implementation. Only the turn-end hook records an
 * outcome, from the results of a complete passing verify.
 *
 * Options:
 *
 * - `--base <sha>` measures from that commit instead of the baseline the logbook
 *   pins. For trying it on a merged change, or on a branch with no plan.
 * - `--budget <seconds>` stops the run after that long, or after
 *   the rulebook's `checks.testQuality.mutation.timeLimitSeconds`, whichever comes first, and
 *   reports what it checked by then.
 *   Without a budget a run by hand has no limit.
 * - `--verbose` asks the adapter for its tool's own log, for finding out why a
 *   run failed or showed nothing.
 * - `--json` prints `{ lines, outcome, findings? }` instead of the lines alone.
 *
 * Exits as the mutation command did: 0 when no mutant survived by the tool's
 * account, or nothing was asked; 1 when mutants survived; 2 when the run proves
 * nothing. 3 means it failed. See `EXIT` in `mutants.ts`. What it prints is
 * meant to be read whichever way it ends.
 */
import { current } from '../workflow/state.mjs';
import { mutate } from './mutants.js';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const outcome = await mutate({
  base: option('--base') ?? current().baseline,
  cwd: process.cwd(),
  budget: Number(option('--budget')),
  verbose: process.argv.includes('--verbose'),
});
// The exit waits for the report to be written. The hook reads it through a
// pipe, and `process.exit` does not wait for one to drain; `fs.writeSync`
// stops part way on a pipe that does not block, once past its buffer. A long
// list of survivors can be past it.
const text = process.argv.includes('--json')
  ? JSON.stringify({ lines: outcome.lines, outcome: outcome.outcome, ...(outcome.findings === undefined ? {} : { findings: outcome.findings }) })
  : outcome.lines.join('\n');
process.stdout.write(`${text}\n`, () => process.exit(outcome.code));
