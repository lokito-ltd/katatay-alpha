import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits } from '../support/ktty.mjs';
import {
  completePlan, givenAWorkingBranch, givenFileContents, planFile, whenEventsAreRead, whenFileIsRead,
} from '../support/project.mjs';
import { thenContains, thenOmits, thenTextMatches, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import { givenAConvergingChange } from '../support/checks.mjs';
import { claudeApproval, claudeStop, claudeTool, whenAgentRuns } from '../support/agents.mjs';

const thenAgentGets = run => { thenItExits(run, 0); return run.stdout === '' ? null : JSON.parse(run.stdout); };
const withoutGit = folder => ({ PATH: folder.env.PATH.split(':')[0] });
const presenting = (folder, prompt) => ({
  ...claudeTool('ExitPlanMode', { plan: 'shown', planFilePath: join(folder.cwd, planFile) }),
  session_id: 'session-1', prompt_id: prompt,
});

it('Pre-tool on ExitPlanMode asks for a correction at most once per prompt and never approves the plan. [AC0069.1]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, '## Why\n\nOnly a reason.\n');

  const first = whenAgentRuns(folder, 'claude', 'pre-tool', presenting(folder, 'prompt-1'));
  const correction = thenAgentGets(first);
  thenValueIs(correction.hookSpecificOutput.permissionDecision, 'deny');
  thenContains(correction.hookSpecificOutput.permissionDecisionReason, '- section What is missing');

  const again = whenAgentRuns(folder, 'claude', 'pre-tool', presenting(folder, 'prompt-1'));
  const warning = thenAgentGets(again);
  thenValueIs(warning.hookSpecificOutput.permissionDecision, undefined);
  thenContains(warning.systemMessage, '- section What is missing');

  const nextPrompt = whenAgentRuns(folder, 'claude', 'pre-tool', presenting(folder, 'prompt-2'));
  thenValueIs(thenAgentGets(nextPrompt).hookSpecificOutput.permissionDecision, 'deny');

  givenFileContents(folder, planFile, completePlan);
  const valid = whenAgentRuns(folder, 'claude', 'pre-tool', presenting(folder, 'prompt-3'));
  thenValueIs(thenAgentGets(valid), null);
  for (const run of [first, again, nextPrompt, valid]) thenOmits(run.stdout, '"allow"');
  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('Post-tool on ExitPlanMode records plan_approved and permits edits. [AC0069.2]', () => {
  const folder = givenAWorkingBranch();

  const approval = whenAgentRuns(folder, 'claude', 'post-tool', claudeApproval({ plan: completePlan, filePath: join(folder.cwd, planFile) }));

  const reply = thenAgentGets(approval);
  thenTextMatches(reply.systemMessage, /^Plan approval recorded\. Edits are now permitted\.\napproved plan: /);
  thenValuesEqual(whenEventsAreRead(folder).map(event => event.event), ['plan_approved']);
  const edit = whenAgentRuns(folder, 'claude', 'pre-tool', claudeTool('Write', { file_path: join(folder.cwd, 'src/add.sh'), content: 'echo 4\n' }));
  thenValueIs(thenAgentGets(edit), null);
});

it('Post-tool writes the approved text into the plan file when the file still holds the draft. [AC0069.3]', () => {
  const folder = givenAWorkingBranch();
  const approved = completePlan + '\nThe operator added this line in the dialog.\n';

  const approval = whenAgentRuns(folder, 'claude', 'post-tool', claudeApproval({ plan: approved, filePath: join(folder.cwd, planFile) }));

  thenAgentGets(approval);
  thenValueIs(whenFileIsRead(folder, planFile), approved);
  const [event] = whenEventsAreRead(folder);
  thenValueIs(whenFileIsRead(folder, event.payload.planSnapshot), approved);
});

it('Post-tool records nothing, and says so, when Claude Code sends no plan text or no file path. [AC0069.4]', () => {
  const folder = givenAWorkingBranch();

  const noText = whenAgentRuns(folder, 'claude', 'post-tool', claudeApproval({ filePath: join(folder.cwd, planFile) }));
  thenValuesEqual(thenAgentGets(noText), { systemMessage:
    'The plan was approved, but Claude Code did not pass the approved plan text to the workflow hook, so no approval was recorded and edits stay blocked. '
    + 'Claude Code may have changed what it sends. Tell the operator.' });

  const noPath = whenAgentRuns(folder, 'claude', 'post-tool', claudeApproval({ plan: completePlan }));
  thenContains(thenAgentGets(noPath).systemMessage,
    'The plan was approved, but Claude Code did not say which file holds it, so no approval was recorded and edits stay blocked. Tell the operator.');

  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('On a passing verify, the Stop hook refuses the stop once to relay the report to the operator. [AC0069.5]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const passing = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(false));
  const relay = thenAgentGets(passing);
  thenValueIs(relay.decision, 'block');
  thenTextMatches(relay.reason, /^Repeat this to the operator in full, in your reply:\n\n[\s\S]*Verification passed\./);

  const relayed = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(true));
  const after = thenAgentGets(relayed);
  thenValueIs(after?.decision, undefined);
  thenValuesEqual(whenEventsAreRead(folder).map(event => event.event), ['plan_approved', 'triaged', 'verified']);
});

it('The Stop hook keeps the agent working on a failure, but not after a stop was already refused. [AC0069.6]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder, 'echo 5\n');

  const failing = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(false));
  const kept = thenAgentGets(failing);
  thenValueIs(kept.decision, 'block');
  thenContains(kept.reason, 'Verification failed');

  const refusedBefore = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(true));
  const released = thenAgentGets(refusedBefore);
  thenValueIs(released.decision, undefined);
  thenContains(released.systemMessage, 'Verification failed');
});

it('With no referee answer, the Stop hook says nothing was verified and blocks unless that could loop. [AC0069.7]', () => {
  const folder = givenAWorkingBranch();

  const first = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(false), { env: withoutGit(folder) });
  const blocked = thenAgentGets(first);
  thenValueIs(blocked.decision, 'block');
  thenTextMatches(blocked.reason, /^The workflow turn-end hook failed, so nothing was verified: /);

  const again = whenAgentRuns(folder, 'claude', 'turn-end', claudeStop(true), { env: withoutGit(folder) });
  const message = thenAgentGets(again);
  thenValueIs(message.decision, undefined);
  thenTextMatches(message.systemMessage, /^The workflow turn-end hook failed, so nothing was verified: /);
});
