#!/usr/bin/env node
/**
 * stop. Hands the end of the turn to the referee (`on turn-end`), which holds
 * the freeze, runs verify, records what happened and says what comes next.
 *
 * What is Cursor's stays here: `loop_count`, which is above 0 once a
 * follow-up from this hook has run, and becomes the referee's
 * `stopRefusedBefore`; and the hook's timeout, read from `.cursor/hooks.json`,
 * which becomes the referee's `secondsLeft`. The referee sets the mutation run
 * from it, because a hook that overruns is stopped and its whole message is
 * lost.
 *
 * Cursor has no way to refuse a stop. A `followup_message` is sent to the
 * agent as a new prompt instead, which is how the turn goes on and how a
 * report reaches the operator. `{}` lets the turn end.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { capturePlan } from '../plans.mjs';
import { input, enterRepository, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { runaway } from './runaway.mjs';
import { HOOKS_FILE, stopTimeout } from '../registration.mjs';
import { ask } from './referee.mjs';
import { VERSION, forTheOperator, forTurnEnd, joined, stopOutput } from './translate.mjs';

const started = Date.now();

const carry = (out, warning) => ({ followup_message: joined(forTheOperator(warning), out.followup_message) });

/** The project's hook registration as text, or null when it cannot be read. */
function readRegistration() {
  try {
    return readFileSync(HOOKS_FILE, 'utf8');
  } catch {
    return null;
  }
}

let hook;
try {
  hook = await input();
} catch (error) {
  // Silence here would mean the gate did not run at all, which looks exactly
  // like passing. With no payload, `loop_count` is unknown, so this is read
  // as a first pass and sends the failure back.
  await leave(stopOutput({ followup: forTheOperator(`The workflow turn-end hook failed, so nothing was verified: ${error.message}`) }), carry);
}
expectFields(hook, {
  loop_count: 'a follow-up can no longer be one-shot, and a turn could be held in a loop',
  transcript_path: 'a presented plan cannot be captured for validation',
  workspace_roots: 'the hook cannot find the repository, and asks the referee from its own folder',
});
const stopRefusedBefore = typeof hook?.loop_count === 'number' ? hook.loop_count > 0 : true;
const root = enterRepository(hook?.workspace_roots);

// Before the referee is asked, so nothing is read, recorded or shelled out to.
// After a follow-up it sends nothing either, so a guard which ever misfired in
// a real session could not hold the turn in a loop.
const stray = runaway();
if (stray) await leave(stopOutput({ followup: stopRefusedBefore ? undefined : forTheOperator(stray) }), carry);

const captured = capturePlan({ transcriptPath: hook?.transcript_path, root }, {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => writeFileSync(path, text, { flag: 'wx' }),
  makeFolder: (path) => mkdirSync(path, { recursive: true }),
  exists: existsSync,
});
const secondsLeft = stopTimeout(readRegistration()) - (Date.now() - started) / 1000;
const result = forTurnEnd(ask('turn-end', {
  version: VERSION, stopRefusedBefore, secondsLeft, planFile: captured.planFile ?? null,
}), stopRefusedBefore, captured.problem);
await leave(stopOutput(result), carry);
