import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits } from '../support/ktty.mjs';
import {
  completePlan, givenAChangeFile, givenAFolder, givenAWorkingBranch, givenFileContents, planFile, whenDirectoryIsListed,
  whenEventsAreRead, whenFileIsRead, whenTriageRuns,
} from '../support/project.mjs';
import { thenContains, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import { changeFile } from '../support/history.mjs';
import { codexPatch, codexPayload, givenACodexTranscript, whenAgentRuns } from '../support/agents.mjs';

const thenAgentGets = run => { thenItExits(run, 0); return run.stdout === '' ? null : JSON.parse(run.stdout); };
const whenCodexPatches = (folder, body) => whenAgentRuns(folder, 'codex', 'pre-tool', codexPayload(folder, 'PreToolUse', codexPatch(body)));
const whenOperatorTypes = (folder, prompt, cwd = folder.cwd) =>
  whenAgentRuns(folder, 'codex', 'user-prompt', codexPayload(folder, 'UserPromptSubmit', { prompt }, cwd), { cwd });
const whenCodexStops = (folder, stop_hook_active = false) =>
  whenAgentRuns(folder, 'codex', 'turn-end', codexPayload(folder, 'Stop', { stop_hook_active, last_assistant_message: 'Done.' }));
const denial = reply => reply?.hookSpecificOutput?.permissionDecision === 'deny' ? reply.hookSpecificOutput.permissionDecisionReason : null;
const lockReason = 'The rulebook locks this file as the agent\'s own configuration.';
const clearContext = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. "
  + 'Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.';

function givenACodexApproval(folder) {
  givenACodexTranscript(folder, [completePlan]);
  const run = whenOperatorTypes(folder, 'Implement the plan.');
  thenContains(thenAgentGets(run).systemMessage, 'Plan approval recorded.');
}

it('A patch is read as every file it adds, updates or deletes, and a move counts as a delete of the old path. [AC0070.1]', () => {
  const folder = givenAWorkingBranch();
  givenACodexApproval(folder);

  for (const body of [
    '*** Add File: src/new.sh\n+echo 1\n*** Add File: private/key.txt\n+secret',
    '*** Update File: src/add.sh\n@@\n-echo 4\n+echo 4\n*** Update File: private/key.txt\n@@\n-a\n+b',
    '*** Update File: src/add.sh\n@@\n-echo 4\n+echo 4\n*** Delete File: private/key.txt',
  ]) {
    const run = whenCodexPatches(folder, body);
    thenContains(denial(thenAgentGets(run)), lockReason, body);
  }
  const allowed = whenCodexPatches(folder, '*** Add File: src/new.sh\n+echo 1\n*** Update File: src/add.sh\n@@\n-echo 4\n+echo 5\n*** Delete File: src/old.sh');
  thenValueIs(thenAgentGets(allowed), null);

  const inPlace = whenCodexPatches(folder, '*** Update File: requirements/acceptance/AC0001__cancel.md\n@@\n-a\n+b');
  thenValueIs(thenAgentGets(inPlace), null);
  const moved = whenCodexPatches(folder, '*** Update File: requirements/acceptance/AC0001__cancel.md\n*** Move to: notes/cancel.md\n@@\n-a\n+a');
  thenContains(denial(thenAgentGets(moved)), 'Requirements are never deleted');
});

it('A patch that names no file is denied. [AC0070.2]', () => {
  const folder = givenAWorkingBranch();
  givenACodexApproval(folder);

  const run = whenCodexPatches(folder, '@@\n-echo 4\n+echo 5');

  thenValueIs(denial(thenAgentGets(run)),
    'The gate cannot tell which files this patch writes, because it names none in an `*** Add File:`, `*** Update File:`, `*** Move to:` or `*** Delete File:` line, '
    + 'so it is not permitted. Stop and tell the operator: the patch format may have changed.');
});

it('A patch that moves a requirement away is denied in every phase. [AC0070.3]', () => {
  const folder = givenAWorkingBranch();
  const move = '*** Update File: requirements/acceptance/AC0001__cancel.md\n*** Move to: notes/cancel.md\n@@\n-a\n+a';

  const open = whenCodexPatches(folder, move);
  thenContains(denial(thenAgentGets(open)), 'Requirements are never deleted');

  givenACodexApproval(folder);
  const implementing = whenCodexPatches(folder, move);
  thenContains(denial(thenAgentGets(implementing)), 'Requirements are never deleted');
});

it('Yes, implement this plan saves the latest plan to a new file in the plans folder, and the change goes on to be recorded. [AC0070.4]', () => {
  const folder = givenAWorkingBranch();
  const plansBefore = whenDirectoryIsListed(join(folder.cwd, 'plans'));
  givenACodexTranscript(folder, ['## Why\n\nAn older draft.\n', completePlan]);

  const approval = whenOperatorTypes(folder, 'Implement the plan.');
  thenContains(thenAgentGets(approval).systemMessage, 'Plan approval recorded.');
  const added = whenDirectoryIsListed(join(folder.cwd, 'plans')).filter(name => !plansBefore.includes(name));
  thenValueIs(added.length, 1);
  thenValueIs(whenFileIsRead(folder, 'plans/' + added[0]), completePlan);

  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  thenItExits(whenTriageRuns(folder), 0);
  thenAgentGets(whenCodexStops(folder));
  thenAgentGets(whenCodexStops(folder, true));
  const record = whenOperatorTypes(folder, 'record');
  thenAgentGets(record);
  const declared = whenEventsAreRead(folder).at(-1);
  thenValueIs(declared.event, 'declared');
  givenAChangeFile(folder, changeFile, 'Codex change', declared.payload.summary);
  thenAgentGets(whenCodexStops(folder));
  thenValuesEqual(whenEventsAreRead(folder).map(event => event.event).at(-1), 'recorded');
});

it('Yes, clear context and implement is approved from the plan carried in the prompt. [AC0070.5]', () => {
  const folder = givenAWorkingBranch();
  givenACodexTranscript(folder, ['## Why\n\nA different plan in the old thread.\n']);

  const run = whenOperatorTypes(folder, clearContext + '\n\n' + completePlan);

  thenContains(thenAgentGets(run).systemMessage, 'Plan approval recorded.');
  const [approval] = whenEventsAreRead(folder);
  thenValueIs(approval.event, 'plan_approved');
  thenValueIs(whenFileIsRead(folder, approval.payload.planSnapshot), completePlan);
});

it('An approval with no plan in the thread records nothing and tells the operator. [AC0070.6]', () => {
  const folder = givenAWorkingBranch();
  givenACodexTranscript(folder, []);

  const run = whenOperatorTypes(folder, 'Implement the plan.');

  const reply = thenAgentGets(run);
  thenContains(reply.systemMessage, 'Tell the operator.');
  thenContains(reply.systemMessage, 'no approval was recorded');
  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('The hooks find the repository from a subfolder. [AC0070.7]', () => {
  const folder = givenAWorkingBranch();
  givenAFolder(folder, 'src/deep');
  givenACodexTranscript(folder, [completePlan]);
  const subfolder = join(folder.cwd, 'src/deep');

  const approval = whenOperatorTypes(folder, 'Implement the plan.', subfolder);
  thenContains(thenAgentGets(approval).systemMessage, 'Plan approval recorded.');
  thenValuesEqual(whenEventsAreRead(folder).map(event => event.event), ['plan_approved']);

  const prompt = whenOperatorTypes(folder, 'hello', subfolder);
  thenContains(thenAgentGets(prompt).hookSpecificOutput.additionalContext, 'workflow: implementing on work');
});

it('The Stop hook prints an empty object when it has nothing to say. [AC0070.8]', () => {
  const folder = givenAWorkingBranch();
  givenACodexTranscript(folder, []);

  const run = whenCodexStops(folder);

  thenItExits(run, 0);
  thenValueIs(run.stdout.trim(), '{}');
});
