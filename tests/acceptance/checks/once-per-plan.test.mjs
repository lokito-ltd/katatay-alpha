import { it } from 'vitest';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  rulebookPath,
  whenEventsAreRead,
  whenGitRuns,
  whenJsonIsRead,
  whenTurnEnds,
} from '../support/project.mjs';
import { codesOf, givenACheck, givenACheckAnswers, givenAConvergingChange, textOf, whenCheckStartsAreRead } from '../support/checks.mjs';
import { thenContains, thenEventNamesEqual, thenObjectIncludes, thenOmits, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

// A test file edit named by `label`, so the tree changes and the next turn
// end verifies again.
function givenATestEdit(folder, label) {
  givenFileContents(folder, 'tests/add.sh', `test "$(sh src/add.sh)" = 4 # ${label}\n`);
}

const rerunCommand = 'Run it again on its own: `echo slow >> reports/check-starts; cat\nreports/answers/slow.out; exit "$(cat reports/answers/slow.exit)"`.';

it("A once-per-plan check's result is stored on a pass, skipped afterwards, and its findings repeated. [AC0036.1]", () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'slow', { runs: 'oncePerPlan', onFailure: 'report' });
  givenACheckAnswers(folder, 'slow', { exit: 1, text: 'slow finding\n' });
  givenAConvergingChange(folder);

  const first = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(first, 'verified'), 'Findings:\nslow: FINDINGS\nfindings (exit 1)\nslow finding\n');
  thenObjectIncludes(whenEventsAreRead(folder).at(-1).payload.results.find(result => result.name === 'slow'), { status: 'ok' });
  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow']);

  givenATestEdit(folder, 'edit 1');

  const second = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(second, 'verified'), 'findings (exit 1)\nslow finding\n');
  thenObjectIncludes(whenEventsAreRead(folder).at(-1).payload.results.find(result => result.name === 'slow'), { status: 'reused', source: { seq: 3 } });
  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow']);
});

it('A reused result is listed as stale, with the command that runs it again. [AC0036.2]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'slow', { runs: 'oncePerPlan', onFailure: 'report' });
  givenACheckAnswers(folder, 'slow', { exit: 1, text: 'slow finding\n' });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenATestEdit(folder, 'edit 2');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'Reused:\nslow: REUSED\nStale: these results are from verified #3, on an earlier tree, and were not\nmeasured again.\n'
    + rerunCommand + '\nfindings (exit 1)\nslow finding\n');
});

it('New rulebook bytes or a new baseline make the check run again. [AC0036.3]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'slow', { runs: 'oncePerPlan' });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, rulebookPath, JSON.stringify(whenJsonIsRead(folder, rulebookPath), null, 2));

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow', 'slow']);

  whenGitRuns(folder, 'commit', '--quiet', '--allow-empty', '-m', 'Empty');
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'HEAD:main');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow', 'slow', 'slow']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'verified', 'baseline_moved', 'verified']);
});

it('A blocking once-per-plan check runs on every verify until it comes back clean, and nothing is stored while verify fails. [AC0036.4]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'slow', { runs: 'oncePerPlan' });
  givenACheckAnswers(folder, 'slow', { exit: 1, text: 'blocking finding\n' });
  givenAConvergingChange(folder);

  const first = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(first), ['triaged', 'verify_failed', 'info']);
  givenATestEdit(folder, 'edit 3');

  const second = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(second), ['verify_failed', 'info']);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow', 'slow']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verify_failed']);

  givenACheckAnswers(folder, 'slow', { exit: 0 });
  givenATestEdit(folder, 'edit 4');

  const clean = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(clean), ['verified']);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow', 'slow', 'slow']);

  givenATestEdit(folder, 'edit 5');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['slow', 'slow', 'slow']);
});

it('A clean check, blocking or not, is listed as passed in one line. [AC0036.5]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'blocking');
  givenACheck(folder, 'codeQuality', 'reporting', { onFailure: 'report' });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  const summary = textOf(answer, 'verified');
  thenContains(summary, '\nblocking: PASSED\nreporting: PASSED\n\nDetails:');
  thenValueIs(summary.split('\n').filter(line => line.includes('blocking')).length, 1);
  thenValueIs(summary.split('\n').filter(line => line.includes('reporting')).length, 1);
  thenOmits(summary, 'Findings:');
});
