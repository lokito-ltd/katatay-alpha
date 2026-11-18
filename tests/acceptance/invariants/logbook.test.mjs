import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsError, whenKttyRuns } from '../support/ktty.mjs';
import {
  givenAWorkingBranch, givenFileContents, whenACommandIsProposed, whenAWriteIsProposed, whenGitRuns, whenTriageRuns,
} from '../support/project.mjs';
import { thenContains, thenHookAnswers, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import {
  givenAnApproval, historyDir, whenCommitted, whenHistoryIsRead, whenPromptRuns, whenReportRuns, whenStateIsChecked,
} from '../support/history.mjs';

const locked = { allow: false, messages: [{ code: 'locked', for: 'agent' }] };

it('Appending over an existing event file is refused. [INV0001.1]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  givenFileContents(folder, historyDir + '/0002__triaged.json', 'written by someone else\n');
  const before = whenHistoryIsRead(folder);

  const triage = whenTriageRuns(folder);

  thenItPrintsError(triage, [
    'Triage refused.',
    '',
    'The workflow state chain is broken: 0002__triaged.json: is not readable as JSON. Restore the event files from git.',
    '',
    'Stop and tell the operator. Do not work around it.',
    '',
    'No logbook event was recorded.',
  ]);
  thenItExits(triage, 1);
  thenValuesEqual(whenHistoryIsRead(folder), before);
  thenValueIs(whenHistoryIsRead(folder)['0002__triaged.json'].toString(), 'written by someone else\n');
});

it('A reset is recorded by appending, and leaves every earlier event in place. [INV0001.2]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  thenItExits(whenTriageRuns(folder), 0);
  const before = whenHistoryIsRead(folder);

  const reset = whenPromptRuns(folder, 'reset');

  thenHookReplies(reset, 0);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(Object.keys(after), ['0001__plan_approved.json', '0002__triaged.json', '0003__reset.json']);
  for (const [file, bytes] of Object.entries(before)) thenValuesEqual(after[file], bytes, file);
});

it('Reading an old event never rewrites its bytes. [INV0001.3]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  thenItExits(whenTriageRuns(folder), 0);
  whenCommitted(folder, 'Logbook');
  const before = whenHistoryIsRead(folder);

  whenKttyRuns(['state', 'show'], { in: folder });
  whenStateIsChecked(folder);
  whenKttyRuns(['areas'], { in: folder });
  whenKttyRuns(['req', 'risk'], { in: folder });
  whenReportRuns(folder);

  thenValuesEqual(whenHistoryIsRead(folder), before);
  thenValueIs(whenGitRuns(folder, 'status', '--porcelain', '--', historyDir), '');
});

it('A committed event renamed out of the chain is caught. [INV0001.4]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  thenItExits(whenTriageRuns(folder), 0);
  whenCommitted(folder, 'Logbook');

  whenGitRuns(folder, 'mv', historyDir + '/0002__triaged.json', historyDir + '/triaged.json');
  const check = whenStateIsChecked(folder);

  thenItExits(check, 1);
  thenContains(check.stderr, '  .katatay/state/work: triaged.json: is not a numbered event file (NNNN__event.json). Restore the event files from git.');
});

it('A write, by an editing tool or the shell, into .katatay/state/ is denied. [INV0001.5]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);

  const edit = whenAWriteIsProposed(folder, [historyDir + '/0002__triaged.json']);
  const overwrite = whenAWriteIsProposed(folder, [historyDir + '/0001__plan_approved.json']);
  const redirect = whenACommandIsProposed(folder, 'echo {} >> ' + historyDir + '/0001__plan_approved.json');
  const removal = whenACommandIsProposed(folder, 'rm ' + historyDir + '/0001__plan_approved.json');

  thenHookAnswers(edit, locked);
  thenHookAnswers(overwrite, locked);
  thenHookAnswers(redirect, locked);
  thenHookAnswers(removal, locked);
});
