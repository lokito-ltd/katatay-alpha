import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  givenTheTestCommandCountsItsRuns,
  whenEventsAreRead,
  whenFileIsRead,
  whenGitRuns,
} from '../support/project.mjs';
import {
  givenACheck,
  givenAConvergingChange,
  givenMutation,
  whenCheckStartsAreRead,
  whenMutationRequestsAreRead,
  whenVerifyRuns,
} from '../support/checks.mjs';
import { thenContains, thenEventNamesEqual, thenPathsExist, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const compileLine = 'compile — not checked: compile (the adapter says "none" in .katatay/rulebook.json)';

it('A manual verify appends no event to the logbook. [AC0033.1]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const passing = whenVerifyRuns(folder);

  thenItExits(passing, 0);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);

  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 5\n');

  const failing = whenVerifyRuns(folder);

  thenItExits(failing, 1);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
});

it('Verify checks the requirements catalogue before any adapter step. [AC0033.2]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenFileContents(folder, 'requirements/acceptance/AC0001__broken.md', 'no frontmatter here\n');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'req:lint — 1 problem(s)',
    '  requirements/acceptance/AC0001__broken.md: status must be one of accepted, active, superseded, withdrawn (got undefined)',
    '',
    'verify: failed at req:lint.',
  ]);
  thenPathsExist(folder, [marker], false);
});

it("Verify runs its own steps, then the rulebook's checks in the order listed, and exits 0. [AC0033.3]", () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'second');
  givenACheck(folder, 'codeQuality', 'first');
  givenAConvergingChange(folder);

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'req:lint — catalogue OK',
    'req:guard — no protected requirement was changed without approval',
    'state: .katatay/state/work ok (2 events)',
    compileLine,
    'tests — 1 ran, none failed',
    'req:trace — every active requirement has evidence',
    'second — clean',
    'first — clean',
    '',
    'verify: every step passed (req:lint, req:guard, state:verify, compile, tests, req:trace, second, first).',
    'verify: not checked: coverage (checks.testQuality.coverage is "none")',
    'verify: not checked: mutation (checks.testQuality.mutation is "none")',
    'verify: not checked: compile (the adapter says "none" in .katatay/rulebook.json)',
  ]);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['second', 'first']);
});

it('A failed test exits 1, is named, and no check runs after it. [AC0033.4]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint');
  givenAConvergingChange(folder, 'echo 5\n');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenContains(run.stdout + run.stderr, 'tests — 1 of 1 failed\n  tests/add.sh — adds\n');
  thenContains(run.stdout + run.stderr, 'verify: failed at tests.');
  thenValuesEqual(whenCheckStartsAreRead(folder), []);
});

it('Verify deletes old test reports before it runs the tests. [AC0033.5]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => {
    book.tests.run.command = 'if test -f reports/junit.xml; then echo present; else echo absent; fi > reports/seen; ' + book.tests.run.command;
  });
  givenAConvergingChange(folder);
  givenFileContents(folder, 'reports/junit.xml', '<testsuites/>\n');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenValueIs(whenFileIsRead(folder, 'reports/seen'), 'absent\n');
});

it('A branch can be verified by hand before any approval, measured from its merge base with the target. [AC0033.6]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  whenGitRuns(folder, 'add', '-A');
  whenGitRuns(folder, 'commit', '-qm', 'Mutation');
  whenGitRuns(folder, 'switch', '-q', 'main');
  givenFileContents(folder, 'src/target-only.sh', 'echo target\n');
  whenGitRuns(folder, 'add', 'src/target-only.sh');
  whenGitRuns(folder, 'commit', '-qm', 'Target moves on');
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'main');
  whenGitRuns(folder, 'switch', '-q', 'work');
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenValuesEqual(whenMutationRequestsAreRead(folder).map(request => request.targets), [[{ file: 'src/add.sh', lines: [1, 1] }]]);
  thenValuesEqual(whenEventsAreRead(folder), []);
});
