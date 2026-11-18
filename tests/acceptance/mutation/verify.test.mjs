import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import { givenAWorkingBranch, givenFileContents, whenEventsAreRead, whenPlanIsApproved, whenTriageRuns, whenTurnEnds } from '../support/project.mjs';
import {
  codesOf,
  givenACheck,
  givenACheckAnswers,
  givenAConvergingChange,
  givenMutation,
  givenTheMutationAnswer,
  mutationOutput,
  mutationReport,
  textOf,
  whenCheckStartsAreRead,
  whenMutationRequestsAreRead,
} from '../support/checks.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenObjectIncludes,
  thenOmits,
  thenPathsExist,
  thenTextMatches,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';

const mutationOf = event => event.payload.results.find(result => result.name === 'mutation');

it('The verification summary shows the counts and each survivor by file, line and mutator. [AC0041.1]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { text: '3 mutants: 1 caught, 2 survived.', exit: 1, report: mutationReport(['Survived', 'Killed', 'Survived']) });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), '\nmutation: FINDINGS\n2 survived · 1 killed · 3 mutants\nsrc/add.sh:1 ArithmeticOperator → 2 - 2\nsrc/add.sh:1 ArithmeticOperator → 2 - 2\n\n');
});

it('The mutation command is given its time budget and the touched lines to mutate. [AC0041.2]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { timeLimitSeconds: 42 });
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  givenFileContents(folder, 'src/new.sh', 'echo new\n');
  thenItExits(whenTriageRuns(folder), 0);

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenMutationRequestsAreRead(folder), [{
    targets: [{ file: 'src/add.sh', lines: [1, 1] }, { file: 'src/new.sh' }], budget: 42, verbose: false,
  }]);
});

it('A run that proves nothing is reported as partial, never as passed. [AC0041.3]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { text: '1 mutant: no test ran.', exit: 2, report: mutationReport(['NoCoverage']) });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verified'), 'Findings:\nmutation: PARTIAL\n0 survived · 0 killed · 1 mutants · 1 unproved\nThe run proves nothing this time. The tool said:\n1 mutant: no test ran.\n');
  thenOmits(textOf(answer, 'verified'), 'mutation: PASSED');
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'partial' });
});

it('Tests, excluded paths and non-code files are never mutated. [AC0041.4]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { excludePaths: ['src/generated/**'] });
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  givenFileContents(folder, 'src/generated/table.sh', 'echo table\n');
  givenFileContents(folder, 'README.md', '# Notes\n');
  thenItExits(whenTriageRuns(folder), 0);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # edited\n');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenMutationRequestsAreRead(folder).map(request => request.targets), [[{ file: 'src/add.sh', lines: [1, 1] }]]);
});

it('With mutation switched off, the summary says it was not checked and verify still passes. [AC0041.5]', () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['triaged', 'verified']);
  thenContains(textOf(answer, 'verified'), '\nmutation: SKIPPED — Disabled in the rulebook.\n');
});

it("A mutation command that fails without a report fails verify, records verify_failed, and shows the tool's error. [AC0042.1]", () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { error: 'stryker: crashed', exit: 3 });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValueIs(answer.keepWorking, true);
  thenContains(textOf(answer, 'verify_failed'), 'Failures:\nmutation: FAILED\nmutation check broke\nMutation testing failed before it could say anything:\n'
    + '  adapter: mutate (`node mutate.js`) exited with 3, which means it crashed: only 0, 1 and 2 are results. That is the command failing, not a result, so nothing was concluded from it.\n'
    + '  stryker: crashed\n');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('A stale report is removed first, and a run that writes none fails. [AC0042.2]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { text: 'clean', exit: 0 });
  givenAConvergingChange(folder);
  givenFileContents(folder, mutationOutput, JSON.stringify(mutationReport(['Killed'])));

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenTextMatches(textOf(answer, 'verify_failed'), /\n {2}Mutation report failed: reports\/mutation\/mutation\.json\n {2}ENOENT: no such file or directory, open '.*\/reports\/mutation\/mutation\.json'\n/);
  thenPathsExist(folder, [mutationOutput], false);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('An invalid report fails with the specific validation error. [AC0042.3]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { text: 'clean', exit: 0, report: 'invalid' });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenContains(textOf(answer, 'verify_failed'), '  Mutation report failed: reports/mutation/mutation.json\n  expected a mutation report with schemaVersion 1 or 2 and a files object\n');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('A run stopped by its backstop is reported as having overrun. [AC0042.4]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder, { timeLimitSeconds: 1 });
  givenTheMutationAnswer(folder, { text: 'late', exit: 0, report: mutationReport(['Killed']), sleep: 30 });
  givenAConvergingChange(folder);

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenTextMatches(textOf(answer, 'verify_failed'), /\n {2}adapter: mutate \(`node mutate\.js`\) was still running after \d+ seconds, and was stopped\. That is the command failing, not a result, so nothing was concluded from it\.\n/);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed']);
});

it('A broken run is tried again after a fix. [AC0042.5]', () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenTheMutationAnswer(folder, { error: 'stryker: crashed', exit: 3 });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenTheMutationAnswer(folder, { text: '1 mutant: 1 caught, 0 survived.', exit: 0, report: mutationReport(['Killed']) });
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # after the fix\n');

  const answer = thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(codesOf(answer), ['verified']);
  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation', 'mutation']);
  thenObjectIncludes(mutationOf(whenEventsAreRead(folder).at(-1)), { status: 'ok' });
});

it("A plan whose code check failed later runs mutation again, and only the successful verify is recorded as the plan's run. [AC0042.6]", () => {
  const folder = givenAWorkingBranch();
  givenMutation(folder);
  givenACheck(folder, 'codeQuality', 'lint');
  givenACheckAnswers(folder, 'lint', { exit: 1, text: 'src/add.sh:1 style\n' });
  givenAConvergingChange(folder);
  thenHookReplies(whenTurnEnds(folder), 0);
  givenACheckAnswers(folder, 'lint', { exit: 0 });
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # lint fixed\n');
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # once more\n');

  thenHookReplies(whenTurnEnds(folder), 0);

  thenValuesEqual(whenCheckStartsAreRead(folder), ['mutation', 'lint', 'mutation', 'lint', 'lint']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verify_failed', 'verified', 'verified']);
  const events = whenEventsAreRead(folder);
  thenObjectIncludes(mutationOf(events[3]), { status: 'ok' });
  thenObjectIncludes(mutationOf(events[4]), { status: 'reused', source: { seq: 4 } });
});
