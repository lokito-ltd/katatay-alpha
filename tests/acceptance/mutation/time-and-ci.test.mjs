import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsLines } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, whenEventsAreRead, whenFileIsRead, whenStateIsShown, whenTurnEnds } from '../support/project.mjs';
import {
  givenACheck,
  givenAConvergingChange,
  givenMutation,
  givenTheMutationAnswer,
  mutationOutput,
  mutationReport,
  textOf,
  whenCheckStartsAreRead,
  whenMutateRuns,
  whenVerifyRuns,
} from '../support/checks.mjs';
import { thenContains, thenObjectIncludes, thenStateShowsPhase, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const mutationOf = event => event.payload.results.find(result => result.name === 'mutation');
const deferred = "Mutation testing deferred: the hook needs 10 seconds for the run and 20 seconds in reserve. The plan's run is still pending.";

it('A run without its whole limit plus 20 seconds left is deferred, says so, and the tree is still verified. [AC0044.1]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder, { secondsLeft: 29 }), 0);

  thenContains(textOf(answer, 'verified'), "\nmutation: SKIPPED — Mutation testing deferred: the hook needs 10 seconds for\nthe run and 20 seconds in reserve. The plan's run is still pending.\n");
  thenValuesEqual(whenCheckStartsAreRead(folder), []);
  thenStateShowsPhase(whenStateIsShown(folder), 'verified');
});

it('A deferred run records no mutation measurement. [AC0044.2]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder, { secondsLeft: 29 }), 0);

  thenValuesEqual(mutationOf(whenEventsAreRead(folder).at(-1)), { name: 'mutation', status: 'skipped', reason: deferred, evidence: [], summary: {} });

  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # with time to spare\n');
  thenHookReplies(whenTurnEnds(folder, { secondsLeft: 300 }), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
  thenValueIs(mutationOf(whenEventsAreRead(folder).at(-1)).status, 'ok');
});

it('Under CI=true with skipInCi, mutation starts nothing, says why, keeps the report, and goes on to the next check. [AC0044.3]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { skipInCi: true });
  givenACheck(folder, 'testQuality', 'smell');
  givenAConvergingChange(folder);
  givenFileContents(folder, mutationOutput, 'the report from before\n');

  const run = whenVerifyRuns(folder, [], { CI: 'true' });

  thenItExits(run, 0);
  thenContains(run.stdout, '\nmutation — skipped in CI (skipInCi: true)\nsmell — clean\n');
  thenValueIs(whenFileIsRead(folder, mutationOutput), 'the report from before\n');
  thenValuesEqual(whenCheckStartsAreRead(folder), ['smell']);
});

it("A CI skip does not use up the plan's run, and mutation runs once outside CI. [AC0044.4]", () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { skipInCi: true });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder, {}, { CI: 'true' }), 0);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'skipped' });
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # outside CI\n');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'ok' });

  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # once more\n');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'reused', source: { seq: 4 } });
});

it('ktty mutate runs under CI=true whatever skipInCi says. [AC0044.5]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { skipInCi: true });
  givenAConvergingChange(folder);

  const run = whenMutateRuns(folder, [], { CI: 'true' });

  thenItExits(run, 0);
  thenItPrintsLines(run, [
    'Mutation testing on the lines this change added or changed:',
    '  The tool reports no surviving mutant. That is its account, not',
    '  proof that the tests catch every mutant.',
    '',
    '  1 mutant: 1 caught, 0 survived.',
  ]);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation']);
});

it('ktty mutate exits 0 when clean, 1 when mutants survived, 2 when the run proved nothing, and 3 on failure. [AC0044.6]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenAConvergingChange(folder);

  thenItExits(whenMutateRuns(folder), 0);

  givenTheMutationAnswer(folder, { text: '1 mutant: 0 caught, 1 survived.', exit: 1, report: mutationReport(['Survived']) });

  thenItExits(whenMutateRuns(folder), 1);

  givenTheMutationAnswer(folder, { text: '1 mutant: no test ran.', exit: 2, report: mutationReport(['NoCoverage']) });

  thenItExits(whenMutateRuns(folder), 2);

  givenTheMutationAnswer(folder, { error: 'boom', exit: 3 });

  thenItExits(whenMutateRuns(folder), 3);
});

it('ktty mutate with no baseline fails and says to pass --base. [AC0044.7]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);

  const run = whenMutateRuns(folder);

  thenItExits(run, 3);
  thenItPrintsLines(run, ['There is no baseline to measure from: no plan has been approved on this branch. Pass `--base <sha>`.']);
  thenValuesEqual(whenCheckStartsAreRead(folder), []);
});
