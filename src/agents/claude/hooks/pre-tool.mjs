#!/usr/bin/env node
/**
 * PreToolUse, on `Edit|Write|NotebookEdit|Bash|ExitPlanMode`. Asks the referee whether this
 * write may happen (`on write`), denying it when the referee says no or gives
 * no answer. For ExitPlanMode it requests only the presentation courtesy.
 *
 * What the referee is told is Claude Code's to say: which file an edit writes,
 * or the shell line a Bash call runs (`toWrite`, in `translate.mjs`). Every
 * lock, and which files need no plan, is the referee's to decide.
 */
import { input, standAside, emit, send, leave } from './io.mjs';
import { runByCursor } from './cursor.mjs';
import { presentPlan } from '../plans.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { forWrite, toWrite } from './translate.mjs';

let hook;
try {
  hook = await input();
} catch {
  // A payload that cannot be parsed names no tool and no path, so there is
  // nothing to decide on, and every other hook is broken the same way. This is
  // the one failure that stays out of the way. The turn-end hook is where it is
  // allowed to be loud.
  await leave();
}
// Cursor runs this file too, beside its own adapter's hooks. Leave it to those.
if (runByCursor(hook)) await standAside();

// Only `tool_name` is checked. The other fields belong to particular tools:
// `file_path` and `notebook_path` to different edit tools, `command` to Bash.
// Warning on those would fire constantly and teach everyone to ignore it. An
// edit tool with no path is denied by `toWrite` instead.
expectFields(hook, { tool_name: 'the gate cannot tell which tool is being used, and allows the call' });
const { tool_name: tool, tool_input: toolInput } = hook ?? {};

// Presentation is a courtesy, separate from writes and from approval. Do not
// return "allow": that could answer the operator's permission dialog.
if (tool === 'ExitPlanMode') {
  const presented = presentPlan(hook, { ask });
  if (presented !== null) emit(presented);
  await leave();
}

const call = toWrite(tool, toolInput);
if (call !== null) send('deny' in call ? { via: 'deny', text: call.deny } : forWrite(ask('write', call.ask), call.ask));
await leave();
