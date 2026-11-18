import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  completePlan,
  givenAChangeFile,
  givenAWorkingBranch,
  givenAnEventIsAppended,
  givenFileContents,
  givenTheTargetHolds,
  messages,
  planFile,
  whenAWriteIsProposed,
  whenEventsAreRead,
  whenFileIsRead,
  whenFileIsRemoved,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenFileContains,
  thenHookAnswers,
  thenObjectIncludes,
  thenOmits,
  thenStateShowsPhase,
  thenTextDoesNotMatch,
  thenTextMatches,
  thenValueDiffers,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import {
  approvalFile,
  changeFile,
  givenADeclaration,
  givenARecording,
  givenAVerification,
  givenAnApproval,
  whenCommitted,
  whenHistoryIsRead,
  whenPromptRuns,
} from '../support/history.mjs';

it("reset typed as the whole message moves the phase to open and appends a reset event after the others. [AC0056.1]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const before = whenHistoryIsRead(folder);

  const reset = whenPromptRuns(folder, 'reset');
  const answer = thenHookReplies(reset, 0);
  thenObjectIncludes(answer.messages[0], { code: 'reset', for: 'agent' });
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'reset']);
  const { ['0004__reset.json']: appended, ...retained } = whenHistoryIsRead(folder);
  thenValuesEqual(retained, before);
  thenValuesEqual(JSON.parse(appended).payload, { note: null });
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'open');
});

it("A sentence that mentions resetting is not a reset. [AC0056.2]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const before = whenHistoryIsRead(folder);

  const prompt = whenPromptRuns(folder, 'should we reset this?');
  thenHookReplies(prompt, 0);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'implementing');
});

it("A reset lists the branch's change files and tells the operator they stay on the branch but no longer count. [AC0056.3]", () => {
  const folder = givenAWorkingBranch();
  givenARecording(folder);
  const original = whenFileIsRead(folder, changeFile);

  const reset = whenPromptRuns(folder, 'reset');
  const answer = thenHookReplies(reset, 0);
  const note = answer.messages.find(message => message.for === 'operator' && message.text.includes(changeFile));
  thenContains(note.text, 'They no longer count for the change, but they stay on the branch');
  const event = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(event.payload.changeFiles, [changeFile]);
  thenFileContains(folder, changeFile, original);
  const next = givenADeclaration(folder);
  const second = 'requirements/changes/20261114T000000.000Z__second.md';
  givenAChangeFile(folder, second, 'Second', next.payload.summary);
  const turn = whenTurnEnds(folder);
  thenHookReplies(turn, 0);
  const recorded = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(recorded.payload.files, [second]);
});

it("Approvals, triages and receipts from before a reset grant nothing afterwards. [AC0056.4]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const reset = whenPromptRuns(folder, 'reset');
  thenHookReplies(reset, 0);
  const history = whenHistoryIsRead(folder);

  const write = whenAWriteIsProposed(folder, ['src/add.sh']);
  thenHookAnswers(write, { allow: false });
  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenValueIs(answer.messages[0].code, 'not_declared');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, history);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'open');
  thenTextDoesNotMatch(shown.stdout, /^(permitted|triage|declared) /m);
});

it("After a reset, the same plan bytes get a fresh approval. [AC0056.5]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const [first] = whenEventsAreRead(folder);
  const reset = whenPromptRuns(folder, 'reset');
  thenHookReplies(reset, 0);

  const approval = whenPlanIsApproved(folder);
  thenHookAnswers(approval, { recorded: true });
  thenEventNamesEqual(folder, ['plan_approved', 'reset', 'plan_approved']);
  const latest = whenEventsAreRead(folder).at(-1);
  thenValueIs(latest.payload.proposal, first.payload.proposal);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'implementing');
});

