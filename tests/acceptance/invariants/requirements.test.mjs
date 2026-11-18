import { it } from 'vitest';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { thenHookReplies, thenItExits, thenItPrintsErrorLines, thenItPrintsLines } from '../support/ktty.mjs';
import {
  givenAWorkingBranch, whenACommandIsProposed, whenAWriteIsProposed, whenFileIsRemoved, whenPlanIsApproved,
} from '../support/project.mjs';
import { thenHookAnswers, thenValueIs } from '../support/assertions.mjs';
import { claudeTool, codexPatch, codexPayload, whenAgentRuns } from '../support/agents.mjs';
import { givenAnApprovedPlanStating, givenTheTargetCatalogue, whenReqRuns } from '../support/requirements.mjs';

const cancel = { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] };
const requirement = 'requirements/acceptance/AC0001__cancel.md';
const neverDeleted = 'Requirements are never deleted and change files are append-only history, so removing or renaming under requirements/ is never right. '
  + 'Write, edit and add there freely. Leave removal to the operator.';
const noDelete = { allow: false, messages: [{ code: 'locked', for: 'agent', text: neverDeleted }] };
const shellNoDelete = { allow: false, messages: [{ code: 'locked', for: 'agent', text: neverDeleted + ' (This shell command appears to modify a locked path.)' }] };
const allowed = { allow: true, messages: [] };

const whenAgentReplies = (folder, adapter, input) => {
  const run = whenAgentRuns(folder, adapter, 'pre-tool', input);
  thenItExits(run, 0);
  return JSON.parse(run.stdout);
};

it('Deleting a file under the requirements folder, or the folder itself, is denied, while writing there is allowed. [INV0003.1]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  thenHookReplies(whenPlanIsApproved(folder), 0);

  const file = whenAWriteIsProposed(folder, [], [requirement]);
  const changeFile = whenAWriteIsProposed(folder, [], ['requirements/changes/20261113T000000.000Z__old.md']);
  const whole = whenAWriteIsProposed(folder, [], ['requirements']);
  const write = whenAWriteIsProposed(folder, [requirement, 'requirements/acceptance/AC0002__refund.md']);

  thenHookAnswers(file, noDelete);
  thenHookAnswers(changeFile, noDelete);
  thenHookAnswers(whole, noDelete);
  thenHookAnswers(write, allowed);
});

it('A shell rm, rmdir, mv, git rm or git mv under the requirements folder is denied. [INV0003.2]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  thenHookReplies(whenPlanIsApproved(folder), 0);

  for (const command of [
    'rm ' + requirement,
    'rm -rf requirements',
    'rmdir requirements/invariants',
    'mv ' + requirement + ' notes/cancel.md',
    'git rm ' + requirement,
    'git mv ' + requirement + ' requirements/acceptance/AC0009__cancel.md',
  ]) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, shellNoDelete);
  }

  const reply = whenAgentReplies(folder, 'claude', claudeTool('Bash', { command: 'rm requirements/changes/0001__x.md' }));

  thenValueIs(reply.hookSpecificOutput.permissionDecision, 'deny');
  thenValueIs(reply.hookSpecificOutput.permissionDecisionReason, neverDeleted + ' (This shell command appears to modify a locked path.)');
});

it('A Codex patch that moves a requirement away is denied. [INV0003.3]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  thenHookReplies(whenPlanIsApproved(folder), 0);

  const moved = whenAgentReplies(folder, 'codex', codexPayload(folder, 'PreToolUse',
    codexPatch('*** Update File: ' + requirement + '\n*** Move to: notes/cancel.md\n@@\n-a\n+a')));
  const deleted = whenAgentReplies(folder, 'codex', codexPayload(folder, 'PreToolUse',
    codexPatch('*** Delete File: ' + requirement)));

  thenValueIs(moved.hookSpecificOutput.permissionDecision, 'deny');
  thenValueIs(moved.hookSpecificOutput.permissionDecisionReason, neverDeleted);
  thenValueIs(deleted.hookSpecificOutput.permissionDecision, 'deny');
  thenValueIs(deleted.hookSpecificOutput.permissionDecisionReason, neverDeleted);
});

it('The guard fails a deleted requirement in CI too, and no plan accounts for it. [INV0003.4]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenAnApprovedPlanStating(folder, [{ id: 'AC0001', status: 'withdrawn', statement: cancel.statement, scenarios: cancel.scenarios }]);
  whenFileIsRemoved(folder, requirement);

  const local = whenReqRuns(folder, ['guard']);
  const ci = whenReqRuns(folder, ['guard'], { CI: 'true' });

  thenItExits(local, 1);
  thenItPrintsErrorLines(local, [
    'req:guard — 1 violation(s)',
    '  AC0001: deleted. Requirements are never deleted — set status to superseded or withdrawn instead',
  ]);
  thenItExits(ci, 1);
  thenItPrintsErrorLines(ci, [
    'req:guard — 1 violation(s)',
    '  AC0001: deleted. Requirements are never deleted — set status to superseded or withdrawn instead',
  ]);
});

it('Renaming only the slug is not a deletion. [INV0003.5]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });

  renameSync(join(folder.cwd, requirement), join(folder.cwd, 'requirements/acceptance/AC0001__cancel_an_order.md'));
  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:guard — no protected requirement was changed without approval']);
});
