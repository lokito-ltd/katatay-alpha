import { it } from 'vitest';
import { thenItExits, thenItPrintsLines, whenKttyRuns } from '../support/ktty.mjs';
import {
  givenAWorkingBranch, givenFileContents, givenRulebookChanges, givenTheTargetHolds, rulebookPath,
} from '../support/project.mjs';
import { thenValueIs } from '../support/assertions.mjs';
import { givenACheck, givenCoverage } from '../support/checks.mjs';
import { givenAnApproval } from '../support/history.mjs';
import { givenARequirement } from '../support/requirements.mjs';

const whenAreasRun = (folder, args = []) => whenKttyRuns(['areas', ...args], { in: folder });

// The rulebook's high-risk list, published with the project so it is part of
// the baseline and not itself a change.
function givenHighRiskAreas(folder, highRisk) {
  givenRulebookChanges(folder, book => { book.highRisk = highRisk; });
  givenTheTargetHolds(folder, 'High-risk areas');
}

it("A changed file in a high-risk area is listed under that area's reason, in the rulebook's order. [AC0064.1]", () => {
  const folder = givenAWorkingBranch();
  givenHighRiskAreas(folder, [
    { paths: ['package.json'], why: 'Manifests run install scripts.' },
    { paths: ['ci/**'], why: 'CI configuration does the checking.' },
  ]);
  givenAnApproval(folder);
  givenFileContents(folder, 'ci/build.yml', 'steps: []\n');
  givenFileContents(folder, 'package.json', '{}\n');

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'Must look:',
    '  Manifests run install scripts.',
    '  - package.json',
    '  CI configuration does the checking.',
    '  - ci/build.yml',
  ]);
});

it('A file that only resembles a listed path is not listed. [AC0064.2]', () => {
  const folder = givenAWorkingBranch();
  givenHighRiskAreas(folder, [
    { paths: ['package.json'], why: 'Manifests run install scripts.' },
    { paths: ['ci/**'], why: 'CI configuration does the checking.' },
  ]);
  givenAnApproval(folder);
  givenFileContents(folder, 'cix/build.yml', 'steps: []\n');
  givenFileContents(folder, 'src/ci/build.yml', 'steps: []\n');
  givenFileContents(folder, 'package.json.bak', '{}\n');
  givenFileContents(folder, 'src/package.json', '{}\n');

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenValueIs(run.stdout, '');
  thenValueIs(run.stderr, '');
});

it('A changed rulebook is listed even when the high-risk list is empty. [AC0064.3]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenRulebookChanges(folder, book => { book.tests.run.tagComment = '^# '; });

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'Must look:',
    '  The rulebook. A floor, a list or a limit changed here changes what',
    '  passes, with no test written.',
    '  - ' + rulebookPath,
  ]);
});

it('An existing requirement the change edits is listed, and a requirement the change adds is not. [AC0064.4]', () => {
  const folder = givenAWorkingBranch();
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', { statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] });
  givenTheTargetHolds(folder, 'Catalogue');
  givenAnApproval(folder);
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', { statement: 'Orders can be cancelled before they ship.', scenarios: ['[AC0001.1] Cancelled.'] });
  givenARequirement(folder, 'acceptance/AC0002__refund.md', { statement: 'Cancelled orders are refunded.', scenarios: ['[AC0002.1] Refunded.'] });

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'Must look:',
    '  Agreed requirements. Check that no promise was taken away.',
    '  - requirements/acceptance/AC0001__cancel.md',
  ]);
});

it('The workflow logbook is listed only when a high-risk entry in the rulebook matches it. [AC0064.5]', () => {
  const unmatched = givenAWorkingBranch();
  givenHighRiskAreas(unmatched, [{ paths: ['ci/**'], why: 'CI configuration does the checking.' }]);
  givenAnApproval(unmatched);
  givenFileContents(unmatched, 'ci/build.yml', 'steps: []\n');
  const triage = whenKttyRuns(['triage'], { in: unmatched });
  thenItExits(triage, 0);

  const plain = whenAreasRun(unmatched);

  thenItExits(plain, 0);
  thenItPrintsLines(plain, [
    'Must look:',
    '  CI configuration does the checking.',
    '  - ci/build.yml',
  ]);

  const matched = givenAWorkingBranch();
  givenHighRiskAreas(matched, [{ paths: ['.katatay/**'], why: 'The workflow folder decides what passes.' }]);
  givenAnApproval(matched);
  givenFileContents(matched, 'ci/build.yml', 'steps: []\n');
  const matchedTriage = whenKttyRuns(['triage'], { in: matched });
  thenItExits(matchedTriage, 0);

  const listed = whenAreasRun(matched);

  thenItExits(listed, 0);
  thenItPrintsLines(listed, [
    'Must look:',
    '  The workflow folder decides what passes.',
    '  - .katatay/state/work/0001__plan_approved.json',
    '  - .katatay/state/work/0002__triaged.json',
  ]);
});

it("A file that gains a coverage-ignore comment, or a check's suppression comment, is listed under its own reason. [AC0064.6]", () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenRulebookChanges(folder, book => { book.checks.testQuality.coverage.suppressions = ['coverage-ignore']; });
  givenACheck(folder, 'codeQuality', 'lint', { suppressions: ['lint-disable'] });
  givenTheTargetHolds(folder, 'Checks');
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', '# coverage-ignore next\necho 4\n');
  givenFileContents(folder, 'src/other.sh', '# lint-disable\necho 5\n');

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'Must look:',
    '  New coverage ignore comments. Each takes code out of the figure.',
    '  - src/add.sh',
    '  New suppressions of the lint check. Each silences it where it sits.',
    '  - src/other.sh',
  ]);
});

it('It prints nothing when there is nothing to look at. [AC0064.7]', () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');

  const run = whenAreasRun(folder);

  thenItExits(run, 0);
  thenValueIs(run.stdout, '');
  thenValueIs(run.stderr, '');
});
