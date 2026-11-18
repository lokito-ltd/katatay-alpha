import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import { exists, givenAWorkingBranch, givenFileContents, givenRulebookChanges, whenFileIsRead } from '../support/project.mjs';
import { thenPathsExist, thenValueIs } from '../support/assertions.mjs';
import {
  givenAnApprovedPlanStating, givenARequirement, givenTheTargetCatalogue, requirementText, whenReqRuns, whenRequirementIsRead,
} from '../support/requirements.mjs';

const refund = { statement: 'A cancelled order is refunded.', scenarios: ['[AC0005.1] The refund is the order total.'] };
const cancel = { statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'] };

it('Missing arguments exit 2 and print the usage. [AC0063.1]', () => {
  const folder = givenAWorkingBranch();

  for (const args of [['renumber'], ['renumber', 'AC0005']]) {
    const run = whenReqRuns(folder, args);
    thenItExits(run, 2);
    thenItPrintsError(run, ['Usage: ktty req renumber <fromId> <toId>.', "Run 'ktty help' for usage."]);
  }
});

it('It renames the file and rewrites the id in tests, pages and code wherever they are. [AC0063.2]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0005__refund.md', refund);
  givenFileContents(folder, 'requirements/changes/20261113T000000.000Z__refund.md', 'Adds AC0005.\n');
  givenFileContents(folder, 'tests/deep/refund.sh', '# The refund is the order total. [AC0005.1]\n');
  givenFileContents(folder, 'src/billing/refund.sh', '# AC0005: refund the total\necho 4\n');

  const run = whenReqRuns(folder, ['renumber', 'AC0005', 'AC0006']);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    '  updated requirements/acceptance/AC0005__refund.md',
    '  updated requirements/changes/20261113T000000.000Z__refund.md',
    '  updated src/billing/refund.sh',
    '  updated tests/deep/refund.sh',
    '  updated requirements/acceptance/AC0005__refund.md → requirements/acceptance/AC0006__refund.md',
    'req:renumber — AC0005 is now AC0006',
  ]);
  thenPathsExist(folder, ['requirements/acceptance/AC0005__refund.md'], false);
  thenValueIs(whenRequirementIsRead(folder, 'acceptance/AC0006__refund.md'),
    requirementText({ statement: refund.statement, scenarios: ['[AC0006.1] The refund is the order total.'] }));
  thenValueIs(whenFileIsRead(folder, 'requirements/changes/20261113T000000.000Z__refund.md'), 'Adds AC0006.\n');
  thenValueIs(whenFileIsRead(folder, 'tests/deep/refund.sh'), '# The refund is the order total. [AC0006.1]\n');
  thenValueIs(whenFileIsRead(folder, 'src/billing/refund.sh'), '# AC0006: refund the total\necho 4\n');
});

it('It leaves alone files that are neither the catalogue, a test nor code. [AC0063.3]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0005__refund.md', refund);
  givenFileContents(folder, 'README.md', 'See AC0005.\n');
  givenFileContents(folder, 'docs/refunds.txt', 'AC0005 explains refunds.\n');

  const run = whenReqRuns(folder, ['renumber', 'AC0005', 'AC0006']);

  thenItExits(run, 0);
  thenValueIs(whenFileIsRead(folder, 'README.md'), 'See AC0005.\n');
  thenValueIs(whenFileIsRead(folder, 'docs/refunds.txt'), 'AC0005 explains refunds.\n');
});

it('It refuses an id that is already taken, a change from AC to INV, or an id that does not exist. [AC0063.4]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0005__refund.md', refund);
  givenARequirement(folder, 'acceptance/AC0006__ship.md', { statement: 'Orders ship.', scenarios: ['[AC0006.1] It ships.'] });
  const before = whenRequirementIsRead(folder, 'acceptance/AC0005__refund.md');

  const taken = whenReqRuns(folder, ['renumber', 'AC0005', 'AC0006']);
  thenItExits(taken, 1);
  thenItPrintsError(taken, ['req:renumber — AC0006 is already taken']);

  const kind = whenReqRuns(folder, ['renumber', 'AC0005', 'INV0005']);
  thenItExits(kind, 1);
  thenItPrintsError(kind, ['req:renumber — cannot change a requirement\'s type: AC0005 → INV0005']);

  const missing = whenReqRuns(folder, ['renumber', 'AC0009', 'AC0010']);
  thenItExits(missing, 1);
  thenItPrintsError(missing, ['req:renumber — AC0009 not found in the catalogue']);

  thenValueIs(whenRequirementIsRead(folder, 'acceptance/AC0005__refund.md'), before);
});

it('An id the target knows is refused without an approved plan, and the refusal says how to get one. [AC0063.5]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });

  const run = whenReqRuns(folder, ['renumber', 'AC0001', 'AC0002']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    "req:renumber — AC0001 exists on main. Renumbering an agreed requirement changes its identity, so it needs the operator's approval: "
      + 'a plan listing AC0002 under `requirement-changes:`, with `renumberedFrom: AC0001`, approved by the operator.',
  ]);
  thenPathsExist(folder, ['requirements/acceptance/AC0001__cancel.md'], true);
});

it('An id the target knows is renumbered only when the approved plan names that exact pair. [AC0063.6]', () => {
  const folder = givenAWorkingBranch();
  givenTheTargetCatalogue(folder, { 'acceptance/AC0001__cancel.md': cancel });
  givenAnApprovedPlanStating(folder, [{
    id: 'AC0003', renumberedFrom: 'AC0001', status: 'active', statement: cancel.statement, scenarios: ['[AC0003.1] A cancelled order is not shipped.'],
  }]);

  const otherPair = whenReqRuns(folder, ['renumber', 'AC0001', 'AC0002']);
  thenItExits(otherPair, 1);
  thenPathsExist(folder, ['requirements/acceptance/AC0001__cancel.md'], true);

  const approvedPair = whenReqRuns(folder, ['renumber', 'AC0001', 'AC0003']);
  thenItExits(approvedPair, 0);
  thenPathsExist(folder, ['requirements/acceptance/AC0001__cancel.md'], false);
  thenPathsExist(folder, ['requirements/acceptance/AC0003__cancel.md'], true);
});

it('It works in the requirements folder the rulebook names. [AC0063.7]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.requirementsDir = 'catalogue'; });
  givenARequirement(folder, 'acceptance/AC0005__refund.md', refund, 'catalogue');

  const run = whenReqRuns(folder, ['renumber', 'AC0005', 'AC0006']);

  thenItExits(run, 0);
  thenPathsExist(folder, ['catalogue/acceptance/AC0005__refund.md'], false);
  thenValueIs(exists(folder, 'catalogue/acceptance/AC0006__refund.md'), true);
});
