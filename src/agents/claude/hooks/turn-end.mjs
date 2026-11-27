#!/usr/bin/env node
/**
 * Stop. Hands the end of the turn to the referee (`on turn-end`), which holds the
 * freeze, runs verify, records what happened and says what comes next.
 *
 * What is Claude Code's stays here: `stop_hook_active`, which is the referee's
 * `stopRefusedBefore`, and the hook's timeout, read from the project's settings, which
 * becomes the referee's `secondsLeft`. The referee sets the mutation run from it,
 * because a hook that overruns is killed and its whole message is lost.
 */
import { readFileSync } from 'node:fs';
import { input, standAside, send, leave } from './io.mjs';
import { runByCursor } from './cursor.mjs';
import { expectFields } from './drift.mjs';
import { runaway } from './runaway.mjs';
import { stopTimeout } from '../registration.mjs';
import { ask } from './referee.mjs';
import { VERSION, forTurnEnd } from './translate.mjs';

const started = Date.now();

/** The project's settings as text, or null when the file cannot be read. */
function readSettings() {
  try {
    return readFileSync('.claude/settings.json', 'utf8');
  } catch {
    return null;
  }
}

let hook;
try {
  hook = await input();
} catch (error) {
  // Silence here would mean the gate did not run at all, which looks exactly
  // like passing. With no payload, `stop_hook_active` is unknown, so this is
  // read as a first pass and blocks.
  send({ via: 'block', text: `The workflow turn-end hook failed, so nothing was verified: ${error.message}` });
  await leave();
}
// Cursor runs this file too, beside its own adapter's hooks. Leave it to those.
if (runByCursor(hook)) await standAside();
expectFields(hook, {
  stop_hook_active: 'a block here can no longer be one-shot, and a turn could be held in a loop',
});
const stopRefusedBefore = hook?.stop_hook_active === true;

// Before the referee is asked, so nothing is read, recorded or shelled out to.
// After a refused stop it cannot block either, so a guard which ever misfired in
// a real session could not hold the turn in a loop.
const stray = runaway();
if (stray) {
  send({ via: stopRefusedBefore ? 'message' : 'block', text: stray });
  await leave();
}

const secondsLeft = stopTimeout(readSettings()) - (Date.now() - started) / 1000;
send(forTurnEnd(ask('turn-end', { version: VERSION, stopRefusedBefore, secondsLeft }), stopRefusedBefore));
await leave();
