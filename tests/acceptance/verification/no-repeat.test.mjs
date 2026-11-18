import { it } from 'vitest';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenAnEventIsAppended,
  givenFileContents,
  givenTheTestCommandCountsItsRuns,
  rulebookPath,
  whenEventsAreRead,
  whenFileIsRead,
  whenGitRuns,
  whenJsonIsRead,
  whenTurnEnds,
} from '../support/project.mjs';
import { codesOf, givenAConvergingChange, textOf } from '../support/checks.mjs';
import { thenContains, thenEventNamesEqual, thenObjectIncludes, thenValueDiffers, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const notRunAgain = 'Verify was not run again: the working tree, the rulebook and the baseline\nare unchanged since this failure. `workflow verify --rerun` runs it again.';
const whenTestRunsAreCounted = (folder, marker) => whenFileIsRead(folder, marker).trim().split('\n').length;
const whenFailuresAreRead = folder => whenEventsAreRead(folder).filter(event => event.event === 'verify_failed');

// A converging change whose suite fails, and the turn end that recorded it.
function givenAFailedVerification(folder) {
  givenAConvergingChange(folder, 'echo 5\n');
  thenHookReplies(whenTurnEnds(folder), 0);
}

it('A turn end does not run verify again while nothing has changed since it failed. [AC0031.1]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAFailedVerification(folder);
  const before = whenTestRunsAreCounted(folder, marker);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, true);
  thenValuesEqual(codesOf(answer), ['verify_failed', 'info']);
  thenContains(textOf(answer, 'verify_failed'), notRunAgain);
  thenContains(textOf(answer, 'info'), 'so it was not run again. The failure stands:');
  thenValueIs(whenTestRunsAreCounted(folder, marker), before);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('A turn end runs verify again when the tree has changed since it failed. [AC0031.2]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAFailedVerification(folder);
  const before = whenTestRunsAreCounted(folder, marker);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # an attempted fix\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['verify_failed', 'info']);
  thenValueIs(textOf(answer, 'info').startsWith('`workflow verify` failed on the current working tree.'), true);
  thenValueIs(whenTestRunsAreCounted(folder, marker), before + 1);
  thenValueIs(whenFailuresAreRead(folder).length, 2);
});

it('A turn end runs verify again when the rulebook has changed since it failed. [AC0031.3]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAFailedVerification(folder);
  const before = whenTestRunsAreCounted(folder, marker);
  givenFileContents(folder, rulebookPath, JSON.stringify(whenJsonIsRead(folder, rulebookPath), null, 2));

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['verify_failed', 'info']);
  thenValueIs(whenTestRunsAreCounted(folder, marker), before + 1);
  thenValueIs(whenFailuresAreRead(folder).length, 2);
});

it('A baseline move to the same commit keeps the failure standing. [AC0031.4]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAFailedVerification(folder);
  const pinned = whenEventsAreRead(folder)[0].payload.baseline;
  givenAnEventIsAppended(folder, 'baseline_moved', { from: pinned, to: pinned });
  const before = whenTestRunsAreCounted(folder, marker);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verify_failed'), notRunAgain);
  thenValueIs(whenTestRunsAreCounted(folder, marker), before);
  thenValueIs(whenFailuresAreRead(folder).length, 1);
});

it('A target that advances, even by an empty commit, gets the same failing tree verified again. [AC0031.5]', () => {
  const folder = givenAWorkingBranch();
  givenAFailedVerification(folder);
  whenGitRuns(folder, 'commit', '--quiet', '--allow-empty', '-m', 'Empty');
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'HEAD:main');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer).filter(code => code === 'verify_failed'), ['verify_failed']);
  const [first, second] = whenFailuresAreRead(folder);
  thenValueIs(second.payload.treeFingerprint, first.payload.treeFingerprint);
  thenValueIs(second.payload.rulebookFingerprint, first.payload.rulebookFingerprint);
  thenValueIs(second.payload.baseline, whenGitRuns(folder, 'rev-parse', 'HEAD'));
  thenValueDiffers(second.payload.baseline, first.payload.baseline);
});

it('A pass after the failure ends the hold, even if the tree returns to the one that failed. [AC0031.6]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);
  const failing = 'test "$(sh src/add.sh)" = 5\n';
  const passing = whenFileIsRead(folder, 'tests/add.sh');
  givenFileContents(folder, 'tests/add.sh', failing);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, 'tests/add.sh', passing);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, 'tests/add.sh', failing);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(textOf(answer, 'info').startsWith('`workflow verify` failed on the current working tree.'), true);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verified', 'verify_failed']);
  thenObjectIncludes(whenFailuresAreRead(folder)[1], { payload: { treeFingerprint: whenFailuresAreRead(folder)[0].payload.treeFingerprint } });
});
