#!/usr/bin/env node
/**
 * `workflow state verify` — every logbook in the repository still links up.
 *
 * Runs over every branch's logbook, not just the current one. They are committed,
 * so a merged logbook is history that a later branch could quietly edit.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_ROOT, currentBranch, dirFor } from '../chain.mjs';
import { alteredStateFiles } from '../tree.mjs';
import { target } from '../target.mjs';
import { baselinesIn, provedBaselines } from '../phase.mjs';
import { fetchTargetInCi, isAncestor } from '../baseline.mjs';
import { mergedCount, readLogbook } from '../state.mjs';
import { agentWarnings } from '../agent.mjs';

/**
 * A failure rather than a warning, unlike the check below. The setting
 * is a file the operator can write, and without it no change can be measured
 * from anything, so every other answer this command gives would be about
 * nothing.
 */
let t;
try {
  t = target();
  fetchTargetInCi(t);
} catch (error) {
  console.error(`state: ${error.message}`);
  process.exit(1);
}

/**
 * What the agent adapter says is wrong with the agent's setup: its hooks
 * missing, switched off or joined by strangers. The referee asks through the rulebook's
 * `agent.adapters.<name>.checkCommand`; `src/agents/README.md` says what it may report.
 *
 * Warnings and not failures, and it matters more here: a failure would be
 * unclearable. The agent's configuration is locked by the rulebook and
 * the user's settings are outside the repository, so no session can repair
 * either, and a red `workflow verify` would stop the change that noticed. It is
 * reported to the operator, who is the only one who can act on it. A check
 * that gives no answer is one of the warnings.
 *
 * The `Stop` hook and `state:show` print the same list. This command's output
 * is discarded by the hook when verify passes, so printed here alone the
 * warnings reached nobody on the ordinary path.
 */
for (const problem of agentWarnings()) {
  console.warn(`state: WARNING — ${problem}`);
}

if (!existsSync(STATE_ROOT)) {
  console.log('state: no logs yet');
  process.exit(0);
}

const here = dirFor(currentBranch());
const problems = [];
const baselineProblems = [];

// Every logbook is read through `readLogbook`, the same function the hooks
// use, so this command and the hooks cannot disagree about what is broken.
// Git is asked once for every committed event file that changed, and the
// folders of those files are read too: a committed logbook deleted whole has
// no folder left to list, and is broken all the same.
const altered = alteredStateFiles();
const dirs = [...new Set([...readdirSync(STATE_ROOT).map((name) => join(STATE_ROOT, name)), ...altered.map((file) => dirname(file))])].sort();

for (const dir of dirs) {
  // Every owner must match its directory. For the active logbook require
  // the exact branch too: two branch names can share a directory slug.
  const { entries, live, broken } = readLogbook(dir, {
    branch: dir === here ? currentBranch() : null,
    altered,
    mergedOf: (read) => mergedCount(read, dir, { ref: t.ref }),
  });
  if (broken) {
    problems.push(`${dir}: ${broken}`);
    continue;
  }
  // Every baseline a live change was measured from must be on the target, or
  // be vouched for by a `recorded` event after it. In CI the target is fetched
  // fresh first, so a baseline taken from a faked remote-tracking ref fails the
  // merge request here.
  //
  // A recorded baseline is trusted because recording proved it: the `Stop` hook
  // asks the server whether every baseline is on the target, and only then
  // writes `recorded`. This is what lets a batch branch merge. Its changes were
  // measured from commits on the batch, recorded against the batch as the
  // target, and those commits reach this target only when the batch merges.
  //
  // What that gives up: CI no longer repeats the proof for a recorded change.
  // The hook's proof lives in `src/`, which a branch can edit, so an edit that
  // skips it would no longer be caught here. Such an edit shows in the diff.
  // `req:risk` no longer scores `src/` HIGH, since the operator took it off
  // the high-risk list, so only a reviewer reading the diff sees it.
  const proved = new Set(provedBaselines(live));
  const stray = baselinesIn(live).filter((sha) => !proved.has(sha) && !isAncestor(sha, t.ref));
  if (stray.length > 0) {
    for (const sha of stray) baselineProblems.push(`${dir}: baseline ${sha} is not on ${t.name}`);
    continue;
  }
  console.log(`state: ${dir} ok (${entries.length} events)`);
}

if (baselineProblems.length > 0) {
  console.error('\nstate: a change was measured from a commit the target does not have.\n');
  for (const problem of baselineProblems) console.error(`  ${problem}`);
  console.error(`\nIts freeze and triage compared against the wrong place. Fetch ${t.name} and run this again; if it still fails, the baseline was never on the target. Stop and tell the operator.`);
}

if (problems.length > 0) {
  console.error('\nstate: a logbook is broken.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nEach line says how to mend it. Restore what it names from git rather than rebuilding it: these files record what happened, and rebuilt ones would only produce a logbook that agrees with itself.');
  process.exit(1);
}

if (baselineProblems.length > 0) process.exit(1);
