import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  answers,
  givenAChangeFile,
  givenAWorkingBranch,
  givenFileContents,
  messages,
  whenEventsAreRead,
  whenGitRuns,
  whenStateIsShown,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenHookAnswers,
  thenObjectIncludes,
  thenOmits,
  thenStateShowsPhase,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import {
  changeFile,
  givenADeclaration,
  givenARecording,
  givenAnApproval,
  whenCommitted,
  whenHistoryIsRead,
  whenStateIsChecked,
} from '../support/history.mjs';
import {
  givenAPublisher,
  whenCommitIsKnown,
  whenRemoteGoesOffline,
  whenRemoteReturns,
  whenTargetAdvances,
  whenTargetHistoryIsReplaced,
} from '../support/remote.mjs';

it("While the server does not answer, the change waits in declared, says why, and records once the server answers. [AC0052.1]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const remote = whenRemoteGoesOffline(folder);

  const waiting = whenTurnEnds(folder);
  const answer = thenHookAnswers(waiting, { keepWorking: false });
  thenObjectIncludes(answer.messages[0], { code: 'info', for: 'operator' });
  thenContains(answer.messages[0].text, 'server behind origin/main did not answer');
  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'declared');

  whenRemoteReturns(folder, remote);
  const retry = whenTurnEnds(folder);
  thenHookAnswers(retry, { messages: [{ code: 'recorded' }] });
  const after = whenStateIsShown(folder);
  thenStateShowsPhase(after, 'recorded');
});

it("A baseline not on the server's target is refused, naming it, and ktty state verify in CI fails it too. [AC0052.2]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const pinned = whenEventsAreRead(folder)[0].payload.baseline;
  whenTargetHistoryIsReplaced(folder);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: true });
  thenContains(messages(answer), 'baselines are not on origin/main as the server has it');
  thenContains(messages(answer), pinned);
  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'declared');

  const checked = whenStateIsChecked(folder, { CI: 'true' });
  thenItExits(checked, 1);
  thenContains(checked.stderr, 'baseline ' + pinned + ' is not on origin/main');
});

it("A commit only this branch has is not proved, even when the local ref says otherwise. [AC0052.3]", () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'extra.txt', 'branch only');
  const topic = whenCommitted(folder, 'Branch only');
  const remote = whenRemoteGoesOffline(folder);
  whenGitRuns(folder, 'update-ref', 'refs/remotes/origin/main', topic);
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  whenRemoteReturns(folder, remote);
  const before = whenHistoryIsRead(folder);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: true });
  thenContains(messages(answer), 'baselines are not on origin/main as the server has it');
  thenContains(messages(answer), topic);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
});

it("A tip this repository has not seen yet is fetched before ancestry is checked. [AC0052.4]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const publisher = givenAPublisher(folder);
  const tip = whenTargetAdvances(publisher, 'upstream.txt', 'only on server');
  const before = whenCommitIsKnown(folder, tip);
  thenValueIs(before, false);

  const turn = whenTurnEnds(folder);
  const answer = thenHookReplies(turn, 0);
  thenValueIs(answer.messages[0].code, 'recorded');
  const after = whenCommitIsKnown(folder, tip);
  thenValueIs(after, true);
});

it("CI passes a recorded change whose baseline is not on the target, because recording proved it. [AC0052.5]", () => {
  const folder = givenAWorkingBranch();
  givenARecording(folder);
  const baseline = whenEventsAreRead(folder)[0].payload.baseline;
  const target = whenTargetHistoryIsReplaced(folder);
  const parents = whenGitRuns(folder, 'rev-list', target);
  thenOmits(parents.split('\n'), baseline);

  const checked = whenStateIsChecked(folder, { CI: 'true' });
  thenItExits(checked, 0);
  thenContains(checked.stdout, '.katatay/state/work ok (5 events)');
  thenValueIs(checked.stderr, '');
});

it("In CI, ktty state verify fetches the target first and fails if the server does not answer; outside CI it works offline. [AC0052.6]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const remote = whenRemoteGoesOffline(folder);

  const offline = whenStateIsChecked(folder);
  thenItExits(offline, 0);
  const checked = whenStateIsChecked(folder, { CI: 'true' });
  thenItExits(checked, 1);
  thenContains(checked.stderr, 'could not fetch origin/main from the server');

  whenRemoteReturns(folder, remote);
  const retry = whenStateIsChecked(folder, { CI: 'true' });
  thenItExits(retry, 0);
});
