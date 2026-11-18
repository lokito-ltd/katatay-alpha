import { expect, it } from 'vitest';
import { thenHookReplies, whenKttyRuns, thenItExits } from '../support/ktty.mjs';
import {
  planFile,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenFileIsRead,
  whenEventsAreRead,
  whenPlanIsApproved,
  whenPlanIsPresented,
  whenTurnEnds,
  messages,
  block,
} from '../support/project.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenTextMatches,
  thenContains,
  thenObjectIncludes,
  thenOmits,
  thenEventsEqual,
  thenStderrContains,
  thenEventNamesEqual,
} from '../support/assertions.mjs';

it('A complete plan passes silently, with no event and no phase change. [AC0015.1]', () => {
  const folder = givenAWorkingBranch();

  const before = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(before.stdout, /^phase\s+open$/m);

  const presentationRun = whenPlanIsPresented(folder);
  const presentation = thenHookReplies(presentationRun, 0);
  thenValuesEqual(presentation, { version: 1, needsCorrection: false, messages: [] });

  const turnEndRun = whenTurnEnds(folder, { planFile });
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenValuesEqual(turnEnd, { version: 1, keepWorking: false, messages: [] });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenValueIs(state.stdout, before.stdout);
  thenEventsEqual(folder, []);
});

it('Every template problem is listed, the agent is kept working once, and the next refused stop lets the turn end. [AC0015.2]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, 'Incomplete.');

  const resultRun = whenTurnEnds(folder, { planFile });
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.keepWorking, true);
  for (const section of ['Why', 'What', 'How', 'Requirements', 'Predicted failures', 'Test delta'])
    thenContains(messages(result), '- section ' + section + ' is missing');

  const turnEndRun = whenTurnEnds(folder, { planFile, stopRefusedBefore: true });
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenValueIs(turnEnd.keepWorking, false);
  thenEventsEqual(folder, []);
});

it('ktty on plan-presented answers with whether a correction is needed and its messages, changes no state, and exits 2 for a malformed request. [AC0015.3]', () => {
  const folder = givenAWorkingBranch();

  const presentationRun = whenPlanIsPresented(folder);
  const presentation = thenHookReplies(presentationRun, 0);
  thenObjectIncludes(presentation, { needsCorrection: false, messages: [] });
  givenFileContents(folder, planFile, 'Incomplete.');

  const incompleteRun = whenPlanIsPresented(folder);
  const incomplete = thenHookReplies(incompleteRun, 0);
  thenObjectIncludes(incomplete, { needsCorrection: true, messages: [{ code: 'refused' }] });
  for (const body of [
    '{',
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, planFile: '' }),
    JSON.stringify({ version: 2, planFile }),
  ]) {
    const run = whenKttyRuns(['on', 'plan-presented'], { in: folder, input: body });
    thenItExits(run, 2);
    thenValueIs(run.stdout, '');
    thenTextMatches(run.stderr, /^on plan-presented: (the input is not JSON|refused,)/);
    thenOmits(run.stderr, "Run 'ktty help'");
  }
  thenEventsEqual(folder, []);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(state.stdout, /^phase\s+open$/m);
});

it('With plans.validateFormat false the section checks are skipped but the workflow block checks are not, and a non-boolean value is refused. [AC0015.4]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, (book) => {
    book.plans.validateFormat = false;
  });
  givenFileContents(folder, planFile, 'No sections.');

  const presentationRun = whenPlanIsPresented(folder);
  const presentation = thenHookReplies(presentationRun, 0);
  thenObjectIncludes(presentation, { needsCorrection: false, messages: [] });
  givenFileContents(folder, planFile, 'No sections.' + block('test-only: typo'));

  const resultRun = whenPlanIsPresented(folder);
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.needsCorrection, true);
  thenContains(messages(result), 'must be true or false');
  thenOmits(messages(result), 'section Why is missing');
  givenRulebookChanges(folder, (book) => {
    book.plans.validateFormat = 'false';
  });

  const run = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(run, 1);
  thenStderrContains(run, 'plans.validateFormat');
});

it('An unreadable plan file, or one not directly in the plans folder, gives the operator a warning and blocks nothing. [AC0015.5]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'plans/nested/plan.md', completePlan);
  for (const [file, reason] of [
    ['plans/missing.md', 'cannot be read'],
    ['plans/nested/plan.md', 'not a Markdown file directly'],
  ]) {
    const resultRun = whenTurnEnds(folder, { planFile: file });
    const result = thenHookReplies(resultRun, 0);
    thenValueIs(result.keepWorking, false);
    thenValuesEqual(result.messages, [expect.objectContaining({ code: 'warning', for: 'operator' })]);
    thenContains(messages(result), reason);
  }
  thenEventsEqual(folder, []);
});

it('A plan with no sections is still recorded when the operator approves it. [AC0015.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, 'A short plan with no section headings.');

  const presentationRun = whenPlanIsPresented(folder);
  const presentation = thenHookReplies(presentationRun, 0);
  thenValueIs(presentation.needsCorrection, true);

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  thenEventNamesEqual(folder, ['plan_approved']);
});

it('An invalid presented plan does not stop the freeze check or verification at turn end. [AC0015.7]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  givenFileContents(folder, planFile, 'Invalid revision.');
  const original = whenFileIsRead(folder, 'tests/add.sh');
  givenFileContents(folder, 'tests/add.sh', original + '# changed\n');

  const freezeRun = whenTurnEnds(folder, { planFile });
  const freeze = thenHookReplies(freezeRun, 0);
  thenValueIs(freeze.keepWorking, true);
  thenValuesEqual(
    freeze.messages.map((m) => m.code),
    expect.arrayContaining(['frozen', 'refused']),
  );
  thenContains(messages(freeze), 'section Why is missing');
  thenContains(messages(freeze), 'tests/add.sh');
  thenEventNamesEqual(folder, ['plan_approved']);
  givenFileContents(folder, 'tests/add.sh', original);
  givenFileContents(folder, 'src/add.sh', 'printf "4\\n"\n');

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);

  const checkedRun = whenTurnEnds(folder, { planFile });
  const checked = thenHookReplies(checkedRun, 0);
  thenValueIs(checked.keepWorking, true);
  thenValuesEqual(
    checked.messages.map((m) => m.code),
    expect.arrayContaining(['verified', 'refused']),
    messages(checked),
  );
  thenContains(messages(checked), 'section Why is missing');
  const latest = whenEventsAreRead(folder).at(-1);
  thenValueIs(latest.event, 'verified');
  givenFileContents(folder, planFile, completePlan);
  const before = whenEventsAreRead(folder);

  const correctedRun = whenTurnEnds(folder, { planFile, stopRefusedBefore: true });
  const corrected = thenHookReplies(correctedRun, 0);
  thenValueIs(corrected.keepWorking, false);
  thenOmits(
    corrected.messages.map((m) => m.code),
    'refused',
  );
  thenEventsEqual(folder, before);
}, 60_000);
