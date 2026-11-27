import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits } from '../support/ktty.mjs';
import {
  completePlan, givenAWorkingBranch, givenFileContents, whenDirectoryIsListed, whenEventsAreRead, whenFileIsRead,
} from '../support/project.mjs';
import { thenContains, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import {
  claudeApproval, cursorBuild, cursorPayload, givenACursorSavedPlan, givenACursorTranscript, whenAgentRuns,
} from '../support/agents.mjs';

const thenAgentGets = run => { thenItExits(run, 0); return JSON.parse(run.stdout); };
const whenCursorCalls = (folder, tool_name, tool_input) =>
  whenAgentRuns(folder, 'cursor', 'pre-tool', cursorPayload(folder, 'preToolUse', { tool_name, tool_input, tool_use_id: 'call-1', cwd: '' }));
const whenOperatorSends = (folder, prompt) =>
  whenAgentRuns(folder, 'cursor', 'user-prompt', cursorPayload(folder, 'beforeSubmitPrompt', { prompt, composer_mode: 'agent', attachments: [] }));
const whenCursorStops = (folder, loop_count = 0) =>
  whenAgentRuns(folder, 'cursor', 'turn-end', cursorPayload(folder, 'stop', { status: 'completed', loop_count }));
const whenCursorChecks = (folder, extraHooks = { acknowledged: [] }) =>
  whenAgentRuns(folder, 'cursor', 'check', { version: 1, root: folder.cwd, extraHooks });

function givenACursorApproval(folder) {
  givenACursorTranscript(folder, [{ name: 'Change', plan: completePlan }]);
  const run = whenOperatorSends(folder, cursorBuild);
  thenContains(thenAgentGets(run).additional_context, 'Plan approval recorded.');
}

it('A Write is checked as a write of its file and a Delete as a delete, so a requirement cannot be deleted in any phase. [AC0076.1]', () => {
  const folder = givenAWorkingBranch();
  const requirement = join(folder.cwd, 'requirements/acceptance/AC0001__cancel.md');

  const open = whenCursorCalls(folder, 'Delete', { file_path: requirement });
  thenValueIs(thenAgentGets(open).permission, 'deny');
  thenContains(thenAgentGets(open).agent_message, 'Requirements are never deleted');

  givenACursorApproval(folder);
  const implementing = whenCursorCalls(folder, 'Delete', { file_path: requirement });
  thenContains(thenAgentGets(implementing).agent_message, 'Requirements are never deleted');
  const edited = whenCursorCalls(folder, 'Write', { file_path: requirement, content: 'changed\n' });
  thenValuesEqual(thenAgentGets(edited), {});
  const locked = whenCursorCalls(folder, 'Write', { file_path: join(folder.cwd, 'private/key.txt'), content: 'x' });
  thenContains(thenAgentGets(locked).agent_message, 'The rulebook locks this file as the agent\'s own configuration.');
  const code = whenCursorCalls(folder, 'Write', { file_path: join(folder.cwd, 'src/add.sh'), content: 'echo 5\n' });
  thenValuesEqual(thenAgentGets(code), {});
  const shell = whenCursorCalls(folder, 'Shell', { command: 'rm private/key.txt', cwd: '', timeout: 30000 });
  thenValueIs(thenAgentGets(shell).permission, 'deny');
});

it("A write the referee refuses is denied with the referee's reason for the agent. [AC0076.2]", () => {
  const folder = givenAWorkingBranch();

  const run = whenCursorCalls(folder, 'Write', { file_path: join(folder.cwd, 'src/add.sh'), content: 'echo 5\n' });

  const reply = thenAgentGets(run);
  thenValueIs(reply.permission, 'deny');
  thenContains(reply.agent_message, 'No plan has been approved');
  thenContains(reply.agent_message, 'present the plan with `CreatePlan`');
  thenValueIs(reply.user_message, reply.agent_message);
});

it('Build saves the plan Cursor kept for it, without its frontmatter, to a new file in the plans folder, and the approval is recorded. [AC0076.3]', () => {
  const folder = givenAWorkingBranch();
  const edited = completePlan.replace('## How\n\nConcrete content.', '## How\n\nConcrete content, edited by the operator.');
  givenACursorTranscript(folder, [{ name: 'Older', plan: '## Why\n\nAn older draft.\n' }, { name: 'Change', plan: completePlan }]);
  givenACursorSavedPlan(folder, 'Change', edited);
  const plansBefore = whenDirectoryIsListed(join(folder.cwd, 'plans'));

  const run = whenOperatorSends(folder, cursorBuild);

  const reply = thenAgentGets(run);
  thenValueIs(reply.continue, true);
  thenContains(reply.additional_context, 'Plan approval recorded.');
  const added = whenDirectoryIsListed(join(folder.cwd, 'plans')).filter(name => !plansBefore.includes(name));
  thenValueIs(added.length, 1);
  thenValueIs(whenFileIsRead(folder, 'plans/' + added[0]), edited);
  const [approval] = whenEventsAreRead(folder);
  thenValueIs(approval.event, 'plan_approved');
  thenValueIs(whenFileIsRead(folder, approval.payload.planSnapshot), edited);
});

it('A Build with no plan in the conversation records nothing and tells the operator. [AC0076.4]', () => {
  const folder = givenAWorkingBranch();
  givenACursorTranscript(folder, []);

  const run = whenOperatorSends(folder, cursorBuild);

  const reply = thenAgentGets(run);
  thenValueIs(reply.continue, true);
  thenContains(reply.additional_context, 'The operator clicked Build, but this conversation holds no plan proposed with `CreatePlan`. '
    + 'Present one in Plan mode first, so no approval was recorded and the current workflow state is unchanged. Tell the operator.');
  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('Every prompt gives the agent the workflow state as additional context. [AC0076.5]', () => {
  const folder = givenAWorkingBranch();

  const open = whenOperatorSends(folder, 'Append a line to notes.txt.');
  const before = thenAgentGets(open);
  thenValueIs(before.continue, true);
  thenContains(before.additional_context, 'workflow: open on work');

  givenACursorApproval(folder);
  const implementing = whenOperatorSends(folder, 'Carry on.');
  thenContains(thenAgentGets(implementing).additional_context, 'workflow: implementing on work');
});

it('The stop hook prints an empty object when it has nothing to say. [AC0076.6]', () => {
  const folder = givenAWorkingBranch();
  givenACursorTranscript(folder, []);

  const run = whenCursorStops(folder);

  thenItExits(run, 0);
  thenValueIs(run.stdout.trim(), '{}');
});

it('A stop the referee refuses is answered with a follow-up message. [AC0076.7]', () => {
  const folder = givenAWorkingBranch();
  givenACursorApproval(folder);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 5\n');

  const refused = whenCursorStops(folder);

  const reply = thenAgentGets(refused);
  thenValuesEqual(Object.keys(reply), ['followup_message']);
  thenContains(reply.followup_message, 'tests/add.sh');
});

it('The Claude Code workflow hooks answer nothing when Cursor runs them. [AC0076.8]', () => {
  const folder = givenAWorkingBranch();
  const cursor = (event, fields) => ({ ...cursorPayload(folder, event, fields) });

  for (const [action, input] of [
    ['pre-tool', cursor('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(folder.cwd, 'src/add.sh'), content: 'echo 5\n' } })],
    ['user-prompt', cursor('UserPromptSubmit', { prompt: 'record', composer_mode: 'agent' })],
    ['post-tool', { ...cursor('PostToolUse', {}), ...claudeApproval({ plan: completePlan, filePath: join(folder.cwd, 'plans/change.md') }) }],
    ['turn-end', cursor('Stop', { status: 'completed', loop_count: 0 })],
  ]) {
    const run = whenAgentRuns(folder, 'claude', action, input);
    thenItExits(run, 0);
    thenValueIs(run.stdout, '{}', action);
  }
  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('A Cursor workflow hook missing from .cursor/hooks.json is reported. [AC0076.9]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, '.cursor/rules/workflow.mdc', 'rules');
  givenFileContents(folder, '.cursor/hooks.json', JSON.stringify({ version: 1, hooks: {} }));

  const run = whenCursorChecks(folder);

  const { version, warnings } = thenAgentGets(run);
  thenValueIs(version, 1);
  thenValueIs(warnings.length, 3);
  thenContains(warnings[0], ".cursor/hooks.json does not register the workflow's preToolUse hook");
  thenContains(warnings[1], ".cursor/hooks.json does not register the workflow's beforeSubmitPrompt hook");
  thenContains(warnings[2], ".cursor/hooks.json does not register the workflow's stop hook");
});

it('An extra stop or prompt hook in a Cursor hooks file is reported as able to send the approval. [AC0076.10]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, '.cursor/rules/workflow.mdc', 'rules');
  const defaults = thenAgentGets(whenAgentRuns(folder, 'cursor', 'defaults', { version: 1 }));
  givenFileContents(folder, '.cursor/hooks.json', defaults.registration.text);
  givenFileContents({ cwd: folder.env.HOME }, '.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { stop: [{ command: 'notify' }] } }));

  const run = whenCursorChecks(folder);
  const acknowledged = whenCursorChecks(folder, { acknowledged: [{ event: 'stop', command: 'notify' }] });

  thenValuesEqual(thenAgentGets(run).warnings, [
    '~/.cursor/hooks.json registers an extra stop hook: `notify`. Cursor sends what a stop hook answers to the agent as a prompt, '
      + "and a prompt hook sees every prompt, so it could send or hold back Build's approval on the operator's behalf. "
      + "If it is the operator's, they list it under extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.",
  ]);
  thenValuesEqual(thenAgentGets(acknowledged).warnings, []);
});
