import { it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { thenHookReplies, thenItExits, whenKttyRuns } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  planFile,
  whenACommandIsProposed,
  whenFileIsRead,
  whenAWriteIsProposed,
  whenGitRuns,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventsEqual,
  thenHookAnswers,
  thenOmits,
  thenStateShowsPhase,
  thenTextMatches,
  thenValueIs,
} from '../support/assertions.mjs';

const allowed = { allow: true, messages: [] };
const needsPlan = { allow: false, messages: [{ code: 'needs_plan', for: 'agent' }] };
const stop = { allow: false, messages: [{ code: 'stop', for: 'operator' }] };

function givenABrokenLogbook(folder) {
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, '.katatay/state/work/0001__plan_approved.json', '{"broken": true}');
}

function givenAFileWhereTheLogbookShouldBe(folder) {
  givenFileContents(folder, '.katatay/state/work', 'not a folder');
}

function givenAFolderWhereAnEventShouldBe(folder) {
  mkdirSync(join(folder.cwd, '.katatay/state/work/0001__plan_approved.json'), { recursive: true });
}

function givenABranchWithNoCommit(folder) {
  whenGitRuns(folder, 'checkout', '-q', '--orphan', 'fresh');
}

it('Editing a source file before approval is denied as needing a plan, and the reason gives the plan format. [AC0017.1]', () => {
  const folder = givenAWorkingBranch();

  const run = whenAWriteIsProposed(folder, ['src/add.sh']);

  const answer = thenHookAnswers(run, needsPlan);
  const reason = answer.messages[0].text;
  thenContains(reason, 'No plan has been approved on this branch, so edits are not permitted yet.');
  for (const part of ['## Why', '## What', '## How', '## Requirements', '## Predicted failures', '## Test delta']) {
    thenContains(reason, part);
  }
  thenContains(reason, 'fenced code block labelled `workflow`');
});

it('A Markdown file directly in the plans folder, and the follow-ups file, may be written before approval. [AC0017.2]', () => {
  const folder = givenAWorkingBranch();

  for (const path of ['plans/next.md', 'FOLLOW-UPS.md', join(folder.cwd, 'FOLLOW-UPS.md'), join(folder.cwd, 'plans/next.md')]) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, allowed);
  }
});

it('A file in a subfolder of the plans folder, or a non-Markdown file there, is denied. [AC0017.3]', () => {
  const folder = givenAWorkingBranch();

  for (const path of ['plans/drafts/next.md', 'plans/next.txt']) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, needsPlan);
  }
});

it('The denial names the follow-ups file the rulebook keeps. [AC0017.4]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.followUpsFile = 'notes/LATER.md'; });

  const denied = whenAWriteIsProposed(folder, ['src/add.sh']);
  const answer = thenHookAnswers(denied, needsPlan);
  thenContains(answer.messages[0].text, 'you can still write plan files, notes/LATER.md, and files outside the repository');
  thenOmits(answer.messages[0].text, 'FOLLOW-UPS.md');

  thenHookAnswers(whenAWriteIsProposed(folder, ['notes/LATER.md']), allowed);
  thenHookAnswers(whenAWriteIsProposed(folder, ['FOLLOW-UPS.md']), needsPlan);
});

it('A file outside the repository that no lock covers may be written before approval. [AC0017.5]', () => {
  const folder = givenAWorkingBranch();

  const run = whenAWriteIsProposed(folder, [join(folder.env.HOME, '.agent/memory/notes.md')]);

  thenHookAnswers(run, allowed);
});

it('A shell command is never held for a plan, and an unapproved change made through it is reported at turn end. [AC0017.6]', () => {
  const folder = givenAWorkingBranch();

  const command = whenACommandIsProposed(folder, 'echo 5 > src/add.sh');
  thenHookAnswers(command, allowed);
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');

  const turnEnd = whenTurnEnds(folder);
  const answer = thenHookAnswers(turnEnd, { keepWorking: false, messages: [{ code: 'warning', for: 'operator' }] });
  thenContains(answer.messages[0].text, 'The working tree has changes, but no plan has been approved on this branch.');
});

it('Writing a plan or a follow-up keeps a verified receipt standing. [AC0017.7]', () => {
  const folder = givenAWorkingBranch();
  // A plans folder git tracks, so writing in it would change the tree.
  givenRulebookChanges(folder, book => { book.plans.dir = 'proposals'; });
  givenFileContents(folder, 'proposals/change.md', whenFileIsRead(folder, planFile));
  thenHookReplies(whenPlanIsApproved(folder, 'proposals/change.md'), 0);
  givenFileContents(folder, 'src/extra.sh', 'echo extra\n');
  thenItExits(whenTriageRuns(folder), 0);
  thenHookReplies(whenTurnEnds(folder), 0);
  thenStateShowsPhase(whenStateIsShown(folder), 'verified');

  givenFileContents(folder, 'proposals/next.md', '## Why\n\nLater.\n');
  givenFileContents(folder, 'proposals/change.md', '## Why\n\nEdited after approval.\n');
  givenFileContents(folder, 'FOLLOW-UPS.md', '- Later.\n');

  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'verified');

  givenFileContents(folder, 'proposals/drafts/old.md', '## Why\n\nOlder.\n');

  const drafted = whenStateIsShown(folder);
  thenStateShowsPhase(drafted, 'converging');
});

