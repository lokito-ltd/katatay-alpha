import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  answers,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  messages,
  planFile,
  whenEventsAreRead,
  whenGitRuns,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenEventsEqual,
  thenGitPrints,
  thenHookAnswers,
  thenObjectIncludes,
  thenValueDiffers,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import { givenAnApproval, whenCommitted, whenHistoryIsRead, whenPromptRuns } from '../support/history.mjs';
import { givenAPublisher, whenRemoteGoesOffline, whenTargetAdvances } from '../support/remote.mjs';

it("The baseline is pinned where HEAD meets the target, taken from the server. [AC0050.1]", () => {
  const folder = givenAWorkingBranch();
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  givenFileContents(folder, 'topic.txt', 'branch work');
  const topic = whenCommitted(folder, 'Topic');
  whenGitRuns(folder, 'update-ref', 'refs/remotes/origin/main', topic);

  const approval = whenPlanIsApproved(folder);
  thenHookAnswers(approval, { recorded: true });
  const [event] = whenEventsAreRead(folder);
  thenValueIs(event.payload.baseline, pinned);
  const state = whenStateIsShown(folder);
  thenContains(state.stdout, 'baseline   ' + pinned.slice(0, 12) + ' on origin/main — pinned ' + pinned.slice(0, 12));
});

it("When the server does not answer, the ref as last fetched is used, and the approval says so. [AC0050.2]", () => {
  const folder = givenAWorkingBranch();
  const fetched = whenGitRuns(folder, 'rev-parse', 'origin/main');
  whenRemoteGoesOffline(folder);
  givenFileContents(folder, 'topic.txt', 'branch work');
  whenCommitted(folder, 'Topic');

  const approval = whenPlanIsApproved(folder);
  const answer = thenHookAnswers(approval, { recorded: true });
  thenContains(messages(answer), 'server did not answer, so the baseline was taken from origin/main as last fetched');
  const [event] = whenEventsAreRead(folder);
  thenValueIs(event.payload.baseline, fetched);
});

it("A revised plan keeps the baseline. [AC0050.3]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const publisher = givenAPublisher(folder);
  const next = whenTargetAdvances(publisher, 'tests/upstream.sh', 'true\n');
  whenGitRuns(folder, 'fetch', 'origin');
  whenGitRuns(folder, 'merge', '--ff-only', next);
  givenFileContents(folder, planFile, completePlan + '\nRevision.\n');

  const approval = whenPlanIsApproved(folder);
  thenHookAnswers(approval, { recorded: true });
  const history = whenEventsAreRead(folder);
  thenValuesEqual(history.map(e => e.payload.baseline), [pinned, pinned]);
});

it("With no target ever fetched and no server answer, the approval records nothing. [AC0050.4]", () => {
  const folder = givenAWorkingBranch();
  whenRemoteGoesOffline(folder);
  whenGitRuns(folder, 'update-ref', '-d', 'refs/remotes/origin/main');

  const approval = whenPlanIsApproved(folder);
  const answer = thenHookAnswers(approval, { recorded: false });
  thenContains(messages(answer), 'origin/main has never been fetched and the server did not answer');
  thenEventsEqual(folder, []);
});

it("The approval warns when the branch already carries work the target does not have. [AC0050.5]", () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'in-commit.txt', 'committed');
  whenCommitted(folder, 'Earlier work');
  givenFileContents(folder, 'src/add.sh', 'echo changed');
  givenFileContents(folder, 'new.txt', 'untracked');
  givenFileContents(folder, 'staged.txt', 'staged');
  whenGitRuns(folder, 'add', 'staged.txt');
  givenFileContents(folder, 'FOLLOW-UPS.md', 'Parked');

  const approval = whenPlanIsApproved(folder);
  const answer = thenHookAnswers(approval, { recorded: true });
  thenContains(messages(answer), 'already changes 4 file(s) that are not on origin/main: in-commit.txt, src/add.sh, staged.txt, new.txt');
});

