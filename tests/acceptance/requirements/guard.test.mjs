import { it } from 'vitest';
import { thenItExits, thenItPrintsErrorLines, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, whenFileIsRemoved, whenGitRuns } from '../support/project.mjs';
import { whenCommitted } from '../support/history.mjs';
import {
  givenAChangeFileRecording, givenAnApprovedPlanStating, givenARequirement, givenTheTargetCatalogue, whenReqRuns,
} from '../support/requirements.mjs';

const advice = [
  '',
  '  A plan the operator approved may approve these, by listing each one as it',
  "  will read under `requirement-changes:` in the plan's closing `workflow` block.",
  '  A renumber is listed under its new id, with the old one as `renumberedFrom`.',
];

it("A new requirement fails without approval, and passes when the approved plan's requirement-changes states it exactly. [AC0059.1]", () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] },
  });
  givenARequirement(folder, 'acceptance/AC0002__refund.md', {
    statement: 'A cancelled order is refunded.', scenarios: ['[AC0002.1] The refund is the order total.'],
  });

  const unapproved = whenReqRuns(folder, ['guard']);
  thenItExits(unapproved, 1);
  thenItPrintsErrorLines(unapproved, [
    'req:guard — 2 violation(s)',
    '  AC0002: added as a new requirement',
    '  AC0002: added but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
    ...advice,
  ]);

  givenAnApprovedPlanStating(folder, [{
    id: 'AC0002', status: 'active', statement: 'A cancelled order is refunded.',
    scenarios: ['[AC0002.1] The refund is the order total.'],
  }]);
  const approved = whenReqRuns(folder, ['guard']);
  thenItExits(approved, 0);
  thenItPrintsLines(approved, ['req:guard — no protected requirement was changed without approval']);
});

it('Deleting a requirement fails, in CI too. [AC0059.2]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] },
  });
  whenFileIsRemoved(folder, 'requirements/acceptance/AC0001__cancel.md');

  const local = whenReqRuns(folder, ['guard']);
  thenItExits(local, 1);
  thenItPrintsErrorLines(local, [
    'req:guard — 1 violation(s)',
    '  AC0001: deleted. Requirements are never deleted — set status to superseded or withdrawn instead',
  ]);

  const ci = whenReqRuns(folder, ['guard'], { CI: 'true' });
  thenItExits(ci, 1);
  thenItPrintsErrorLines(ci, [
    'req:guard — 1 violation(s)',
    '  AC0001: deleted. Requirements are never deleted — set status to superseded or withdrawn instead',
  ]);
});

it('Rewording, retiring, moving the status backwards, or removing or rewording a scenario of an active requirement fails without approval. [AC0059.3]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__reword.md': { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] },
    'acceptance/AC0002__retire.md': { statement: 'Orders ship.', scenarios: ['[AC0002.1] Shipped.'] },
    'acceptance/AC0003__back.md': { statement: 'Orders are paid.', scenarios: ['[AC0003.1] Paid.'] },
    'acceptance/AC0004__remove.md': { statement: 'Orders are packed.', scenarios: ['[AC0004.1] Packed.', '[AC0004.2] Packed tightly.'] },
    'acceptance/AC0005__scenario.md': { statement: 'Orders are tracked.', scenarios: ['[AC0005.1] Tracked.'] },
  });
  const now = {
    AC0001: { status: 'active', statement: 'Orders can be cancelled before they ship.', scenarios: ['[AC0001.1] Cancelled.'] },
    AC0002: { status: 'withdrawn', statement: 'Orders ship.', scenarios: ['[AC0002.1] Shipped.'] },
    AC0003: { status: 'accepted', statement: 'Orders are paid.', scenarios: ['[AC0003.1] Paid.'] },
    AC0004: { status: 'active', statement: 'Orders are packed.', scenarios: ['[AC0004.1] Packed.'] },
    AC0005: { status: 'active', statement: 'Orders are tracked.', scenarios: ['[AC0005.1] Tracked daily.'] },
  };
  for (const [id, fields] of Object.entries(now)) {
    const slug = { AC0001: 'reword', AC0002: 'retire', AC0003: 'back', AC0004: 'remove', AC0005: 'scenario' }[id];
    givenARequirement(folder, `acceptance/${id}__${slug}.md`, fields);
  }
  givenAChangeFileRecording(folder, '20261113T000000.000Z__changes.md', Object.entries(now).map(([id, fields]) => ({ id, ...fields })));

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 1);
  thenItPrintsErrorLines(run, [
    'req:guard — 5 violation(s)',
    /^ {2}AC0001: statement of an active requirement was reworded \([0-9a-f]+ → [0-9a-f]+\)$/,
    '  AC0002: retired without approval: active → withdrawn',
    '  AC0003: status moved backwards: active → accepted',
    '  AC0004: scenarios of an active requirement were removed or reworded: AC0004.2',
    '  AC0005: scenarios of an active requirement were removed or reworded: AC0005.1',
    ...advice,
  ]);
});

