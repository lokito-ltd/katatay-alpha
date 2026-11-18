import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits } from '../support/ktty.mjs';
import { givenAWorkingBranch, whenEventsAreRead } from '../support/project.mjs';
import { thenContains, thenOmits, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import { givenAnApproval } from '../support/history.mjs';
import { claudePrompt, claudeTool, whenAgentRuns } from '../support/agents.mjs';

const thenAgentGets = run => { thenItExits(run, 0); return run.stdout === '' ? null : JSON.parse(run.stdout); };
// A PATH holding only the ktty command: the referee cannot start git, so it
// gives the hook no answer.
const withoutGit = folder => ({ PATH: folder.env.PATH.split(':')[0] });

it('The prompt hook puts the current phase in front of every turn as added context. [AC0068.1]', () => {
  const folder = givenAWorkingBranch();

  const open = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('hello'));
  thenValuesEqual(thenAgentGets(open), { hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'workflow: open on work — no plan has been approved\n'
      + 'next: write the plan and present it to the operator for approval; their approval is recorded when they give it',
  } });

  givenAnApproval(folder);
  const implementing = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('hello again'));
  const reply = thenAgentGets(implementing);
  thenValueIs(reply.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  thenContains(reply.hookSpecificOutput.additionalContext, 'workflow: implementing on work');
});

it('record and reset count only as the whole message, in any case, with an optional note after a colon. [AC0068.2]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const refused = 'The operator typed `record`, but it was not recorded.';

  for (const prompt of ['Record', 'RECORD: looks done']) {
    const run = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt(prompt));
    thenContains(thenAgentGets(run).hookSpecificOutput.additionalContext, refused, prompt);
  }
  const sentence = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('please record this'));
  thenOmits(thenAgentGets(sentence).hookSpecificOutput.additionalContext, refused);

  const mention = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('should we reset?'));
  thenAgentGets(mention);
  thenValuesEqual(whenEventsAreRead(folder).map(event => event.event), ['plan_approved']);

  const reset = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('RESET: starting over'));
  thenAgentGets(reset);
  const events = whenEventsAreRead(folder);
  thenValuesEqual(events.map(event => event.event), ['plan_approved', 'reset']);
  thenValuesEqual(events.at(-1).payload, { note: 'starting over' });
});

it('With no referee answer, the prompt hook says the state is unavailable and lets the prompt through. [AC0068.3]', () => {
  const folder = givenAWorkingBranch();

  const run = whenAgentRuns(folder, 'claude', 'user-prompt', claudePrompt('hello'), { env: withoutGit(folder) });

  const reply = thenAgentGets(run);
  thenValuesEqual(Object.keys(reply), ['hookSpecificOutput']);
  thenValueIs(reply.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  thenContains(reply.hookSpecificOutput.additionalContext, 'workflow: state unavailable (');
});

it('Edit, Write and NotebookEdit on a repository file are denied before a plan is approved. [AC0068.4]', () => {
  const folder = givenAWorkingBranch();
  const calls = [
    claudeTool('Edit', { file_path: join(folder.cwd, 'src/add.sh'), old_string: '4', new_string: '5' }),
    claudeTool('Write', { file_path: join(folder.cwd, 'src/new.sh'), content: 'echo 5\n' }),
    claudeTool('NotebookEdit', { notebook_path: join(folder.cwd, 'src/sums.ipynb'), new_source: '2 + 2' }),
  ];

  for (const call of calls) {
    const run = whenAgentRuns(folder, 'claude', 'pre-tool', call);
    const reply = thenAgentGets(run);
    thenValueIs(reply.hookSpecificOutput.permissionDecision, 'deny', call.tool_name);
    thenContains(reply.hookSpecificOutput.permissionDecisionReason, 'No plan has been approved on this branch, so edits are not permitted yet.');
  }
});

it('A Bash command that writes a locked path or removes a requirement is denied, and any other Bash runs before approval. [AC0068.5]', () => {
  const folder = givenAWorkingBranch();

  const locked = whenAgentRuns(folder, 'claude', 'pre-tool', claudeTool('Bash', { command: 'echo x > .katatay/rulebook.json' }));
  const lockedReply = thenAgentGets(locked);
  thenValueIs(lockedReply.hookSpecificOutput.permissionDecision, 'deny');
  thenContains(lockedReply.hookSpecificOutput.permissionDecisionReason, '(This shell command appears to modify a locked path.)');

  const removal = whenAgentRuns(folder, 'claude', 'pre-tool', claudeTool('Bash', { command: 'rm requirements/acceptance/AC0001__cancel.md' }));
  const removalReply = thenAgentGets(removal);
  thenValueIs(removalReply.hookSpecificOutput.permissionDecision, 'deny');
  thenContains(removalReply.hookSpecificOutput.permissionDecisionReason, 'Requirements are never deleted');

  const ordinary = whenAgentRuns(folder, 'claude', 'pre-tool', claudeTool('Bash', { command: 'echo hi > src/add.sh' }));
  thenValueIs(thenAgentGets(ordinary), null);
});

it('With no referee answer, a file write is denied and a shell command is left alone. [AC0068.6]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);

  const write = whenAgentRuns(folder, 'claude', 'pre-tool',
    claudeTool('Write', { file_path: join(folder.cwd, 'src/add.sh'), content: 'echo 5\n' }), { env: withoutGit(folder) });
  const writeReply = thenAgentGets(write);
  thenValueIs(writeReply.hookSpecificOutput.permissionDecision, 'deny');
  thenContains(writeReply.hookSpecificOutput.permissionDecisionReason, 'the edit is not permitted');

  const command = whenAgentRuns(folder, 'claude', 'pre-tool', claudeTool('Bash', { command: 'ls' }), { env: withoutGit(folder) });
  thenValueIs(thenAgentGets(command), null);
});

it('A pre-tool payload that is not JSON is let through with exit 0 and no output. [AC0068.7]', () => {
  const folder = givenAWorkingBranch();

  const run = whenAgentRuns(folder, 'claude', 'pre-tool', '{"tool_name": "Write", ');

  thenItExits(run, 0);
  thenValueIs(run.stdout, '');
  thenValueIs(run.stderr, '');
});