it("A reset into a logbook whose committed events were edited is refused and records nothing. [AC0056.6]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  givenFileContents(folder, approvalFile, whenFileIsRead(folder, approvalFile) + '\n');
  const before = whenHistoryIsRead(folder);

  const reset = whenPromptRuns(folder, 'reset');
  const reply = thenHookReplies(reset, 0);
  thenObjectIncludes(reply.messages[0], { code: 'stop', for: 'operator' });
  thenContains(messages(reply), 'committed as history');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("A reset mends a logbook broken only by a missing recorded change file. [AC0056.7]", () => {
  const folder = givenAWorkingBranch();
  givenARecording(folder);
  whenFileIsRemoved(folder, changeFile);
  const broken = whenStateIsShown(folder);
  thenItExits(broken, 1);
  thenContains(broken.stdout, changeFile + ': named by');

  const reset = whenPromptRuns(folder, 'reset');
  const answer = thenHookReplies(reset, 0);
  thenValueIs(answer.messages[0].code, 'reset');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared', 'recorded', 'reset']);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'open');
});

it("Once the target holds the whole logbook, the phase is open and edits are denied. [AC0057.1]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenTheTargetHolds(folder);

  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'open');
  const write = whenAWriteIsProposed(folder, ['src/add.sh']);
  thenHookAnswers(write, { allow: false, messages: [{ code: 'needs_plan' }] });
});

it("A recorded change whose logbook is committed but not yet merged stays recorded, and one more edit sends it to converging. [AC0057.2]", () => {
  const folder = givenAWorkingBranch();
  givenARecording(folder);
  whenCommitted(folder, 'Save recorded change');

  const committed = whenStateIsShown(folder);
  thenStateShowsPhase(committed, 'recorded');
  givenFileContents(folder, 'src/extra.sh', 'echo more\n');
  const edited = whenStateIsShown(folder);
  thenStateShowsPhase(edited, 'converging');
});

it("A second plan on a branch whose change is recorded is refused, and the operator is told to merge first or reset. [AC0057.3]", () => {
  const folder = givenAWorkingBranch();
  givenARecording(folder);
  givenFileContents(folder, planFile, completePlan + '\nNext change.\n');
  const before = whenHistoryIsRead(folder);

  const approval = whenPlanIsApproved(folder);
  const answer = thenHookAnswers(approval, { recorded: false });
  thenContains(messages(answer), 'already holds a recorded change');
  thenTextMatches(messages(answer), /[Mm]erge[^.]*or[^.]*reset/);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("A merged change's committed events do not count as the new change's events being committed. [AC0057.4]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenTheTargetHolds(folder);
  const merged = whenStateIsShown(folder);
  thenContains(merged.stdout, "nothing of this change's to commit yet");
  thenOmits(merged.stdout, 'WARNING');

  givenAnApproval(folder);
  const newChange = whenStateIsShown(folder);
  thenContains(newChange.stdout, 'saved      not committed yet');
  thenContains(newChange.stdout, 'this change has 1 event(s) in the logbook and none are committed yet');

  whenCommitted(folder, 'Save next approval');
  const saved = whenStateIsShown(folder);
  thenContains(saved.stdout, 'saved      committed at');
  thenOmits(saved.stdout, 'WARNING');
});

it("An approval appended after recorded grants nothing. [AC0057.5]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const [earlier] = whenEventsAreRead(folder);
  givenFileContents(folder, planFile, completePlan + '\nCurrent change.\n');
  givenARecording(folder);
  const current = whenEventsAreRead(folder)[1];
  givenAnEventIsAppended(folder, 'plan_approved', earlier.payload);

  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'recorded');
  thenContains(shown.stdout, current.payload.planSnapshot);
  thenOmits(shown.stdout, earlier.payload.planSnapshot);
  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenValueIs(answer.messages[0].code, 'recorded');
  thenEventNamesEqual(folder, ['plan_approved', 'plan_approved', 'triaged', 'verified', 'declared', 'recorded', 'plan_approved']);
});

it("After a merge, the same plan bytes get a fresh approval. [AC0057.6]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const [first] = whenEventsAreRead(folder);
  givenTheTargetHolds(folder);

  const approval = whenPlanIsApproved(folder);
  thenHookAnswers(approval, { recorded: true });
  thenEventNamesEqual(folder, ['plan_approved', 'plan_approved']);
  const next = whenEventsAreRead(folder).at(-1);
  thenValueIs(next.payload.proposal, first.payload.proposal);
  thenValueDiffers(next.payload.baseline, first.payload.baseline);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'implementing');
});
