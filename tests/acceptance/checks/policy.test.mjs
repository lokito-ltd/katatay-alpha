import { it } from 'vitest';
import { thenItExits, thenItPrintsError } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, whenFileIsRead, whenGitRuns } from '../support/project.mjs';
import { givenACheck, givenACheckAnswers, whenCheckStartsAreRead, whenVerifyRuns } from '../support/checks.mjs';
import { thenContains, thenOmits, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

it('Verify fails at the first blocking check that finds something. [AC0035.1]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'first');
  givenACheck(folder, 'codeQuality', 'second');
  givenACheckAnswers(folder, 'first', { exit: 1, text: 'src/add.sh:1 finding\n' });
  givenACheckAnswers(folder, 'second', { exit: 1, text: 'another finding\n' });

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenValueIs(run.stderr, 'src/add.sh:1 finding\nfirst — findings (exit 1)\n\nverify: failed at first.\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['first']);
});

it('Verify goes past a check that only reports, and prints what it found. [AC0035.2]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint', { onFailure: 'report' });
  givenACheck(folder, 'codeQuality', 'after');
  givenACheckAnswers(folder, 'lint', { exit: 1, text: 'src/add.sh:1 style\n' });

  const run = whenVerifyRuns(folder);

  thenItExits(run, 0);
  thenContains(run.stdout, 'src/add.sh:1 style\nlint — findings (exit 1); it reports only, so verify goes on\n');
  thenContains(run.stdout, 'verify: every step passed (req:lint, req:guard, state:verify, compile, tests, req:trace, lint, after).');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['lint', 'after']);
});

it('A reporting check that broke fails verify. [AC0035.3]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint', { onFailure: 'report' });
  givenACheck(folder, 'codeQuality', 'after');
  givenACheckAnswers(folder, 'lint', { exit: 2, text: 'cannot parse config\n' });

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenValueIs(run.stderr, 'cannot parse config\nlint — broke: exited 2, which "checks.codeQuality.lint.exitCodes" does not list\n\nverify: failed at lint.\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['lint']);
});

it('A check that cannot be set up refuses verify, and none of its commands run. [AC0035.4]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'tracked', { output: 'tracked.json' });
  givenFileContents(folder, 'tracked.json', '{}\n');
  whenGitRuns(folder, 'add', 'tracked.json');
  whenGitRuns(folder, 'commit', '-qm', 'Track the output');

  const run = whenVerifyRuns(folder);

  thenItExits(run, 1);
  thenValueIs(run.stderr, 'verify: refused — check output tracked.json: git tracks this file; output must be ignored and untracked\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), []);
});

it('Under CI=true a skipInCi check is skipped, says so, and its output is left alone; outside CI it runs. [AC0035.5]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint', { skipInCi: true, output: 'reports/lint.json' });
  givenFileContents(folder, 'reports/lint.json', 'left from before\n');

  const inCi = whenVerifyRuns(folder, [], { CI: 'true' });

  thenItExits(inCi, 0);
  thenContains(inCi.stdout, '\nlint — skipped in CI (skipInCi: true)\n');
  thenValueIs(whenFileIsRead(folder, 'reports/lint.json'), 'left from before\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), []);

  const local = whenVerifyRuns(folder);

  thenItExits(local, 0);
  thenContains(local.stdout, '\nlint — clean\n');
  thenOmits(local.stdout, 'skipped in CI');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['lint']);
});

it('Only CI set to exactly true counts as CI. [AC0035.6]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'lint', { skipInCi: true });

  for (const value of ['1', 'TRUE', 'yes', '']) {
    const run = whenVerifyRuns(folder, [], { CI: value });

    thenItExits(run, 0);
    thenContains(run.stdout, '\nlint — clean\n', 'CI=' + value);
  }

  thenValuesEqual(whenCheckStartsAreRead(folder), ['lint', 'lint', 'lint', 'lint']);
});
