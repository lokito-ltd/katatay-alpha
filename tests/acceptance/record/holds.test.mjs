import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  givenAChangeFile,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  messages,
  whenEventsAreRead,
  whenFileIsRead,
  whenFileIsRemoved,
  whenJsonIsRead,
  whenStateIsShown,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenObjectIncludes,
  thenStateShowsPhase,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import {
  givenCoverage,
  givenMutation,
  givenTheMutationAnswer,
  mutationReport,
  whenChecksAnalysisIsSubmitted,
} from '../support/checks.mjs';
import {
  changeFile,
  givenADeclaration,
  givenAVerification,
  givenUncoveredLine,
  whenHistoryIsRead,
  whenPromptRuns,
} from '../support/history.mjs';

it("A report with no gaps declares at once. [AC0046.1]", () => {
  const folder = givenAWorkingBranch();
  givenCoverage(folder);
  givenAVerification(folder);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'declared', for: 'operator' });
  thenContains(answer.messages[0].text, 'Change declared. The report found no gaps.');
  const declaration = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(declaration.payload.gaps, { uncoveredLines: 0 });
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);
});

it("A change whose gaps nobody acted on is held, and the hold points back to verify. [AC0046.2]", () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = true; });
  givenUncoveredLine(folder);
  givenAVerification(folder);
  const analysis = [
    'Summary: Assert the changed calculation.',
    'Coverage src/add.sh:1', 'Scenario: Run the calculation.', 'Assert: The output is four.',
    'Limit mutation [skipped]', 'Impact: Mutation was not measured.',
    'Limit compile [skipped]', 'Impact: Nothing was compiled.',
  ].join('\n');
  const submission = whenChecksAnalysisIsSubmitted(folder, ['3'], analysis);
  thenItExits(submission, 0);

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'held', for: 'operator' });
  thenContains(answer.messages[0].text, 'Change held: 1 touched line no test runs.');
  thenContains(answer.messages[0].text, 'verification 3');
  thenContains(answer.messages[0].text, 'Assert the changed calculation.');
  thenContains(answer.messages[0].text, 'Type `record` again');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'checks_analysis', 'record_held']);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'verified');
});

it("A second record on the same tree declares and keeps the accepted gaps. [AC0046.3]", () => {
  const folder = givenAWorkingBranch();
  givenUncoveredLine(folder);
  givenAVerification(folder);

  const first = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(first, 0).messages[0].code, 'held');
  const hold = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(hold.payload.gaps, { uncoveredLines: 1 });

  const second = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(second, 0);
  thenObjectIncludes(answer.messages[0], { code: 'declared', for: 'operator' });
  thenContains(answer.messages[0].text, 'You typed `record` again on the same tree, so you accept the gaps it shows.');
  const declaration = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(declaration.payload.gaps, hold.payload.gaps);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'record_held', 'declared']);
});

it("A test edit and a new pass after the gaps count as acting on them, so the first record declares. [AC0046.4]", () => {
  const folder = givenAWorkingBranch();
  givenUncoveredLine(folder);
  givenAVerification(folder);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 && test "$(sh src/add.sh | wc -l)" -eq 1\n');
  const pass = whenTurnEnds(folder);
  const verified = thenHookReplies(pass, 0);
  thenValueIs(verified.messages[0].code, 'verified');

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenValueIs(answer.messages[0].code, 'declared');
  thenContains(answer.messages[0].text, 'Tests changed since the verification before, so the gaps do not hold it.');
  const declaration = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(declaration.payload.gaps, { uncoveredLines: 1 });
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'verified', 'declared']);
});

it("Unproved mutants alone hold the first record, with the same counts when accepted. [AC0046.5]", () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  const report = mutationReport(['NoCoverage', 'Pending', 'Survived']);
  for (const mutant of report.files['src/add.sh'].mutants) mutant.testsCompleted = 0;
  givenTheMutationAnswer(folder, { exit: 2, text: 'partial run', report });
  givenAVerification(folder);

  const first = whenPromptRuns(folder, 'record');
  const held = thenHookReplies(first, 0);
  thenValueIs(held.messages[0].code, 'held');
  thenContains(held.messages[0].text, 'Change held: 3 mutants no test caught.');
  const hold = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(hold.payload.gaps, { uncaughtMutants: 3 });
  const saved = whenJsonIsRead(folder, hold.payload.changeReportSnapshot);
  thenContains(saved.lines, '  Unproved mutants: 1 reached by no test, 1 pending, 1 with no completed tests.');

  const second = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(second, 0).messages[0].code, 'declared');
  const declaration = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(declaration.payload.gaps, { uncaughtMutants: 3 });
  const accepted = whenJsonIsRead(folder, declaration.payload.changeReportSnapshot);
  thenValuesEqual(accepted.gaps, saved.gaps);
});

it("A report with missing or unreadable required evidence stops every record, after a hold too. [AC0046.6]", () => {
  const folder = givenAWorkingBranch();
  givenUncoveredLine(folder);
  givenAVerification(folder);
  const triage = whenEventsAreRead(folder)[1];
  const path = triage.payload.evidence.find(item => item.role === 'analysis').snapshot;
  const original = whenFileIsRead(folder, path);
  for (const held of [false, true]) {
    if (held) {
      const first = whenPromptRuns(folder, 'record');
      thenValueIs(thenHookReplies(first, 0).messages[0].code, 'held');
    }
    const before = whenHistoryIsRead(folder);
    whenFileIsRemoved(folder, path);
    for (const damage of ['missing', 'unreadable']) {
      if (damage === 'unreadable') givenFileContents(folder, path, '{');
      const record = whenPromptRuns(folder, 'record');
      const answer = thenHookReplies(record, 0);
      thenValueIs(answer.messages[0].code, 'not_declared');
      thenContains(answer.messages[0].text, path);
      const after = whenHistoryIsRead(folder);
      thenValuesEqual(after, before);
    }
    givenFileContents(folder, path, original);
  }
  const retry = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(retry, 0).messages[0].code, 'declared');
});

it("record on a declared or recorded tree adds no event and repeats the handoff. [AC0046.7]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  for (const phase of ['declared', 'recorded']) {
    if (phase === 'recorded') {
      givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
      const turn = whenTurnEnds(folder);
      thenValueIs(thenHookReplies(turn, 0).messages[0].code, 'recorded');
    }
    const before = whenHistoryIsRead(folder);

    const repeat = whenPromptRuns(folder, 'record');
    const answer = thenHookReplies(repeat, 0);
    thenValueIs(answer.messages[0].code, phase);
    thenContains(answer.messages[0].text, 'Nothing new was declared');
    thenContains(answer.messages[0].text, declaration.payload.summary.join('\n'));
    thenContains(answer.messages[0].text, 'Details: .katatay/state/work/0004__declared.json');
    thenContains(answer.messages[0].text, phase === 'declared' ? 'Write the change file now' : 'Write the commit message now');
    const after = whenHistoryIsRead(folder);
    thenValuesEqual(after, before);
  }
});
