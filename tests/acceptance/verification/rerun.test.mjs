import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsError } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  givenTheTestCommandCountsItsRuns,
  whenEventsAreRead,
  whenFileIsRead,
  whenPlanIsApproved,
  whenTurnEnds,
} from '../support/project.mjs';
import { codesOf, givenACheck, givenACheckAnswers, givenAConvergingChange, textOf, whenVerifyRuns } from '../support/checks.mjs';
import { thenContains, thenEventNamesEqual, thenObjectIncludes, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const fromRerun = 'Warnings:\nThis run came from `workflow verify --rerun`, not from a turn end. It ran in\nthe shell of whoever started it, so that shell\'s environment shaped the\nresult.';
const notRunAgain = 'Verify was not run again: the working tree, the rulebook and the baseline\nare unchanged since this failure.';
const refused = '`workflow verify --rerun` refused, and recorded nothing: ';
const whenTestRunsAreCounted = (folder, marker) => whenFileIsRead(folder, marker).trim().split('\n').length;

it('A rerun pass is recorded, exits 0, and the operator is told it came from a rerun. [AC0032.1]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const run = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(run, 0);
  thenValueIs(run.stdout.startsWith('For the operator, in full:\n\nVerification passed.\n\n' + fromRerun + '\n'), true);
  thenContains(run.stdout, 'Details: .katatay/state/work/0003__verified.json\n');
  thenObjectIncludes(whenEventsAreRead(folder).at(-1), { seq: 3, event: 'verified', payload: { trigger: 'rerun' } });

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'The pass came from `workflow verify --rerun`, not from a turn end: say so.');
});

it('A rerun failure is recorded, exits 1, and the next turn end repeats it without verifying. [AC0032.2]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAConvergingChange(folder, 'echo 5\n');

  const run = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(run, 1);
  thenValueIs(run.stdout, '');
  thenValueIs(run.stderr.startsWith('For the operator, in full:\n\nVerification failed.\n\nFailures:\ntests: FAILED\n'), true);
  thenObjectIncludes(whenEventsAreRead(folder).at(-1), { event: 'verify_failed', payload: { trigger: 'rerun' } });
  const before = whenTestRunsAreCounted(folder, marker);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['verify_failed', 'info']);
  thenContains(textOf(answer, 'verify_failed'), notRunAgain);
  thenValueIs(whenTestRunsAreCounted(folder, marker), before);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('A failure whose cause lay outside the tree is verified again by a rerun, and the next turn end accepts it. [AC0032.3]', () => {
  const folder = givenAWorkingBranch();
  givenACheck(folder, 'codeQuality', 'network');
  givenACheckAnswers(folder, 'network', { exit: 1, text: 'registry unreachable\n' });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenACheckAnswers(folder, 'network', { exit: 0 });

  const repeated = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(repeated, 'verify_failed'), notRunAgain);

  const run = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(run, 0);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verified']);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, false);
  thenValuesEqual(codesOf(answer), ['verified']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verified']);
});

it('Under CI=true the rerun is refused with exit 2 and nothing is recorded. [AC0032.4]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const run = whenVerifyRuns(folder, ['--rerun'], { CI: 'true' });

  thenItExits(run, 2);
  thenItPrintsError(run, [refused + '`CI=true` makes verify behave as it does in CI, and a pass measured that way is not this change\'s receipt. Run it without `CI` set.']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
});

it('A rerun is refused in implementing and in verified. [AC0032.5]', () => {
  const folder = givenAWorkingBranch();
  thenHookReplies(whenPlanIsApproved(folder), 0);

  const implementing = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(implementing, 2);
  thenItPrintsError(implementing, [refused + 'it records only in phase `converging`, where the turn end would verify, and the phase is `implementing`: nothing has been triaged, so the tests are frozen and only the implementation may change']);
  thenEventNamesEqual(folder, ['plan_approved']);

  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);

  const verified = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(verified, 2);
  thenItPrintsError(verified, [refused + 'it records only in phase `converging`, where the turn end would verify, and the phase is `verified`: verified, and waiting for the operator to declare it finished']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified']);
});

it('A rerun is refused, and starts no verify, when the implementation changed after triage. [AC0032.6]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAConvergingChange(folder);
  const before = whenTestRunsAreCounted(folder, marker);
  givenFileContents(folder, 'src/add.sh', 'echo $((3 + 1))\n');

  const run = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(run, 2);
  thenItPrintsError(run, [refused + 'The implementation changed after triage. Restore the triaged implementation or approve a revised plan and triage it again.']);
  thenValueIs(whenTestRunsAreCounted(folder, marker), before);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
});

it('A rerun pass is refused when the tree or the rulebook changed while verify ran. [AC0032.7]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'reports/edit-rulebook.js', "const fs = require('fs'); const p = '.katatay/rulebook.json';\n"
    + 'fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p)), null, 2));\n');
  givenRulebookChanges(folder, book => {
    book.tests.run.command += " && if test -f reports/edit-tests; then rm reports/edit-tests && echo '# edited' >> tests/add.sh; fi"
      + ' && if test -f reports/edit-rulebook; then rm reports/edit-rulebook && node reports/edit-rulebook.js; fi';
  });
  givenAConvergingChange(folder);
  givenFileContents(folder, 'reports/edit-tests', '');

  const treeRun = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(treeRun, 2);
  thenItPrintsError(treeRun, [refused + 'The working tree or approval changed during verify. Run verification again.']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);

  givenFileContents(folder, 'reports/edit-rulebook', '');

  const rulebookRun = whenVerifyRuns(folder, ['--rerun']);

  thenItExits(rulebookRun, 2);
  thenItPrintsError(rulebookRun, [refused + 'The rulebook changed during verify. Run verification again.']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
});
