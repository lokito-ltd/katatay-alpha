import { it } from 'vitest';
import { createHash } from 'node:crypto';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  rulebookPath,
  whenEventsAreRead,
  whenFileIsRead,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTurnEnds,
} from '../support/project.mjs';
import { codesOf, givenAConvergingChange, textOf, whenVerifyRuns } from '../support/checks.mjs';
import {
  thenEventNamesEqual,
  thenLengthIs,
  thenObjectIncludes,
  thenStateShowsPhase,
  thenTextMatches,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import { thenItExits } from '../support/ktty.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

it('Nothing is verified while the implementation is still being written. [AC0030.1]', () => {
  const folder = givenAWorkingBranch();
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, false);
  thenValuesEqual(codesOf(answer), ['run_triage']);
  thenValueIs(textOf(answer, 'run_triage'), 'Nothing is verified while the implementation is in progress, and a red suite is expected here. Run `workflow triage` once the implementation is complete. It will say what actually broke.');
  thenEventNamesEqual(folder, ['plan_approved']);
});

it('A failing verify blocks the turn and records verify_failed. [AC0030.2]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder, 'echo 5\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, true);
  thenValuesEqual(codesOf(answer), ['triaged', 'verify_failed', 'info']);
  thenTextMatches(textOf(answer, 'verify_failed'), /^Verification failed\.\n\nFailures:\ntests: FAILED\n1 \/ 1 failed\ntests\/add\.sh — adds\n/);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
  thenStateShowsPhase(whenStateIsShown(folder), 'converging');
});

it('The hook writes the receipt itself, and the agent saying it verified counts for nothing. [AC0030.3]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const byHand = whenVerifyRuns(folder);

  thenItExits(byHand, 0);
  thenTextMatches(byHand.stdout, /^verify: every step passed/m);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
  thenStateShowsPhase(whenStateIsShown(folder), 'converging');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['triaged', 'verified']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified']);
  thenStateShowsPhase(whenStateIsShown(folder), 'verified');
});

it('The next edit outside change files and the follow-ups file voids the receipt. [AC0030.4]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);

  givenFileContents(folder, 'FOLLOW-UPS.md', '# Follow-ups\n\n- Later.\n');
  givenFileContents(folder, 'requirements/changes/20261113T000000.000Z__change.md', '# A change\n');

  thenStateShowsPhase(whenStateIsShown(folder), 'verified');

  givenFileContents(folder, 'src/add.sh', 'echo $((3 + 1))\n');

  thenStateShowsPhase(whenStateIsShown(folder), 'converging');
});

it('A pass is not recorded when the tests change while verify runs. [AC0030.5]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => {
    book.tests.run.command += " && if test -f reports/edit-now; then echo '# edited' >> tests/add.sh; fi";
  });
  givenAConvergingChange(folder);
  givenFileContents(folder, 'reports/edit-now', '');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, true);
  thenValuesEqual(answer.messages, [{ code: 'stop', for: 'operator', text: 'The working tree or approval changed during verify. Run verification again.' }]);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged']);
  thenStateShowsPhase(whenStateIsShown(folder), 'converging');
});

it('A rulebook edit during verify records a failure under the starting rulebook, and the next turn verifies again. [AC0030.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'reports/edit-rulebook.js', "const fs = require('fs'); const p = '.katatay/rulebook.json';\n"
    + 'fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p)), null, 2));\n');
  givenRulebookChanges(folder, book => {
    book.tests.run.command += ' && if test -f reports/edit-now; then rm reports/edit-now && node reports/edit-rulebook.js && exit 1; fi';
  });
  givenAConvergingChange(folder);
  givenFileContents(folder, 'reports/edit-now', '');
  const starting = sha256(whenFileIsRead(folder, rulebookPath, null));

  const failed = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(failed), ['triaged', 'verify_failed', 'info']);
  thenObjectIncludes(whenEventsAreRead(folder).at(-1), { event: 'verify_failed', payload: { rulebookFingerprint: starting } });

  const next = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(next), ['verified']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verified']);
  thenObjectIncludes(whenEventsAreRead(folder).at(-1), { payload: { rulebookFingerprint: sha256(whenFileIsRead(folder, rulebookPath, null)) } });
});

it("verify_failed keeps the last 20 lines of verify's output, and the agent is shown the last 40. [AC0030.7]", () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => {
    book.tests.run.command = 'for n in $(seq 1 60); do echo "line $n"; done; ' + book.tests.run.command;
  });
  givenAConvergingChange(folder, 'echo 5\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  const tail = whenEventsAreRead(folder).at(-1).payload.tail.replace(/\n$/, '').split('\n');
  thenLengthIs(tail, 20);
  const shown = textOf(answer, 'info').split('\n\n').slice(2).join('\n\n').split('\n');
  thenLengthIs(shown, 40);
  thenValuesEqual(shown.slice(-20), tail);
});
