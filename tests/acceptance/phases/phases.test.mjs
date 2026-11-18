import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  givenAChangeFile,
  givenAWorkingBranch,
  givenFileContents,
  whenEventsAreRead,
  whenHookRuns,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenEventsEqual,
  thenObjectIncludes,
  thenStateShowsPhase,
} from '../support/assertions.mjs';

const changeFile = 'requirements/changes/20261113T000000.000Z__extra.md';

function givenAVerifiedChange(folder) {
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/extra.sh', 'echo extra\n');
  thenItExits(whenTriageRuns(folder), 0);
  const verification = thenHookReplies(whenTurnEnds(folder), 0);
  thenContains(verification.messages.map(message => message.code), 'verified');
}

it('With no live plan approval, the phase is open. [AC0016.1]', () => {
  const folder = givenAWorkingBranch();

  const fresh = whenStateIsShown(folder);
  thenStateShowsPhase(fresh, 'open');

  thenHookReplies(whenPlanIsApproved(folder), 0);
  const reset = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'reset' }), 0);
  thenObjectIncludes(reset.messages[0], { code: 'reset' });

  const afterReset = whenStateIsShown(folder);
  thenStateShowsPhase(afterReset, 'open');
});

it('An approval with no triage after it is implementing. [AC0016.2]', () => {
  const folder = givenAWorkingBranch();

  thenHookReplies(whenPlanIsApproved(folder), 0);

  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'implementing');
});

it('A triage with no passing verification of this exact tree is converging. [AC0016.3]', () => {
  const folder = givenAWorkingBranch();
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');

  thenItExits(whenTriageRuns(folder), 0);
  const triaged = whenStateIsShown(folder);
  thenStateShowsPhase(triaged, 'converging');

  const failure = thenHookReplies(whenTurnEnds(folder), 0);
  thenContains(failure.messages.map(message => message.code), 'verify_failed');
  const failed = whenStateIsShown(folder);
  thenStateShowsPhase(failed, 'converging');
});

it('A verified event for this tree, rulebook and baseline is verified, and a change file alone is not. [AC0016.4]', () => {
  const verified = givenAWorkingBranch();
  givenAVerifiedChange(verified);

  const state = whenStateIsShown(verified);
  thenStateShowsPhase(state, 'verified');

  const unverified = givenAWorkingBranch();
  thenHookReplies(whenPlanIsApproved(unverified), 0);
  givenFileContents(unverified, 'src/extra.sh', 'echo extra\n');
  thenItExits(whenTriageRuns(unverified), 0);
  givenAChangeFile(unverified, changeFile, 'Extra', ['prediction: exact']);

  const withChangeFile = whenStateIsShown(unverified);
  thenStateShowsPhase(withChangeFile, 'converging');
});

it('A declared event stays declared until the guard passes on the exact change files, which makes it recorded. [AC0016.5]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder);
  thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);
  const declaredState = whenStateIsShown(folder);
  thenStateShowsPhase(declaredState, 'declared');

  const waiting = thenHookReplies(whenTurnEnds(folder), 0);
  thenObjectIncludes(waiting.messages[0], { code: 'change_file', for: 'agent' });
  thenStateShowsPhase(whenStateIsShown(folder), 'declared');

  const { summary } = whenEventsAreRead(folder).at(-1).payload;
  givenAChangeFile(folder, changeFile, 'Extra', summary);
  const recording = thenHookReplies(whenTurnEnds(folder), 0);
  thenObjectIncludes(recording.messages[0], { code: 'recorded' });
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared', 'recorded']);
  const recorded = whenStateIsShown(folder);
  thenStateShowsPhase(recorded, 'recorded');

  givenAChangeFile(folder, changeFile, 'Extra, edited', summary);

  const edited = whenStateIsShown(folder);
  thenStateShowsPhase(edited, 'declared');
});

it('Any edit outside the change files after verification returns the phase to converging. [AC0016.6]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # checked\n');

  const state = whenStateIsShown(folder);

  thenStateShowsPhase(state, 'converging');
});

it('Typed words other than record and reset grant nothing. [AC0016.7]', () => {
  const open = givenAWorkingBranch();
  const verified = givenAWorkingBranch();
  givenAVerifiedChange(verified);
  const history = whenEventsAreRead(verified);

  for (const prompt of ['approve', 'yes', 'Approved, go ahead.', 'record it', 'please reset']) {
    thenHookReplies(whenHookRuns(open, 'prompt', { prompt }), 0);
    thenHookReplies(whenHookRuns(verified, 'prompt', { prompt }), 0);
  }

  thenEventsEqual(open, []);
  thenStateShowsPhase(whenStateIsShown(open), 'open');
  thenEventsEqual(verified, history);
  thenStateShowsPhase(whenStateIsShown(verified), 'verified');
});
