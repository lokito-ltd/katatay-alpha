import { it } from 'vitest';
import { thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, givenRulebookChanges } from '../support/project.mjs';
import { givenCoverage, givenTheCoverageReport, lcov, whenCoverageRuns } from '../support/checks.mjs';

const failed = 'coverage: coverage minimums or measured files failed';

it('A report below the minimum exits 1, naming the folder, the figure and the minimum. [AC0038.1]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 70, branches: 50 } });
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 1, 2: 0, 3: 1 } }]));

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/  lines  66.6% (minimum 70.0%)  branches 100.0% (minimum 50.0%)',
    'FAILED — src/: line coverage is 66.6%, below the minimum of 70.0% (2 of 3 lines covered).',
    failed,
  ]);
});

it("A report at every folder's minimum exits 0 and shows each figure beside its minimum. [AC0038.2]", () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 50, branches: 50 } });
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 1, 2: 0 }, branches: [1, 0] }]));

  const run = whenCoverageRuns(folder);

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'coverage: src/  lines  50.0% (minimum 50.0%)  branches  50.0% (minimum 50.0%)',
    'coverage: every folder is at or above its minimum',
  ]);
});

it('A missing or unreadable report exits 1. [AC0038.3]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenTheCoverageReport(folder, '');

  const empty = whenCoverageRuns(folder);

  thenItExits(empty, 1);
  thenItPrintsError(empty, ['coverage: coverage could not be analysed: coverage command stdout: it names no file (no SF: record), so it measured nothing']);

  givenTheCoverageReport(folder, 'garbage\n');

  const unreadable = whenCoverageRuns(folder);

  thenItExits(unreadable, 1);
  thenItPrintsError(unreadable, ['coverage: coverage could not be analysed: coverage command stdout, line 1: "garbage" is not an lcov record, which is a tag, a colon and a value']);

  givenRulebookChanges(folder, book => { book.checks.testQuality.coverage.command = 'cat reports/answers/missing.info'; });

  const missing = whenCoverageRuns(folder);

  thenItExits(missing, 1);
  thenItPrintsError(missing, [
    'coverage: cat: reports/answers/missing.info: No such file or directory',
    'coverage: broke: coverage command exited 1',
  ]);
});

it('Figures are rounded down to one decimal place. [AC0038.4]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 66.7, branches: 50 } });
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 1, 2: 1, 3: 0 } }]));

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/  lines  66.6% (minimum 66.7%)  branches 100.0% (minimum 50.0%)',
    'FAILED — src/: line coverage is 66.6%, below the minimum of 66.7% (2 of 3 lines covered).',
    failed,
  ]);
});

it('A folder that has a minimum but no measured file fails. [AC0038.5]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/': { lines: 50, branches: 50 }, 'lib/': { lines: 50, branches: 50 } });

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/  lines 100.0% (minimum 50.0%)  branches 100.0% (minimum 50.0%)',
    "FAILED — lib/: no file under it was measured, so its minimum checks nothing. Either the folder is gone, or the coverage tool's settings no longer reach it.",
    failed,
  ]);
});

it('With no coverage entry it exits 1 and explains how to switch coverage off; with none it exits 0 and reports that choice. [AC0038.6]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { delete book.checks.testQuality.coverage; });

  const missing = whenCoverageRuns(folder);

  thenItExits(missing, 1);
  thenItPrintsError(missing, [`coverage: refused — .katatay/rulebook.json has no "checks.testQuality.coverage" entry. Set it to "none" to switch coverage off. The workflow refuses to run without it. The operator edits .katatay/rulebook.json; src/schemas/rulebook.schema.json, in the folder 'ktty path' prints, describes its shape.`]);

  givenRulebookChanges(folder, book => { book.checks.testQuality.coverage = 'none'; });

  const none = whenCoverageRuns(folder);

  thenItExits(none, 0);
  thenItPrintsLines(none, ['coverage: not checked: coverage (checks.testQuality.coverage is "none")']);
});

const leftOut = file => `FAILED — code, but not in the coverage report: ${file}. The coverage tool's settings took it out of what is measured, or the report is older than the file: verify writes a new one. Code is never left out of the figure.`;

it('A code file on disk that is missing from the report makes ktty coverage exit 1, naming the file. [AC0039.1]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenFileContents(folder, 'src/sub.sh', 'echo sub\n');

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/  lines 100.0% (minimum 50.0%)  branches 100.0% (minimum 50.0%)',
    leftOut('src/sub.sh'),
    failed,
  ]);
});

it('Every file under the top-level code folders is compared, not only files in folders with a minimum. [AC0039.2]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/core/': { lines: 50, branches: 50 } });
  givenFileContents(folder, 'src/core/a.sh', 'echo a\n');
  givenTheCoverageReport(folder, lcov([{ file: 'src/core/a.sh', lines: { 1: 1 } }]));

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/core/  lines 100.0% (minimum 50.0%)  branches 100.0% (minimum 50.0%)',
    leftOut('src/add.sh'),
    failed,
  ]);
});

it('A measured file under no folder with a minimum fails. [AC0039.3]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder, { 'src/core/': { lines: 50, branches: 50 } });
  givenFileContents(folder, 'src/core/a.sh', 'echo a\n');
  givenTheCoverageReport(folder, lcov([{ file: 'src/core/a.sh', lines: { 1: 1 } }, { file: 'src/add.sh', lines: { 1: 1 } }]));

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/core/  lines 100.0% (minimum 50.0%)  branches 100.0% (minimum 50.0%)',
    'FAILED — measured, but under no folder that has a minimum in .katatay/rulebook.json: src/add.sh. Give the folder a minimum there.',
    failed,
  ]);
});

it('The failure says the file was taken out of the report, or the report is older than the file. [AC0039.4]', () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenFileContents(folder, 'src/new.sh', 'echo new\n');

  const run = whenCoverageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'coverage: src/  lines 100.0% (minimum 50.0%)  branches 100.0% (minimum 50.0%)',
    "FAILED — code, but not in the coverage report: src/new.sh. The coverage tool's settings took it out of what is measured, or the report is older than the file: verify writes a new one. Code is never left out of the figure.",
    failed,
  ]);
});
