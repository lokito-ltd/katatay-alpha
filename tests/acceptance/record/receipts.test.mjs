import { it } from 'vitest';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  messages,
  whenFileIsRead,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenObjectIncludes,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import { givenAConvergingChange } from '../support/checks.mjs';
import {
  givenAVerification,
  givenCorruptApproval,
  whenHistoryIsRead,
  whenPromptRuns,
} from '../support/history.mjs';
import { givenAReportBarrier, whenRecordingDuring } from '../support/during-report.mjs';

it("record before verification is refused, and the agent is told why. [AC0045.1]", () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);
  const before = whenHistoryIsRead(folder);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'not_declared', for: 'operator' });
  thenContains(messages(answer), 'change is converging');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("record on a broken logbook is refused, and nothing is recorded. [AC0045.2]", () => {
  const folder = givenAWorkingBranch();
  givenCorruptApproval(folder);
  const before = whenHistoryIsRead(folder);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'stop', for: 'operator' });
  thenContains(messages(answer), 'Refused to record `record`: the state chain is broken');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("Implementation drift from the latest verified receipt is named. [AC0045.3]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 9\n');
  const before = whenHistoryIsRead(folder);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'not_declared', for: 'operator' });
  thenContains(messages(answer), 'Restore the triaged implementation');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("A newer receipt that supersedes the one the report was built from requires another record. [AC0045.4]", async () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const original = whenFileIsRead(folder, 'tests/add.sh');
  const barrier = givenAReportBarrier(folder);

  const record = await whenRecordingDuring(folder, barrier, () => {
    // Verify an edit and restore and verify the original bytes. Record must
    // notice the newer receipt even though every fingerprint matches again.
    for (const contents of [original + '# another pass\n', original]) {
      givenFileContents(folder, 'tests/add.sh', contents);
      const turn = whenTurnEnds(folder);
      const pass = thenHookReplies(turn, 0);
      thenContains(pass.messages.map(message => message.code), 'verified');
    }
  });
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'not_declared', for: 'operator' });
  thenContains(messages(answer), 'verification changed while the report ran. Type `record` again');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'verified', 'verified']);

  const retry = whenPromptRuns(folder, 'record');
  const retried = thenHookReplies(retry, 0);
  thenValueIs(retried.messages[0].code, 'declared');
});

it("No declaration is made if the tests change while the report runs. [AC0045.5]", async () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const barrier = givenAReportBarrier(folder);
  const before = whenHistoryIsRead(folder);

  const record = await whenRecordingDuring(folder, barrier, () => {
    givenFileContents(folder, 'tests/add.sh', 'exit 1\n');
  });
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'not_declared', for: 'operator' });
  thenContains(messages(answer), 'Verify the edited tests before recording');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("With the analysis switch on, record before the analysis is submitted asks for it, and neither declares nor holds. [AC0045.6]", () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = true; });
  givenAVerification(folder);
  const before = whenHistoryIsRead(folder);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'not_declared', for: 'operator' });
  thenContains(messages(answer), 'Verification 3 needs its checks analysis. This attempt was not a hold or declaration.');
  thenContains(messages(answer), 'checks-analysis');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});
