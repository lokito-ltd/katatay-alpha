import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { whenKttyRuns } from './ktty.mjs';

// Runs an adapter action the way the agent starts its hook: the agent's own
// JSON on stdin, from the given folder. `input` that is a string is sent as is.
export function whenAgentRuns(folder, adapter, action, input, { cwd = folder.cwd, env = {} } = {}) {
  return whenKttyRuns(['agent', adapter, action], {
    in: { ...folder, cwd }, input: typeof input === 'string' ? input : JSON.stringify(input), env,
  });
}

// What Claude Code sends each hook. Only the fields the hooks read, and the
// event name Claude Code always sends.
export const claudePrompt = prompt => ({ hook_event_name: 'UserPromptSubmit', prompt });
export const claudeTool = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
export const claudeApproval = tool_response => ({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response });
export const claudeStop = (stop_hook_active = false) => ({ hook_event_name: 'Stop', stop_hook_active });

// What Codex sends each hook, as captured from a live session.
export function codexPayload(folder, hook_event_name, fields, cwd = folder.cwd) {
  return {
    session_id: '00000000-0000-7000-8000-000000000001',
    turn_id: '00000000-0000-7000-8000-000000000002',
    transcript_path: codexTranscriptPath(folder),
    cwd, hook_event_name, model: 'gpt-6-astra', permission_mode: 'default', ...fields,
  };
}
export const codexTranscriptPath = folder =>
  join(folder.env.HOME, '.codex/sessions/2026/10/29/rollout-2026-10-29T00-00-00-00000000-0000-7000-8000-000000000001.jsonl');
export const codexPatch = body => ({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n' + body + '\n*** End Patch' } });

// A session transcript holding the given completed plans, one Plan item each.
export function givenACodexTranscript(folder, plans) {
  const lines = plans.map((text, index) => JSON.stringify({
    timestamp: '2026-10-29T00:00:0' + index + '.000Z', type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 'turn-' + index, item: { type: 'Plan', id: 'plan-' + index, text } },
  }));
  const path = codexTranscriptPath(folder);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
}

// A program on PATH under the given name, written as a Node script.
export function givenAProgram(folder, name, source) {
  const bin = folder.env.PATH.split(':')[0];
  writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + source);
  chmodSync(join(bin, name), 0o755);
}

// A stand-in for Codex's app server, first on PATH. It answers `hooks/list`
// with the hooks in codex-hooks.json beside the case folder, and `config/read`
// with the settings in codex-config.json there, or defaults.
export function givenACodexAppServer(folder, hooks, config = { features: {} }) {
  const answers = join(folder.cwd, '..');
  writeFileSync(join(answers, 'codex-hooks.json'), JSON.stringify(hooks));
  writeFileSync(join(answers, 'codex-config.json'), JSON.stringify(config));
  givenAProgram(folder, 'codex', `
const { readFileSync } = require('node:fs');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const read = name => JSON.parse(readFileSync(${JSON.stringify(answers)} + '/' + name, 'utf8'));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'hooks/list') send({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], hooks: read('codex-hooks.json'), warnings: [], errors: [] }] } });
  else if (message.method === 'config/read') send({ id: message.id, result: { config: read('codex-config.json'), origins: {}, layers: null } });
  else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`);
}

// The workflow's own Codex hooks, as Codex lists them once the project
// registers what the adapter proposes and the operator trusts them.
export function codexWorkflowHooks(folder) {
  const defaults = whenAgentRuns(folder, 'codex', 'defaults', { version: 1 });
  const registered = JSON.parse(JSON.parse(defaults.stdout).registration.text).hooks;
  const sourcePath = join(folder.cwd, '.codex/hooks.json');
  return Object.entries(registered).flatMap(([event, groups], index) => groups.flatMap(group => group.hooks.map(hook => ({
    key: sourcePath + ':' + event + ':0:0', eventName: event[0].toLowerCase() + event.slice(1), handlerType: 'command',
    command: hook.command, async: false, matcher: group.matcher ?? null, timeoutSec: hook.timeout ?? 600,
    sourcePath, source: 'project', displayOrder: index, enabled: true, isManaged: false, trustStatus: 'trusted',
  }))));
}

// What Cursor sends each hook, as captured from a live session under 3.32.10.
export function cursorPayload(folder, hook_event_name, fields) {
  return {
    conversation_id: '00000000-0000-4000-8000-000000000001',
    generation_id: '00000000-0000-4000-8000-000000000002',
    model: 'grok-4.7-medium', hook_event_name, cursor_version: '3.32.10',
    workspace_roots: [folder.cwd], user_email: null, transcript_path: cursorTranscriptPath(folder), ...fields,
  };
}
export const cursorTranscriptPath = folder =>
  join(folder.env.HOME, '.cursor/projects/repo/agent-transcripts/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000001.jsonl');

// The prompt Cursor sends when the operator clicks Build.
export const cursorBuild = 'Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.\n\n'
  + "To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. "
  + "Don't stop until you have completed all the to-dos.";

// A conversation transcript in which the agent proposed each `{ name, plan }` with CreatePlan, one turn each.
export function givenACursorTranscript(folder, plans) {
  const lines = plans.flatMap(({ name, plan }) => [
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nPlan it.\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Here is the plan.' }, { type: 'tool_use', name: 'CreatePlan', input: { name, overview: 'o', plan, todos: [] } }] } },
    { type: 'turn_ended', status: 'success' },
  ]).map(entry => JSON.stringify(entry));
  const path = cursorTranscriptPath(folder);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
}

// The copy of a plan Cursor saves in ~/.cursor/plans, frontmatter first.
export function givenACursorSavedPlan(folder, name, body) {
  const path = join(folder.env.HOME, '.cursor/plans', name.toLowerCase().replaceAll(' ', '_') + '_0fdd314f.plan.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\noverview: o\ntodos:\n  - id: a\n    content: Do it\n    status: pending\nisProject: false\n---\n\n${body}`);
  return path;
}
