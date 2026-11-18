import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, givenRulebookChanges } from '../support/project.mjs';
import { givenARequirement, whenReqRuns } from '../support/requirements.mjs';

// The test report the last run left: one testcase per case, with the
// reporter's properties when a case gives them.
function givenTheLastRunReported(folder, cases) {
  givenRulebookChanges(folder, book => { book.tests.paths.all = ['tests/**', 'acceptance/**']; });
  for (const file of new Set(cases.map(item => item.file))) {
    if (!cases.some(item => item.file === file && item.source)) givenFileContents(folder, file, '# tests\n');
  }
  for (const item of cases.filter(item => item.source)) givenFileContents(folder, item.file, item.source);
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const testcases = cases.filter(item => !item.notCollected).map(item => {
    const properties = Object.entries(item.properties ?? {}).map(([name, value]) => `<property name="${name}" value="${value}"/>`).join('');
    const status = item.skipped ? '<skipped/>' : '';
    return `<testcase name="${escape(item.name)}" file="${item.file}">${properties ? '<properties>' + properties + '</properties>' : ''}${status}</testcase>`;
  }).join('');
  givenFileContents(folder, 'reports/junit.xml', `<testsuites><testsuite name="suite">${testcases}</testsuite></testsuites>\n`);
}
const cancel = {
  statement: 'A customer can cancel an order.',
  scenarios: ['[AC0001.1] A cancelled order is not shipped.', '[AC0001.2] A shipped order cannot be cancelled.'],
};

it('A scenario whose acceptance test is titled with its words and id passes. [AC0062.1]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenTheLastRunReported(folder, [
    { file: 'acceptance/cancel.sh', name: 'A cancelled order is not shipped. [AC0001.1]' },
    { file: 'acceptance/cancel.sh', name: 'A shipped order cannot be cancelled. [AC0001.2]' },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:trace — every active requirement has evidence']);
});

it('A scenario of an active AC with no acceptance test, or with only ordinary tests, fails. [AC0062.2]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenARequirement(folder, 'acceptance/AC0002__agreed.md', { status: 'accepted', statement: 'Agreed.', scenarios: ['[AC0002.1] Agreed one.'] });
  givenTheLastRunReported(folder, [
    { file: 'tests/cancel.sh', name: 'A cancelled order is not shipped. [AC0001.1]' },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:trace — 2 problem(s)',
    '  AC0001.1: is a scenario of an active requirement but no acceptance test carries [AC0001.1]',
    '  AC0001.2: is a scenario of an active requirement but no acceptance test carries [AC0001.2]',
  ]);
});

it('A skipped, expected-to-fail or never-collected test is not evidence, but its title and tag are still checked. [AC0062.3]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenARequirement(folder, 'acceptance/AC0002__ship.md', { statement: 'Orders ship.', scenarios: ['[AC0002.1] An order ships.'] });
  givenTheLastRunReported(folder, [
    { file: 'acceptance/cancel.sh', name: 'A cancelled order is not shipped. [AC0001.1]', skipped: true },
    { file: 'acceptance/cancel.sh', name: 'A shipped order cannot be cancelled. [AC0001.2]', properties: { inverted: 'true' } },
    { file: 'acceptance/skipped.sh', name: 'A shipped order is cancelled. [AC0001.2]', skipped: true },
    { file: 'acceptance/ship.sh', name: 'An order ships. [AC0002.1]', notCollected: true, source: "it('An order ships. [AC0002.1]')\n" },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:trace — 4 problem(s)',
    '  AC0002.1: tagged in acceptance/ship.sh, which the test report leaves out — the file failed to load, or the run never reached it',
    '  AC0001.2: test title in acceptance/skipped.sh does not match its scenario',
    '      scenario: A shipped order cannot be cancelled.',
    '      test:     A shipped order is cancelled.',
    '  AC0001.1: is a scenario of an active requirement but every test carrying it is skipped — a test that may not run is not evidence',
    '  AC0001.2: is a scenario of an active requirement but every test carrying it is marked as expected to fail — a test that passes when its body fails proves the opposite of its title; or skipped — a test that may not run is not evidence',
  ]);
});

