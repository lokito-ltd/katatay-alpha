import { it } from 'vitest';
import { thenItExits, thenItPrintsErrorLines, thenItPrintsLines, thenItPrintsOnBoth } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, givenTheTargetHolds, whenFileIsRemoved } from '../support/project.mjs';
import {
  givenAChangeFileRecording, givenAnApprovedPlanStating, givenARequirement, givenTheTargetCatalogue, requirementText, whenReqRuns,
} from '../support/requirements.mjs';

it('A change file whose status, statement or scenarios differ from the catalogue fails, in CI too. [AC0060.1]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__status.md': { status: 'accepted', statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] },
    'acceptance/AC0002__statement.md': { status: 'accepted', statement: 'Orders ship.', scenarios: ['[AC0002.1] Shipped.'] },
    'acceptance/AC0003__scenarios.md': { status: 'accepted', statement: 'Orders are paid.', scenarios: ['[AC0003.1] Paid.'] },
  });
  givenARequirement(folder, 'acceptance/AC0001__status.md', { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] });
  givenARequirement(folder, 'acceptance/AC0002__statement.md', { statement: 'Orders ship.', scenarios: ['[AC0002.1] Shipped.'] });
  givenARequirement(folder, 'acceptance/AC0003__scenarios.md', { statement: 'Orders are paid.', scenarios: ['[AC0003.1] Paid.'] });
  givenAChangeFileRecording(folder, '20261113T000000.000Z__promote.md', [
    { id: 'AC0001', status: 'accepted', statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] },
    { id: 'AC0002', status: 'active', statement: 'Orders ship quickly.', scenarios: ['[AC0002.1] Shipped.'] },
    { id: 'AC0003', status: 'active', statement: 'Orders are paid.', scenarios: ['[AC0003.1] Paid in full.'] },
  ]);
  const findings = [
    'req:guard — 3 violation(s)',
    '  AC0001: is recorded as accepted but the catalogue says active',
    '  AC0002: has a statement in its change file that is not the statement in the catalogue',
    '  AC0003: has scenarios in its change file that are not the scenarios in the catalogue — list every one, as the AC file writes it',
  ];

  const local = whenReqRuns(folder, ['guard']);
  thenItExits(local, 1);
  thenItPrintsErrorLines(local, findings);

  const ci = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(ci, 1);
  thenItPrintsErrorLines(ci, findings);
});

it('Only the newest change file that records a requirement must match the catalogue. [AC0060.2]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__agreed.md': { status: 'accepted', statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] },
  });
  givenARequirement(folder, 'acceptance/AC0001__agreed.md', { statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] });
  givenAChangeFileRecording(folder, '20261101T000000.000Z__earlier.md', [
    { id: 'AC0001', status: 'accepted', statement: 'Agreed at first.', scenarios: ['[AC0001.1] Agreed one.'] },
  ]);
  givenAChangeFileRecording(folder, '20261102T000000.000Z__later.md', [
    { id: 'AC0001', status: 'active', statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] },
  ]);

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:guard — no protected requirement was changed without approval']);
});

it('A mention of an id in prose accounts for nothing. [AC0060.3]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__agreed.md': { status: 'accepted', statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] },
  });
  givenARequirement(folder, 'acceptance/AC0001__agreed.md', { statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] });
  givenAChangeFileRecording(folder, '20261113T000000.000Z__prose.md', [], 'This change promotes AC0001 to active, see [AC0001].');

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 1);
  thenItPrintsErrorLines(run, [
    'req:guard — 1 violation(s)',
    '  AC0001: changed but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
  ]);
});

it('A retirement must be recorded in a change file even when the statement is unchanged. [AC0060.4]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] },
  });
  const retired = { id: 'AC0001', status: 'withdrawn', statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] };
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', retired);
  givenAnApprovedPlanStating(folder, [retired]);

  const unrecorded = whenReqRuns(folder, ['guard', '--record']);
  thenItExits(unrecorded, 1);
  thenItPrintsErrorLines(unrecorded, [
    'req:guard — 1 violation(s)',
    '  AC0001: changed but no change file on this branch accounts for it',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__retire.md', [retired]);
  const recorded = whenReqRuns(folder, ['guard', '--record']);
  thenItExits(recorded, 0);
  thenItPrintsLines(recorded, ['req:guard — no protected requirement was changed without approval']);
});

it('The change file template and change files already on the target are not judged. [AC0060.5]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] });
  givenFileContents(folder, 'requirements/changes/20261101T000000.000Z__merged.md',
    '---\nrequirements:\n  - id: AC0001\n    status: accepted\n    statement: An older wording.\n---\n\n# Merged long ago\n');
  givenTheTargetHolds(folder, 'Catalogue and its history');
  givenFileContents(folder, 'requirements/changes/TEMPLATE.md',
    '---\nrequirements:\n  - id: AC0001\n    status: withdrawn\n    statement: A placeholder.\n---\n\n# <short title>\n');

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:guard — no protected requirement was changed without approval']);
});

it('A renumber needs a change file that records the requirement under its new id. [AC0060.6]', () => {
  const folder = givenAWorkingBranch();
  const cancel = { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] };
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  whenFileIsRemoved(folder, 'requirements/acceptance/AC0001__cancel.md');
  givenFileContents(folder, 'requirements/acceptance/AC0002__cancel.md',
    requirementText({ statement: cancel.statement, scenarios: ['[AC0002.1] Cancelled.'] }));

  givenAChangeFileRecording(folder, '20261113T000000.000Z__renumber.md', [{ id: 'AC0001', status: 'active', ...cancel }]);
  const oldId = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(oldId, 1);
  thenItPrintsOnBoth(oldId, [
    'req:guard — a reviewer must read these before merging:',
    '  AC0001: id changed AC0001 → AC0002, and AC0001 exists on main',
    '',
  ], [
    'req:guard — 2 violation(s)',
    '  AC0001: renumbered to AC0002, but no change file on this branch accounts for AC0002',
    '  AC0001: is recorded in a change file but does not exist in the catalogue on this branch',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__renumber.md', [
    { id: 'AC0002', renumberedFrom: 'AC0001', status: 'active', statement: cancel.statement, scenarios: ['[AC0002.1] Cancelled.'] },
  ]);
  const newId = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(newId, 0);
  thenItPrintsLines(newId, [
    'req:guard — a reviewer must read these before merging:',
    '  AC0001: id changed AC0001 → AC0002, and AC0001 exists on main',
    '',
    'req:guard — 1 change(s) for the reviewer, nothing forbidden',
  ]);
});
