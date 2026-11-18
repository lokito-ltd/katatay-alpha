#!/usr/bin/env node
/**
 * PreToolUse, on `apply_patch|Bash`. Asks the referee whether this tool call
 * may happen (`on write`), and denies it when the referee says no or gives no
 * answer.
 *
 * What the referee is told is Codex's to say: which files a patch writes, or
 * the shell line a Bash call runs (`toWrite`, in `translate.mjs`). Every lock,
 * and which files need no plan, is the referee's to decide.
 */
import { input, enterRepository, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { forWrite, preToolDrift, preToolOutput, toWrite } from './translate.mjs';

let hook;
try {
  hook = await input();
} catch {
  // A payload that cannot be parsed names no tool and no file, so there is
  // nothing to decide on, and every other hook is broken the same way. This is
  // the one failure that stays out of the way. The turn end is loud about it.
  await leave(null, preToolDrift);
}

// `tool_input.command` belongs to both tools, but a call with none is not
// drift: `toWrite` denies a patch without one, and a shell call with none
// runs nothing.
expectFields(hook, {
  tool_name: 'the gate cannot tell which tool is being used, and allows the call',
  cwd: 'a patch\'s relative paths are read against the hook\'s own directory',
});
const root = enterRepository(hook?.cwd);
const call = toWrite(hook?.tool_name, hook?.tool_input, typeof hook?.cwd === 'string' ? hook.cwd : root);
const decision = call === null ? null : 'deny' in call ? { deny: call.deny } : forWrite(ask('write', call.ask), call.ask);
await leave(preToolOutput(decision), preToolDrift);
