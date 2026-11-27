#!/usr/bin/env node
/**
 * preToolUse, on `Write|Delete|Shell`. Asks the referee whether this tool
 * call may happen (`on write`), and denies it when the referee says no or
 * gives no answer.
 *
 * What the referee is told is Cursor's to say: the file a `Write` or `Delete`
 * names, or the shell line a `Shell` call runs (`toWrite`, in
 * `translate.mjs`). Every lock, and which files need no plan, is the
 * referee's to decide.
 *
 * Cursor blocks a permission hook's call when the hook prints something that
 * is not JSON, and `failClosed` in the registration blocks it when the hook
 * crashes, so this always prints an object.
 */
import { input, enterRepository, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { forWrite, preToolOutput, toWrite } from './translate.mjs';

const carry = (out, warning) => (out.permission === 'deny'
  ? { ...out, agent_message: `${warning}\n\n${out.agent_message}`, user_message: `${warning}\n\n${out.user_message}` }
  : { ...out, agent_message: warning });

let hook;
try {
  hook = await input();
} catch {
  // A payload that cannot be parsed names no tool and no file, so there is
  // nothing to decide on, and every other hook is broken the same way. The
  // turn end is loud about it.
  await leave(preToolOutput(null), carry);
}

// `tool_input.file_path` and `tool_input.command` belong to different tools,
// so only the tool's name is drift. A Write with no path is denied by `toWrite`.
expectFields(hook, {
  tool_name: 'the gate cannot tell which tool is being used, and lets the call go on',
  workspace_roots: 'the hook cannot find the repository, and asks the referee from its own folder',
});
const root = enterRepository(hook?.workspace_roots);
const call = toWrite(hook?.tool_name, hook?.tool_input, root);
const decision = call === null ? null : 'deny' in call ? { deny: call.deny } : forWrite(ask('write', call.ask), call.ask);
await leave(preToolOutput(decision), carry);