it('A broken logbook denies every write in the repository, but not shell commands. [AC0018.1]', () => {
  const folder = givenAWorkingBranch();
  givenABrokenLogbook(folder);

  thenHookAnswers(whenAWriteIsProposed(folder, ['src/add.sh']), stop);
  thenHookAnswers(whenAWriteIsProposed(folder, ['tests/add.sh']), stop);
  thenHookAnswers(whenAWriteIsProposed(folder, [], ['src/add.sh']), stop);
  thenHookAnswers(whenACommandIsProposed(folder, 'echo 5 > src/add.sh'), allowed);
});

it('A file where the logbook folder should be reads as a broken logbook and denies edits. [AC0018.2]', () => {
  const folder = givenAWorkingBranch();
  givenAFileWhereTheLogbookShouldBe(folder);

  const state = whenStateIsShown(folder);
  thenValueIs(state.status, 1);
  thenTextMatches(state.stdout, /^phase\s+broken$/m);
  thenContains(state.stdout, '.katatay/state/work cannot be read as a folder (ENOTDIR)');

  const edit = whenAWriteIsProposed(folder, ['src/add.sh']);
  thenHookAnswers(edit, stop);

  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, false);
});

it('A folder where an event file should be denies every editing tool and names the file. [AC0018.3]', () => {
  const folder = givenAWorkingBranch();
  givenAFolderWhereAnEventShouldBe(folder);

  for (const input of [
    { tool_name: 'Edit', tool_input: { file_path: join(folder.cwd, 'src/add.sh'), old_string: '4', new_string: '5' } },
    { tool_name: 'Write', tool_input: { file_path: join(folder.cwd, 'src/new.sh'), content: 'echo new\n' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(folder.cwd, 'src/book.ipynb'), new_source: '' } },
  ]) {
    const run = whenKttyRuns(['agent', 'claude', 'pre-tool'], {
      in: folder, input: JSON.stringify({ cwd: folder.cwd, hook_event_name: 'PreToolUse', ...input }),
    });

    const answer = thenHookReplies(run, 0);
    thenValueIs(answer.hookSpecificOutput.permissionDecision, 'deny');
    thenContains(answer.hookSpecificOutput.permissionDecisionReason, '0001__plan_approved.json');
  }
});

it('A branch with no commit yet is open, says why, and cannot be approved into. [AC0018.4]', () => {
  const folder = givenAWorkingBranch();
  givenABranchWithNoCommit(folder);

  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'open');
  thenContains(state.stdout, 'this branch has no commit yet, so there is nothing to measure a change from');

  thenHookAnswers(whenAWriteIsProposed(folder, ['src/add.sh']), needsPlan);

  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, false);
  thenEventsEqual(folder, [], 'fresh');
});

it('Plan files and the follow-ups file stay writable in each of these cases. [AC0018.5]', () => {
  for (const given of [givenABrokenLogbook, givenAFileWhereTheLogbookShouldBe, givenAFolderWhereAnEventShouldBe, givenABranchWithNoCommit]) {
    const folder = givenAWorkingBranch();
    given(folder);

    const run = whenAWriteIsProposed(folder, ['plans/next.md', 'FOLLOW-UPS.md']);

    thenHookAnswers(run, allowed);
  }
});

it('Reading a file is never blocked. [AC0018.6]', () => {
  for (const given of [givenABrokenLogbook, givenAFileWhereTheLogbookShouldBe, givenAFolderWhereAnEventShouldBe]) {
    const folder = givenAWorkingBranch();
    given(folder);

    const read = whenKttyRuns(['agent', 'claude', 'pre-tool'], {
      in: folder,
      input: JSON.stringify({ cwd: folder.cwd, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(folder.cwd, 'src/add.sh') } }),
    });
    thenItExits(read, 0);
    thenValueIs(read.stdout, '');

    thenHookAnswers(whenACommandIsProposed(folder, 'cat .katatay/state/work/0001__plan_approved.json'), allowed);
  }
});

it('A denial caused by unreadable state is a stop for the operator. [AC0018.7]', () => {
  const folder = givenAWorkingBranch();
  givenABrokenLogbook(folder);

  const run = whenAWriteIsProposed(folder, ['src/add.sh']);

  const answer = thenHookAnswers(run, stop);
  thenContains(answer.messages[0].text, 'Stop and tell the operator. Do not work around it.');
});
