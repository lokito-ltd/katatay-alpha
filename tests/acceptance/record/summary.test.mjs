import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenEventsAreRead,
  whenHookRuns,
  whenPlanIsApproved,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import { thenContains, thenEventNamesEqual, thenValuesEqual } from '../support/assertions.mjs';

// A change verified at a turn end, with coverage and mutation switched off as
// the fixture's rulebook has them, and no checks analysis required.
function givenAVerifiedChange(folder) {
  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = false; });
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/extra.sh', 'echo extra\n');
  thenItExits(whenTriageRuns(folder), 0);
  const verification = thenHookReplies(whenTurnEnds(folder), 0);
  thenContains(verification.messages.map(message => message.code), 'verified');
}

it('With coverage or mutation switched off, the summary at record names each check it did not run. [AC0047.6]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder);

  thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);

  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);
  const { summary } = whenEventsAreRead(folder).at(-1).payload;
  thenValuesEqual(summary, [
    'prediction: exact · protected files: 0 · risk: LOW',
    'AC scenarios: 0 added, 0 reworded, 0 retired',
    'tests: 0 added, 0 modified, 0 removed',
    'follow-ups +0 −0 · code +1 −0 lines',
    'not checked: coverage, mutation',
  ]);
});
