import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsLines, whenKttyRuns } from '../support/ktty.mjs';
import {
  givenAWorkingBranch, givenFileContents, givenRulebookChanges, givenTheTargetHolds, whenGitRuns, whenStateIsShown,
  whenTriageRuns, whenTurnEnds,
} from '../support/project.mjs';
import { thenContains, thenOmits, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import { givenAConvergingChange, givenCoverage, textOf } from '../support/checks.mjs';
import { givenAnApproval } from '../support/history.mjs';

const whenAreasRun = (folder, args = []) => whenKttyRuns(['areas', ...args], { in: folder });

function givenHighRiskAreas(folder, highRisk) {
  givenRulebookChanges(folder, book => { book.highRisk = highRisk; });
  givenTheTargetHolds(folder, 'High-risk areas');
}

it('The list appears when verification passes and again on the next verified turn. [AC0065.1]', () => {
  const folder = givenAWorkingBranch();
  givenHighRiskAreas(folder, [{ paths: ['ci/**'], why: 'CI configuration does the checking.' }]);
  givenFileContents(folder, 'ci/build.yml', 'steps: []\n');
  givenAConvergingChange(folder);
  const passing = whenTurnEnds(folder);
  const first = thenHookReplies(passing, 0);
  thenContains(textOf(first, 'verified'), 'Review:\nCI configuration does the checking.\n- ci/build.yml\n');

  const next = whenTurnEnds(folder);
  const again = thenHookReplies(next, 0);
  thenContains(textOf(again, 'verified'), 'Where review should look:\n  Must look:\n    CI configuration does the checking.\n    - ci/build.yml');
});

it('ktty state show shows the list once a triage is recorded, and not before. [AC0065.2]', () => {
  const folder = givenAWorkingBranch();
  givenHighRiskAreas(folder, [{ paths: ['ci/**'], why: 'CI configuration does the checking.' }]);
  givenAnApproval(folder);
  givenFileContents(folder, 'ci/build.yml', 'steps: []\n');

  const before = whenStateIsShown(folder);
  thenItExits(before, 0);
  thenOmits(before.stdout, 'Must look:');

  thenItExits(whenTriageRuns(folder), 0);
  const after = whenStateIsShown(folder);
  thenItExits(after, 0);
  thenContains(after.stdout, 'Must look:\n             CI configuration does the checking.\n             - ci/build.yml');
});

it('With --staged a file is listed only once it is staged. [AC0065.3]', () => {
  const folder = givenAWorkingBranch();
  givenHighRiskAreas(folder, [{ paths: ['ci/**'], why: 'CI configuration does the checking.' }]);
  givenAnApproval(folder);
  givenFileContents(folder, 'ci/build.yml', 'steps: []\n');

  const unstaged = whenAreasRun(folder, ['--staged']);
  thenItExits(unstaged, 0);
  thenValueIs(unstaged.stdout, '');

  whenGitRuns(folder, 'add', 'ci/build.yml');
  const staged = whenAreasRun(folder, ['--staged']);
  thenItExits(staged, 0);
  thenItPrintsLines(staged, ['Must look:', '  CI configuration does the checking.', '  - ci/build.yml']);
});

it('With --staged a comment that is only on disk and not staged is not listed. [AC0065.4]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenRulebookChanges(folder, book => { book.checks.testQuality.coverage.suppressions = ['coverage-ignore']; });
  givenTheTargetHolds(folder, 'Coverage');
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  whenGitRuns(folder, 'add', 'src/add.sh');
  givenFileContents(folder, 'src/add.sh', '# coverage-ignore next\necho $((2 + 2))\n');

  const onDisk = whenAreasRun(folder, ['--staged']);
  thenItExits(onDisk, 0);
  thenValueIs(onDisk.stdout, '');

  whenGitRuns(folder, 'add', 'src/add.sh');
  const staged = whenAreasRun(folder, ['--staged']);
  thenItExits(staged, 0);
  thenItPrintsLines(staged, ['Must look:', '  New coverage ignore comments. Each takes code out of the figure.', '  - src/add.sh']);
});

it('Every printed line fits a commit body of 72 columns. [AC0065.5]', () => {
  const folder = givenAWorkingBranch();
  const why = 'Continuous integration configuration decides which checks run on every pull request, '
    + 'so an edit here can quietly switch a check off for every change that follows it.';
  givenHighRiskAreas(folder, [{ paths: ['ci/**'], why }]);
  givenAnApproval(folder);
  givenFileContents(folder, 'ci/build.yml', 'steps: []\n');
  whenGitRuns(folder, 'add', 'ci/build.yml');

  for (const args of [[], ['--staged']]) {
    const run = whenAreasRun(folder, args);
    thenItExits(run, 0);
    const lines = run.stdout.trimEnd().split('\n');
    thenValuesEqual(lines.filter(line => line.length > 72), []);
    thenValueIs(lines.slice(1, -1).join(' ').replace(/\s+/g, ' ').trim(), why);
  }
});
