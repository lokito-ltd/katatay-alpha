import { it } from 'vitest';
import { thenItExits, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, givenRulebookChanges, givenTheTargetHolds } from '../support/project.mjs';
import { givenACheck, givenACheckAnswers, givenCoverage, givenMutation, whenCheckStartsAreRead, whenVerifyRuns } from '../support/checks.mjs';
import { thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const ownSteps = [
  'req:lint — catalogue OK',
  'req:guard — no protected requirement was changed without approval',
  'state: no logs yet',
  'compile — not checked: compile (the adapter says "none" in .katatay/rulebook.json)',
  'tests — 1 ran, none failed',
  'req:trace — every active requirement has evidence',
];

it('An exit code the rulebook lists is read as what the rulebook says, ranges included. [AC0034.1]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'range', { exitCodes: { 0: 'clean', '1-9': 'findings', 10: 'broken' }, onFailure: 'report' });
  givenACheckAnswers(folder, 'range', { exit: 3, text: 'three findings\n' });

  const findings = whenVerifyRuns(folder);

  thenItExits(findings, 0);
  thenValueIs(findings.stdout.includes('range — findings (exit 3); it reports only, so verify goes on\n'), true);

  givenACheckAnswers(folder, 'range', { exit: 10, text: 'tool crashed\n' });

  const broken = whenVerifyRuns(folder);

  thenItExits(broken, 1);
  thenValueIs(broken.stderr, 'tool crashed\nrange — broke: exited 10, which its exit codes say means broken\n\nverify: failed at range.\n');

  givenACheckAnswers(folder, 'range', { exit: 0 });

  const clean = whenVerifyRuns(folder);

  thenItExits(clean, 0);
  thenValueIs(clean.stdout.includes('\nrange — clean\n'), true);
});

it('An exit code the rulebook does not list is broken, and the message names where to list it. [AC0034.2]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'unlisted', { onFailure: 'report' });
  givenACheckAnswers(folder, 'unlisted', { exit: 7, text: 'odd\n' });

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenValueIs(run.stdout, ownSteps.join('\n') + '\n');
  thenValueIs(run.stderr, 'odd\nunlisted — broke: exited 7, which "checks.codeQuality.unlisted.exitCodes" does not list\n\nverify: failed at unlisted.\n');
});

it('A run stopped by a signal or past its time limit is broken. [AC0034.3]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'killed', { command: 'kill -TERM $$' });

  const signalled = whenVerifyRuns(folder);

  thenItExits(signalled, 1);
  thenValueIs(signalled.stderr, 'killed — broke: stopped by SIGTERM\n\nverify: failed at killed.\n');

  givenRulebookChanges(folder, book => {
    delete book.checks.codeQuality.killed;
    book.checks.codeQuality.slow = { command: 'sleep 5', exitCodes: { 0: 'clean', 1: 'findings' }, timeLimitSeconds: 1 };
  });

  const overrun = whenVerifyRuns(folder);

  thenItExits(overrun, 1);
  thenValueIs(overrun.stderr, 'slow — broke: still running after 1 seconds, so it was stopped\n\nverify: failed at slow.\n');
});

it('A command that names the changed files is skipped when no file changed, and verify passes. [AC0034.4]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'changed', { command: 'echo changed >> reports/check-starts; echo {changedFiles}' });
  givenTheTargetHolds(folder);

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    ...ownSteps,
    'changed — skipped: no file changed since the baseline',
    '',
    'verify: every step passed (req:lint, req:guard, state:verify, compile, tests, req:trace, changed).',
    'verify: not checked: coverage (checks.testQuality.coverage is "none")',
    'verify: not checked: mutation (checks.testQuality.mutation is "none")',
    'verify: not checked: compile (the adapter says "none" in .katatay/rulebook.json)',
  ]);
  thenValuesEqual(whenCheckStartsAreRead(folder), []);
});

it("Verify runs compile, tests, coverage and mutation first, then the test-quality checks, then the code-quality checks, whatever the rulebook's order. [AC0034.5]", () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint');
  givenACheck(folder, 'testQuality', 'smell');
  givenMutation(folder);
  givenCoverage(folder);
  givenRulebookChanges(folder, book => {
    const { mutation, smell, coverage } = book.checks.testQuality;
    book.checks = { requireAnalysis: false, codeQuality: book.checks.codeQuality, testQuality: { smell, mutation, coverage } };
    book.code.compile = {
      command: 'echo compile >> reports/check-starts', pattern: '^(?<file>\\S+): (?<message>.*)$', exitCodes: { 0: 'clean', 1: 'errors' },
    };
    book.tests.run.command = 'mkdir -p reports && echo tests >> reports/check-starts && ' + book.tests.run.command;
  });
  givenACheckAnswers(folder, 'lint', { exit: 0 });
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['compile', 'tests', 'coverage', 'mutation', 'smell', 'lint']);
});
