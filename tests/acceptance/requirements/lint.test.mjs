import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents } from '../support/project.mjs';
import { givenARequirement, whenReqRuns } from '../support/requirements.mjs';

it('A well-formed catalogue passes and says so. [AC0058.1]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', {
    statement: 'A customer can cancel an order.', scenarios: ['[AC0001.1] A cancelled order is not shipped.'],
  });
  givenARequirement(folder, 'invariants/INV0001__total.md', { statement: 'A paid total never changes.' });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:lint — catalogue OK']);
});

it('A filename without an id, or a requirement in the wrong type folder, fails. [AC0058.2]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/cancel.md', { statement: 'A customer can cancel an order.' });
  givenARequirement(folder, 'invariants/AC0002__ship.md', {
    statement: 'An order ships.', scenarios: ['[AC0002.1] It ships.'],
  });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 2 problem(s)',
    '  requirements/acceptance/cancel.md: filename must match (AC|INV)NNNN__lower_snake_slug.md',
    '  requirements/invariants/AC0002__ship.md: AC requirement must live in acceptance/, not invariants/',
  ]);
});

it('A body with no statement, or an unknown status, fails. [AC0058.3]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'requirements/invariants/INV0001__empty.md', '---\nstatus: active\n---\n\n');
  givenARequirement(folder, 'invariants/INV0002__done.md', { status: 'done', statement: 'A paid total never changes.' });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 2 problem(s)',
    '  requirements/invariants/INV0001__empty.md: body has no statement — the first non-empty line is the requirement',
    '  requirements/invariants/INV0002__done.md: status must be one of accepted, active, superseded, withdrawn (got "done")',
  ]);
});

it('The same id in two files fails. [AC0058.4]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'invariants/INV0001__total.md', { statement: 'A paid total never changes.' });
  givenARequirement(folder, 'invariants/INV0001__price.md', { statement: 'A price is never negative.' });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 1 problem(s)',
    '  requirements/invariants/INV0001__price.md, requirements/invariants/INV0001__total.md: duplicate id INV0001',
  ]);
});

it('A superseded requirement must name a replacement that exists, and its trail must not end in a withdrawn requirement. [AC0058.5]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'invariants/INV0001__unnamed.md', { status: 'superseded', statement: 'Old rule one.' });
  givenARequirement(folder, 'invariants/INV0002__missing.md', { status: 'superseded', supersededBy: 'INV0009', statement: 'Old rule two.' });
  givenARequirement(folder, 'invariants/INV0003__dead_end.md', { status: 'superseded', supersededBy: 'INV0004', statement: 'Old rule three.' });
  givenARequirement(folder, 'invariants/INV0004__gone.md', { status: 'withdrawn', statement: 'Withdrawn rule.' });
  givenARequirement(folder, 'invariants/INV0005__kept.md', { status: 'superseded', supersededBy: 'INV0006', statement: 'Old rule five.' });
  givenARequirement(folder, 'invariants/INV0006__new.md', { statement: 'New rule.' });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 3 problem(s)',
    '  requirements/invariants/INV0001__unnamed.md: status superseded requires supersededBy naming the replacement',
    '  requirements/invariants/INV0002__missing.md: supersededBy INV0009 does not exist',
    '  requirements/invariants/INV0003__dead_end.md: supersededBy INV0004 is withdrawn — the trail dead-ends',
  ]);
});

it('An accepted or active AC with no scenario fails, and an invariant without scenarios passes. [AC0058.6]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__agreed.md', { status: 'accepted', statement: 'Agreed.' });
  givenARequirement(folder, 'acceptance/AC0002__built.md', { status: 'active', statement: 'Built.' });
  givenARequirement(folder, 'acceptance/AC0003__withdrawn.md', { status: 'withdrawn', statement: 'Dropped.' });
  givenARequirement(folder, 'invariants/INV0001__total.md', { status: 'active', statement: 'A paid total never changes.' });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 2 problem(s)',
    '  requirements/acceptance/AC0001__agreed.md: has no scenarios — list what the AC promises under `## Scenarios`, one `- [AC0001.1] …` per line',
    '  requirements/acceptance/AC0002__built.md: has no scenarios — list what the AC promises under `## Scenarios`, one `- [AC0002.1] …` per line',
  ]);
});

it('A scenario line that is not an id and text, or whose id belongs to another requirement or is used twice, fails. [AC0058.7]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', {
    statement: 'A customer can cancel an order.',
    scenarios: ['[AC0001.1] A cancelled order is not shipped.', 'A refund is paid.', '[AC0002.1] Borrowed.', '[AC0001.1] Again.'],
  });

  const run = whenReqRuns(folder, ['lint']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 3 problem(s)',
    '  requirements/acceptance/AC0001__cancel.md: scenario is not `- [AC0001.N] text`: A refund is paid.',
    '  requirements/acceptance/AC0001__cancel.md: scenario AC0002.1 belongs to another requirement — scenarios here are AC0001.N',
    '  requirements/acceptance/AC0001__cancel.md: duplicate scenario id AC0001.1',
  ]);
});
