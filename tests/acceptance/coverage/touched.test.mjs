import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  exists,
  givenAWorkingBranch,
  givenFileContents,
  givenTheTargetHolds,
  whenFileIsRemoved,
  whenHookRuns,
  whenStateIsShown,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  codesOf,
  coverageOutput,
  givenAConvergingChange,
  givenCoverage,
  givenMutation,
  givenTheCoverageReport,
  givenTheMutationAnswer,
  lcov,
  mutationReport,
  textOf,
  whenCheckStartsAreRead,
  whenCoverageRuns,
} from '../support/checks.mjs';
import { thenContains, thenOmits, thenPathsExist, thenStateShowsPhase, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

it('A pass names the touched lines no test runs, before the mutation findings, and the phase is verified. [AC0040.1]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenMutation(folder);
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0, 2: 1 } }]));
  givenTheMutationAnswer(folder, { text: '1 mutant: 0 caught, 1 survived.', exit: 1, report: mutationReport(['Survived']) });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, false);
  thenContains(textOf(answer, 'verified'), 'Findings:\ncoverage: FINDINGS\n1 / 1 touched lines run by no test\nsrc/add.sh: 1\n\n'
    + 'mutation: FINDINGS\n1 survived · 0 killed · 1 mutants\nsrc/add.sh:1 ArithmeticOperator → 2 - 2\n');
  thenStateShowsPhase(whenStateIsShown(folder), 'verified');
});

it('Only lines added or changed since the baseline are listed, never old lines or tests. [AC0040.2]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 0, branches: 0 } });
  givenFileContents(folder, 'src/add.sh', 'a=2\nb=2\necho $((a + b))\n');
  givenTheTargetHolds(folder);
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0, 2: 0, 3: 0 } }]));
  givenAConvergingChange(folder, 'a=2\nb=1\necho $((a + b + 1))\n');
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # changed too\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'coverage: FINDINGS\n2 / 2 touched lines run by no test\nsrc/add.sh: 2-3\n');
  thenOmits(textOf(answer, 'verified'), 'tests/add.sh:');
});

it('Coverage is measured afresh on every pass. [AC0040.3]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 0, branches: 0 } });
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0 } }]));
  givenAConvergingChange(folder);

  const first = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(first, 'verified'), 'src/add.sh: 1\n');

  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 3 } }]));
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # covers it now\n');

  const second = thenHookReplies(whenTurnEnds(folder), 0);

  thenOmits(textOf(second, 'verified'), 'touched lines run by no test');
  thenContains(textOf(second, 'verified'), '\ncoverage: PASSED\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['coverage', 'coverage']);
});

it('Uncovered touched lines are read from the coverage snapshot the verification names, not from the working output file. [AC0040.4]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0, 2: 1 } }]));
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  whenFileIsRemoved(folder, coverageOutput);

  const record = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);

  thenValuesEqual(codesOf(record), ['held', 'state']);
  thenContains(textOf(record, 'held'), 'Change held: 1 touched line no test runs.\n');
  thenContains(textOf(record, 'held'), '\nchange coverage 0% (0 of 1 line)\n');
});

it('A broken coverage report fails verify. [AC0040.5]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenTheCoverageReport(folder, 'garbage\n');
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, true);
  thenValuesEqual(codesOf(answer), ['triaged', 'verify_failed', 'info']);
  thenContains(textOf(answer, 'verify_failed'), 'Failures:\ncoverage: FAILED\n');
  thenStateShowsPhase(whenStateIsShown(folder), 'converging');
});

it('With coverage switched off, the summary says coverage was not checked. [AC0040.6]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), '\ncoverage: SKIPPED — Disabled in the rulebook.\n');
  thenOmits(textOf(answer, 'verified'), 'coverage: PASSED');
});

it('ktty coverage run by hand saves no snapshot. [AC0040.7]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenAConvergingChange(folder);

  const run = whenCoverageRuns(folder);

  thenItExits(run, 0);
  thenValueIs(exists(folder, coverageOutput), true);
  thenPathsExist(folder, ['.katatay/local/work/coverage'], false);
});