it('Titles are compared by words only, ignoring case, whitespace, punctuation and leading group names. [AC0062.4]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenTheLastRunReported(folder, [
    { file: 'acceptance/cancel.sh', name: 'orders > cancelling > a   CANCELLED order, is not shipped [AC0001.1]' },
    { file: 'acceptance/cancel.sh', name: "A shipped order can't-not be cancelled [AC0001.2]" },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:trace — 1 problem(s)',
    '  AC0001.2: test title in acceptance/cancel.sh does not match its scenario',
    '      scenario: A shipped order cannot be cancelled.',
    "      test:     A shipped order can't-not be cancelled",
  ]);
});

it('A tag naming a missing scenario, a withdrawn or superseded requirement, or two scenarios at once fails. [AC0062.5]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenARequirement(folder, 'acceptance/AC0002__gone.md', { status: 'withdrawn', statement: 'Gone.', scenarios: ['[AC0002.1] Gone one.'] });
  givenARequirement(folder, 'acceptance/AC0003__old.md', { status: 'superseded', supersededBy: 'AC0001', statement: 'Old.', scenarios: ['[AC0003.1] Old one.'] });
  givenTheLastRunReported(folder, [
    { file: 'acceptance/cancel.sh', name: 'A cancelled order is not shipped. [AC0001.1]' },
    { file: 'acceptance/cancel.sh', name: 'A shipped order cannot be cancelled. [AC0001.2]' },
    { file: 'acceptance/missing.sh', name: 'A refund is paid. [AC0001.9]' },
    { file: 'acceptance/gone.sh', name: 'Gone one. [AC0002.1]' },
    { file: 'acceptance/old.sh', name: 'Old one. [AC0003.1]' },
    { file: 'acceptance/both.sh', name: 'Both at once. [AC0001.1] [AC0001.2]' },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:trace — 4 problem(s)',
    '  AC0001.9: tagged in acceptance/missing.sh but no such scenario exists',
    '  AC0001.1: acceptance/both.sh ("Both at once. [AC0001.1] [AC0001.2]") names 2 scenarios — a test proves one, so its title can match one',
    '  AC0002: tagged in acceptance/gone.sh but the requirement is withdrawn — retire the evidence with it',
    '  AC0003: tagged in acceptance/old.sh but the requirement is superseded — retire the evidence with it',
  ]);
});

it('A bare AC tag fails, and a bare INV tag passes. [AC0062.6]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenARequirement(folder, 'invariants/INV0001__total.md', { statement: 'A paid total never changes.' });
  givenTheLastRunReported(folder, [
    { file: 'acceptance/cancel.sh', name: 'A cancelled order is not shipped. [AC0001.1]' },
    { file: 'acceptance/cancel.sh', name: 'A shipped order cannot be cancelled. [AC0001.2]' },
    { file: 'acceptance/cancel.sh', name: 'Cancelling works [AC0001]' },
    { file: 'acceptance/total.sh', name: 'The total holds [INV0001]' },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:trace — 1 problem(s)',
    '  AC0001: tagged bare in acceptance/cancel.sh ("Cancelling works [AC0001]") — tag the scenario it proves, as [AC0001.N]',
  ]);
});

it('A tag in the comment lines directly above a test counts, and tags in files that are not acceptance files are ignored. [AC0062.7]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', cancel);
  givenTheLastRunReported(folder, [
    {
      file: 'acceptance/cancel.sh', name: 'A cancelled order is not shipped',
      source: '# [AC0001.1]\ntest_cancelled() {\n  true\n}\n', properties: { line: 2, endLine: 4 },
    },
    { file: 'acceptance/shipped.sh', name: 'A shipped order cannot be cancelled. [AC0001.2]' },
    { file: 'tests/unit.sh', name: 'A refund is paid. [AC0001.9] [AC0001]' },
  ]);

  const run = whenReqRuns(folder, ['trace']);

  thenItExits(run, 0);
  thenItPrintsLines(run, ['req:trace — every active requirement has evidence']);
});