it("Merging the target into the branch moves the baseline forward, and the merged-in tests are not this change's. [AC0051.1]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const publisher = givenAPublisher(folder);
  const next = whenTargetAdvances(publisher, 'tests/upstream.sh', 'true\n');
  whenGitRuns(folder, 'fetch', 'origin');
  whenGitRuns(folder, 'merge', '--ff-only', next);

  const turn = whenTurnEnds(folder);
  thenHookAnswers(turn, { keepWorking: false });
  const moved = whenEventsAreRead(folder).at(-1);
  thenObjectIncludes(moved, { event: 'baseline_moved', payload: { from: pinned, to: next } });
  const triage = whenTriageRuns(folder);
  thenItExits(triage, 0);
  thenEventNamesEqual(folder, ['plan_approved', 'baseline_moved', 'triaged']);
});

it("A target that was fetched and not merged in does not move the baseline. [AC0051.2]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const publisher = givenAPublisher(folder);
  const next = whenTargetAdvances(publisher, 'tests/upstream.sh', 'true\n');
  whenGitRuns(folder, 'fetch', 'origin');
  thenValueDiffers(next, pinned);

  const turn = whenTurnEnds(folder);
  thenHookAnswers(turn, { keepWorking: false });
  thenEventNamesEqual(folder, ['plan_approved']);
  const state = whenStateIsShown(folder);
  thenContains(state.stdout, 'baseline   ' + pinned.slice(0, 12) + ' on origin/main');
});

it("The baseline never moves backwards. [AC0051.3]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const publisher = givenAPublisher(folder);
  const next = whenTargetAdvances(publisher, 'tests/upstream.sh', 'true\n');
  whenGitRuns(folder, 'fetch', 'origin');
  whenGitRuns(folder, 'merge', '--ff-only', next);
  const forward = whenPromptRuns(folder, 'status');
  thenHookReplies(forward, 0);
  const before = whenHistoryIsRead(folder);
  whenGitRuns(publisher, 'push', '--force', 'origin', pinned + ':main');
  whenGitRuns(folder, 'fetch', 'origin');

  const back = whenPromptRuns(folder, 'status');
  thenHookReplies(back, 0);
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
  const state = whenStateIsShown(folder);
  thenContains(state.stdout, 'baseline   ' + next.slice(0, 12) + ' on origin/main');
});

it("When the server answers, a faked remote-tracking ref moves nothing. [AC0051.4]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/topic.sh', 'echo topic\n');
  whenGitRuns(folder, 'add', 'src/topic.sh');
  whenGitRuns(folder, 'commit', '-qm', 'Work on topic');
  const topic = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const pinned = whenGitRuns(folder, 'rev-parse', 'origin/main');
  whenGitRuns(folder, 'update-ref', 'refs/remotes/origin/main', topic);

  const turn = whenTurnEnds(folder);
  thenHookReplies(turn, 0);
  thenEventNamesEqual(folder, ['plan_approved']);
  thenGitPrints(folder, ['rev-parse', 'origin/main'], pinned);
});

it("While the server is down, a faked ref can move the baseline. [AC0051.5]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  givenFileContents(folder, 'src/topic.sh', 'echo topic\n');
  whenGitRuns(folder, 'add', 'src/topic.sh');
  whenGitRuns(folder, 'commit', '-qm', 'Work on topic');
  const topic = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const pinned = whenGitRuns(folder, 'rev-parse', 'origin/main');
  whenRemoteGoesOffline(folder);
  whenGitRuns(folder, 'update-ref', 'refs/remotes/origin/main', topic);

  const turn = whenTurnEnds(folder);
  thenHookReplies(turn, 0);
  thenEventNamesEqual(folder, ['plan_approved', 'baseline_moved']);
  const moved = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(moved.payload, { from: pinned, to: topic });
});

it("The operator is told the old and new baseline after a move. [AC0051.6]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const pinned = whenGitRuns(folder, 'rev-parse', 'HEAD');
  const publisher = givenAPublisher(folder);
  const next = whenTargetAdvances(publisher, 'tests/upstream.sh', 'true\n');
  whenGitRuns(folder, 'fetch', 'origin');
  whenGitRuns(folder, 'merge', '--ff-only', next);

  const prompt = whenPromptRuns(folder, 'status');
  const answer = thenHookReplies(prompt, 0);
  thenContains(messages(answer), 'baseline moved forward from ' + pinned.slice(0, 12) + ' to ' + next.slice(0, 12));
  const state = whenStateIsShown(folder);
  thenContains(state.stdout, 'moved ' + pinned.slice(0, 12) + ' → ' + next.slice(0, 12));
});
