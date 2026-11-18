import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  planFile,
  rulebookPath,
  whenEventsAreRead,
  whenFileIsRead,
  whenFileIsRemoved,
  whenGitRuns,
  whenJsonIsRead,
  whenPlanIsApproved,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  codesOf,
  givenAConvergingChange,
  givenMutation,
  givenTheMutationAnswer,
  mutationReport,
  textOf,
  whenCheckStartsAreRead,
} from '../support/checks.mjs';
import { thenContains, thenObjectIncludes, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const mutationOf = event => event.payload.results.find(result => result.name === 'mutation');

// A test file edit named by `label`, so the tree changes and the next turn
// end verifies again.
function givenATestEdit(folder, label) {
  givenFileContents(folder, 'tests/add.sh', `test "$(sh src/add.sh)" = 4 # ${label}\n`);
}

it("A later pass repeats the first run's report as stale, without running the tool again. [AC0043.1]", () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { text: '1 mutant: 0 caught, 1 survived.', exit: 1, report: mutationReport(['Survived']) });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenATestEdit(folder, 'a later pass');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'Reused:\nmutation: REUSED\nStale: these results are from verified #3, on an earlier tree, and were not\nmeasured again.\n');
  thenContains(textOf(answer, 'verified'), '1 survived · 0 killed · 1 mutants\nsrc/add.sh:1 ArithmeticOperator → 2 - 2\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'reused', source: { seq: 3 } });
});

it('A removed or altered mutation snapshot fails verify, and verify passes again without a new run once the exact bytes are restored. [AC0043.2]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  const [raw, findings] = mutationOf(whenEventsAreRead(folder).at(-1)).evidence.map(item => item.snapshot);
  const rawBytes = whenFileIsRead(folder, raw);
  const findingsBytes = whenFileIsRead(folder, findings);
  whenFileIsRemoved(folder, raw);
  givenATestEdit(folder, 'raw removed');

  const removed = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(removed), ['verify_failed', 'info']);

  givenFileContents(folder, raw, rawBytes);
  givenFileContents(folder, findings, findingsBytes.replace('"total"', '"total" '));
  givenATestEdit(folder, 'findings altered');

  const altered = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(altered), ['verify_failed', 'info']);

  givenFileContents(folder, findings, findingsBytes);
  givenATestEdit(folder, 'restored');

  const restored = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(restored), ['verified']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'reused', source: { seq: 3 } });
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
});

it('A partial measurement is kept through several reuses and an intervening CI skip. [AC0043.3]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { skipInCi: true });
  givenTheMutationAnswer(folder, { text: '1 mutant: no test ran.', exit: 2, report: mutationReport(['NoCoverage']) });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenATestEdit(folder, 'first reuse');
  thenHookReplies(whenTurnEnds(folder), 0);
  givenATestEdit(folder, 'in CI');
  thenHookReplies(whenTurnEnds(folder, {}, { CI: 'true' }), 0);
  givenATestEdit(folder, 'second reuse');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'mutation: REUSED\n');
  thenContains(textOf(answer, 'verified'), '0 survived · 0 killed · 1 mutants · 1 unproved\n');
  const results = whenEventsAreRead(folder).slice(2).map(mutationOf);
  thenValuesEqual(results.map(result => result.status), ['partial', 'reused', 'skipped', 'reused']);
  thenObjectIncludes(results[1], { source: { seq: 3 }, summary: results[0].summary, evidence: results[0].evidence });
  thenObjectIncludes(results[3], { source: { seq: 3 }, summary: results[0].summary, evidence: results[0].evidence });
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
});

it('A revised plan runs mutation again. [AC0043.4]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, planFile, completePlan.replace('## How\n\nConcrete content.', '## How\n\nRevised content.'));
  thenHookReplies(whenPlanIsApproved(folder), 0);
  thenItExits(whenTriageRuns(folder), 0);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['triaged', 'verified']);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation', 'mutation']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'ok' });
});

it('New rulebook bytes or a new baseline run mutation again. [AC0043.5]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, rulebookPath, JSON.stringify(whenJsonIsRead(folder, rulebookPath), null, 2));

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation', 'mutation']);

  whenGitRuns(folder, 'commit', '--quiet', '--allow-empty', '-m', 'Empty');
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'HEAD:main');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation', 'mutation', 'mutation']);
  thenValueIs(mutationOf(whenEventsAreRead(folder).at(-1)).status, 'ok');
});
