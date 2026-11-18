#!/usr/bin/env node
/**
 * Stop. Hands the end of the turn to the referee (`on turn-end`), which holds
 * the freeze, runs verify, records what happened and says what comes next.
 *
 * What is Codex's stays here: `stop_hook_active`, which is the referee's
 * `stopRefusedBefore`, and the hook's timeout, read from `.codex/hooks.json`,
 * which becomes the referee's `secondsLeft`. The referee sets the mutation run
 * from it, because a hook that overruns is stopped and its whole message is
 * lost.
 *
 * Codex needs JSON from a Stop hook, so this always prints an object, `{}`
 * when there is nothing to say.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { capturePlan } from '../plans.mjs';
import { input, enterRepository, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { runaway } from './runaway.mjs';
import { HOOKS_FILE, stopTimeout } from '../registration.mjs';
import { ask } from './referee.mjs';
import { VERSION, forTurnEnd, stopOutput, triageReplyId } from './translate.mjs';

const started = Date.now();

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
  // like passing. With no payload, `stop_hook_active` is unknown, so this is
  // read as a first pass and refuses the stop.
  const text = `The workflow turn-end hook failed, so nothing was verified: ${error.message}`;
  await leave(stopOutput({ block: text, operator: text }));
}
expectFields(hook, {
  stop_hook_active: 'a refused stop can no longer be one-shot, and a turn could be held in a loop',
  transcript_path: 'a presented plan cannot be captured for validation',
  turn_id: 'a presented plan cannot be distinguished from an older plan',
});
const stopRefusedBefore = hook?.stop_hook_active === true;
const root = enterRepository(hook?.cwd);

// Before the referee is asked, so nothing is read, recorded or shelled out to.
// After a refused stop it cannot refuse again either, so a guard which ever
// misfired in a real session could not hold the turn in a loop.
const stray = runaway();
if (stray) await leave(stopOutput({ block: stopRefusedBefore ? undefined : stray, operator: stray }));

const captured = capturePlan({
  transcriptPath: hook?.transcript_path, turnId: hook?.turn_id,
  lastAssistantMessage: hook?.last_assistant_message, root,
}, {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => writeFileSync(path, text),
  makeFolder: (path) => mkdirSync(path, { recursive: true }),
  exists: existsSync,
  wait: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
});
const secondsLeft = stopTimeout(readRegistration()) - (Date.now() - started) / 1000;
const reply = triageReplyId(hook?.turn_id, hook?.last_assistant_message);
const result = forTurnEnd(ask('turn-end', {
  version: VERSION, stopRefusedBefore, secondsLeft, planFile: captured.planFile ?? null,
  ...(reply ? { triageReplyId: reply } : {}),
}), stopRefusedBefore, captured.problem);
await leave(stopOutput(result));
