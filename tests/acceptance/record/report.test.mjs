import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsLines } from '../support/ktty.mjs';
import {
  exists,
  givenAWorkingBranch,
  givenFileContents,
  whenEventsAreRead,
  whenJsonIsRead,
} from '../support/project.mjs';
import {
  thenContains,
  thenOmits,
  thenTextMatches,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import { givenAConvergingChange, givenCoverage, givenMutation, whenVerifyRuns } from '../support/checks.mjs';
import {
  givenADeclaration,
  givenAVerification,
  givenUncoveredLine,
  historyDir,
  whenHistoryIsRead,
  whenPromptRuns,
  whenReportRuns,
} from '../support/history.mjs';

it("Before record, ktty report shows a preview that says it is a preview and links no event. [AC0049.1]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const before = whenHistoryIsRead(folder);

  const report = whenReportRuns(folder);
  thenItExits(report, 0);
  thenItPrintsLines(report, [
    'Change report preview. No `record` decision exists for this tree.', '',
    'prediction: exact · protected files: 0 · risk: LOW',
    'AC scenarios: 0 added, 0 reworded, 0 retired',
    'tests: 0 added, 0 modified, 0 removed',
    'follow-ups +0 −0 · code +1 −1 lines', 'not checked: coverage, mutation', '',
    'No logbook event was recorded.',
  ]);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("After a decision, ktty report shows the summary kept with it, and its link. [AC0049.2]", () => {
  const folder = givenAWorkingBranch();
  givenUncoveredLine(folder);
  givenAVerification(folder);
  for (const [event, heading] of [['record_held', 'Change held'], ['declared', 'Change declared']]) {
    const decision = whenPromptRuns(folder, 'record');
    thenHookReplies(decision, 0);
    const entry = whenEventsAreRead(folder).at(-1);
    thenValueIs(entry.event, event);
    const saved = whenJsonIsRead(folder, entry.payload.changeReportSnapshot);
    const before = whenHistoryIsRead(folder);
    const link = historyDir + '/' + String(entry.seq).padStart(4, '0') + '__' + event + '.json';

    const report = whenReportRuns(folder);
    thenItExits(report, 0);
    thenItPrintsLines(report, [
      heading + ' on this tree. This is the report recorded with that decision.', '',
      ...saved.summary, '', 'Details: ' + link,
    ]);
    const after = whenHistoryIsRead(folder);
    thenValuesEqual(after, before);
  }
});

it("A kept report that no longer reads is named, and a preview is shown instead. [AC0049.3]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  const path = declaration.payload.changeReportSnapshot;
  givenFileContents(folder, path, '{}');
  const before = whenHistoryIsRead(folder);

  const report = whenReportRuns(folder);
  thenItExits(report, 0);
  thenTextMatches(report.stdout, /^Change report preview\./);
  thenContains(report.stdout, '- recorded change report: declared 4 ' + path + ': SHA-256 digest mismatch');
  thenOmits(report.stdout, 'Details:');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("A pass that came from a rerun is named on the summary's last line. [AC0049.4]", () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);
  const pass = whenVerifyRuns(folder, ['--rerun']);
  thenItExits(pass, 0);
  const before = whenHistoryIsRead(folder);

  const report = whenReportRuns(folder);
  thenItExits(report, 0);
  const lines = report.stdout.trimEnd().split('\n');
  thenValueIs(lines.at(-3), 'verified by a rerun · not checked: coverage, mutation');
  thenValuesEqual(lines.slice(-2), ['', 'No logbook event was recorded.']);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("Once the tree moves past its verification, coverage and mutation are reported as missing. [AC0049.5]", () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenMutation(folder);
  givenAVerification(folder);
  const current = whenReportRuns(folder);
  thenContains(current.stdout, 'change coverage 100%');
  thenContains(current.stdout, 'mutants: 1 caught, 0 survived');
  givenFileContents(folder, 'tests/add.sh', 'exit 0\n');
  const before = whenHistoryIsRead(folder);

  const report = whenReportRuns(folder);
  thenItExits(report, 0);
  thenTextMatches(report.stdout, /- coverage:[^\n]*no verification for the current tree/i);
  thenTextMatches(report.stdout, /- mutation:[^\n]*no verification for the current tree/i);
  thenOmits(report.stdout, 'change coverage 100%');
  thenOmits(report.stdout, 'mutants: 1 caught');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});