it("A rewording that the approved plan's requirement-changes states exactly passes outside CI. [AC0059.4]", () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] },
  });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', {
    statement: 'A customer can cancel an order before it ships.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  });
  givenAnApprovedPlanStating(folder, [{
    id: 'AC0001', status: 'active', statement: 'A customer can cancel an order before it ships.',
    scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  }]);

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:guard — no protected requirement was changed without approval']);
});

it('A wording different from what the plan approved fails. [AC0059.5]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] },
  });
  givenAnApprovedPlanStating(folder, [{
    id: 'AC0001', status: 'active', statement: 'A customer can cancel an order before it ships.',
    scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  }]);
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', {
    statement: 'A customer can cancel an order before it is shipped.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  });

  const run = whenReqRuns(folder, ['guard']);

  thenItExits(run, 1);
  thenItPrintsErrorLines(run, [
    'req:guard — 2 violation(s)',
    /^ {2}AC0001: statement of an active requirement was reworded \([0-9a-f]+ → [0-9a-f]+\)$/,
    '  AC0001: changed but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
    ...advice,
  ]);
});

it('An approval carried in another logbook on the branch approves a change but never accounts for it. [AC0059.6]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] },
  });
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', {
    statement: 'A customer can cancel an order before it ships.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  });
  givenAnApprovedPlanStating(folder, [{
    id: 'AC0001', status: 'active', statement: 'A customer can cancel an order before it ships.',
    scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  }]);
  whenCommitted(folder, 'First change');
  whenGitRuns(folder, 'switch', '-qc', 'batch');
  givenAnApprovedPlanStating(folder, []);

  const unaccounted = whenReqRuns(folder, ['guard']);
  thenItExits(unaccounted, 1);
  thenItPrintsErrorLines(unaccounted, [
    'req:guard — 1 violation(s)',
    '  AC0001: changed but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__first.md', [{
    id: 'AC0001', status: 'active', statement: 'A customer can cancel an order before it ships.',
    scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  }]);
  const accounted = whenReqRuns(folder, ['guard']);
  thenItExits(accounted, 0);
  thenItPrintsLines(accounted, ['req:guard — no protected requirement was changed without approval']);
});

it('A promotion to active, or an added scenario, passes only once a change file records it. [AC0059.7]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__agreed.md': { status: 'accepted', statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] },
    'acceptance/AC0002__built.md': { statement: 'Built.', scenarios: ['[AC0002.1] Built one.'] },
  });
  const promoted = { id: 'AC0001', status: 'active', statement: 'Agreed.', scenarios: ['[AC0001.1] Agreed one.'] };
  const extended = { id: 'AC0002', status: 'active', statement: 'Built.', scenarios: ['[AC0002.1] Built one.', '[AC0002.2] Built two.'] };
  givenARequirement(folder, 'acceptance/AC0001__agreed.md', promoted);
  givenARequirement(folder, 'acceptance/AC0002__built.md', extended);

  const unrecorded = whenReqRuns(folder, ['guard']);
  thenItExits(unrecorded, 1);
  thenItPrintsErrorLines(unrecorded, [
    'req:guard — 2 violation(s)',
    '  AC0001: changed but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
    '  AC0002: changed but no change file on this branch accounts for it, and the approved plan does not list it as it now reads',
  ]);

  givenAChangeFileRecording(folder, '20261113T000000.000Z__built.md', [promoted, extended]);
  const recorded = whenReqRuns(folder, ['guard']);
  thenItExits(recorded, 0);
  thenItPrintsLines(recorded, ['req:guard — no protected requirement was changed without approval']);
});
