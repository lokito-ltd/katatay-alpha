import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsErrorLines, thenItPrintsLines, thenItPrintsOnBoth } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, whenFileIsRemoved, whenGitRuns } from '../support/project.mjs';
import { approvalFile } from '../support/history.mjs';
import { givenAPublisher, whenRemoteGoesOffline, whenTargetAdvances } from '../support/remote.mjs';
import {
  givenAChangeFileRecording, givenAnApprovedPlanStating, givenARequirement, givenTheTargetCatalogue, requirementText, whenReqRuns,
} from '../support/requirements.mjs';

const cancel = { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] };
const reworded = {
  id: 'AC0001', status: 'active', statement: 'A customer can cancel an order before it ships.',
  scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
};
const rewordedLine = /^ {2}AC0001: statement of an active requirement was reworded \([0-9a-f]+ → [0-9a-f]+\)$/;

it('Under CI=true, a reworded requirement with a change file is listed for the reviewer and does not fail. [AC0061.1]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', reworded);
  givenAChangeFileRecording(folder, '20261113T000000.000Z__reword.md', [reworded]);

  const run = whenReqRuns(folder, ['guard'], { CI: 'true' });

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'req:guard — a reviewer must read these before merging:',
    rewordedLine,
    '',
    'req:guard — 1 change(s) for the reviewer, nothing forbidden',
  ]);
});

it('CI set to anything other than true is treated as local. [AC0061.2]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', reworded);
  givenAChangeFileRecording(folder, '20261113T000000.000Z__reword.md', [reworded]);

  for (const value of ['1', 'yes', 'TRUE']) {
    const run = whenReqRuns(folder, ['guard'], { CI: value });
    thenItExits(run, 1);
    thenItPrintsErrorLines(run, [
      'req:guard — 1 violation(s)',
      rewordedLine,
      '',
      '  A plan the operator approved may approve these, by listing each one as it',
      "  will read under `requirement-changes:` in the plan's closing `workflow` block.",
      '  A renumber is listed under its new id, with the old one as `renumberedFrom`.',
    ]);
  }
});

it('Under CI=true the guard does not read the logbook. [AC0061.3]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', reworded);
  givenAChangeFileRecording(folder, '20261113T000000.000Z__reword.md', [reworded]);
  givenAnApprovedPlanStating(folder, [reworded]);
  givenFileContents(folder, approvalFile, '{"seq":');

  const run = whenReqRuns(folder, ['guard'], { CI: 'true' });

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'req:guard — a reviewer must read these before merging:',
    rewordedLine,
    '',
    'req:guard — 1 change(s) for the reviewer, nothing forbidden',
  ]);
});

it('Under CI=true the guard fetches the target first, and when the server does not answer it exits 1 with one line naming the target. [AC0061.4]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  const publisher = givenAPublisher(folder);
  whenTargetAdvances(publisher, 'requirements/acceptance/AC0001__cancel.md', requirementText(reworded));
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', reworded);

  const stale = whenReqRuns(folder, ['guard']);
  thenItExits(stale, 1);

  const fetched = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(fetched, 0);
  thenItPrintsLines(fetched, ['req:guard — no protected requirement was changed without approval']);

  whenRemoteGoesOffline(folder);
  const offline = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(offline, 1);
  thenItPrintsError(offline, ['req:guard — could not fetch origin/main from the server, so nothing here can be compared against it']);
});

it('Without the target ref, the guard exits 1 with one line naming the target and judges nothing. [AC0061.5]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  whenFileIsRemoved(folder, 'requirements/acceptance/AC0001__cancel.md');
  whenGitRuns(folder, 'update-ref', '-d', 'refs/remotes/origin/main');

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:guard — the target origin/main is not here, so this branch has nothing to compare against. Push the target branch, or fetch it, and run again.',
  ]);
});

it('Before record, a plan entry stands in for the change file, but with --record the change file is required. [AC0061.6]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', reworded);
  givenAnApprovedPlanStating(folder, [reworded]);

  const beforeRecord = whenReqRuns(folder, ['guard']);
  thenItExits(beforeRecord, 0);
  thenItPrintsLines(beforeRecord, ['req:guard — no protected requirement was changed without approval']);

  const atRecord = whenReqRuns(folder, ['guard', '--record']);
  thenItExits(atRecord, 1);
  thenItPrintsErrorLines(atRecord, [
    'req:guard — 1 violation(s)',
    '  AC0001: changed but no change file on this branch accounts for it',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__reword.md', [reworded]);
  const recorded = whenReqRuns(folder, ['guard', '--record']);
  thenItExits(recorded, 0);
  thenItPrintsLines(recorded, ['req:guard — no protected requirement was changed without approval']);
});

it('Under CI=true, a new requirement with a change file is listed for the reviewer, and one without a change file fails. [AC0061.7]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  const refund = {
    id: 'AC0002', status: 'active', statement: 'A cancelled order is refunded.',
    scenarios: ['[AC0002.1] The refund is the order total.'],
  };
  givenARequirement(folder, 'acceptance/AC0002__refund.md', refund);

  const unrecorded = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(unrecorded, 1);
  thenItPrintsOnBoth(unrecorded, [
    'req:guard — a reviewer must read these before merging:',
    '  AC0002: added as a new requirement',
    '',
  ], [
    'req:guard — 1 violation(s)',
    '  AC0002: added but no change file on this branch accounts for it',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__refund.md', [refund]);
  const recorded = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(recorded, 0);
  thenItPrintsLines(recorded, [
    'req:guard — a reviewer must read these before merging:',
    '  AC0002: added as a new requirement',
    '',
    'req:guard — 1 change(s) for the reviewer, nothing forbidden',
  ]);
});
