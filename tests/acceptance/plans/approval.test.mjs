import { expect, it } from 'vitest';
import { thenHookReplies, whenKttyRuns, thenItExits } from '../support/ktty.mjs';
import {
  rulebookPath,
  planFile,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  whenGitRuns,
  whenFileIsRead,
  whenFileIsRemoved,
  whenHookRuns,
  whenEventsAreRead,
  whenPlanIsApproved,
  whenTurnEnds,
  messages,
  block,
} from '../support/project.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenTextMatches,
  thenContains,
  thenLengthIs,
  thenObjectIncludes,
  thenValueDiffers,
  thenEventsEqual,
  thenPathsExist,
  thenFileContains,
  thenStdoutContains,
} from '../support/assertions.mjs';
import { createHash } from 'node:crypto';

it('A plan that opens with frontmatter is refused, saying its declarations go in a closing workflow block. [AC0013.1]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, '---\ntest-only: true\n---\n' + completePlan);

  const refusalRun = whenPlanIsApproved(folder);
  const refusal = thenHookReplies(refusalRun, 0);
  thenValueIs(refusal.recorded, false);
  thenValueIs(refusal.messages[0].for, 'operator');
  thenTextMatches(messages(refusal), /frontmatter.*declarations go in a .*workflow.* block at its end/);
  thenEventsEqual(folder, []);
});

it('A workflow block that is not last, a second workflow block, or one never closed is refused. [AC0013.2]', () => {
  const folder = givenAWorkingBranch();
  const declaration = block('test-only: true');
  for (const tail of [
    declaration + 'more text',
    declaration + declaration,
    '\n```workflow\ntest-only: true',
  ]) {
    givenFileContents(folder, planFile, completePlan + tail);

    const refusalRun = whenPlanIsApproved(folder);
    const refusal = thenHookReplies(refusalRun, 0);
    thenValueIs(refusal.recorded, false);
    thenValueIs(refusal.messages[0].for, 'operator');
    thenTextMatches(messages(refusal), /last thing in the file, closed by its own fence/);
    thenEventsEqual(folder, []);
  }
});

it('A plan with no text besides its workflow block is refused. [AC0013.3]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, block('test-only: true'));

  const refusalRun = whenPlanIsApproved(folder);
  const refusal = thenHookReplies(refusalRun, 0);
  thenValueIs(refusal.recorded, false);
  thenValueIs(refusal.messages[0].for, 'operator');
  thenTextMatches(messages(refusal), /no text besides its .*workflow.* block/);
  thenEventsEqual(folder, []);
});

it('A plan approved on the target branch is refused, and no logbook folder is created. [AC0013.4]', () => {
  const folder = givenAWorkingBranch();
  whenGitRuns(folder, 'switch', 'main');

  const refusalRun = whenPlanIsApproved(folder);
  const refusal = thenHookReplies(refusalRun, 0);
  thenValueIs(refusal.recorded, false);
  thenValueIs(refusal.messages[0].for, 'operator');
  thenTextMatches(messages(refusal), /not recorded: this is main/);
  thenPathsExist(folder, ['.katatay/state/main'], false);
});

it('A second plan on a branch whose change is recorded is refused, the logbook is untouched, and the operator is told to merge or reset. [AC0013.5]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  givenFileContents(folder, 'src/add.sh', 'printf "4\\n"\n');

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);

  const verificationRun = whenTurnEnds(folder);
  const verification = thenHookReplies(verificationRun, 0);
  thenContains(
    verification.messages.map((m) => m.code),
    'verified',
    messages(verification),
  );

  const declarationRun = whenHookRuns(folder, 'prompt', { prompt: 'record' });
  const declaration = thenHookReplies(declarationRun, 0);
  const declared = whenEventsAreRead(folder).at(-1);
  thenValueIs(declared.event, 'declared', messages(declaration));
  givenFileContents(
    folder,
    'requirements/changes/20261113T000000.000Z__example.md',
    [
      '---',
      '---',
      '',
      '# Example',
      '',
      '## Report',
      '',
      '```text',
      ...declared.payload.summary,
      '```',
      '',
      '## Departures',
      '',
      'None.',
      '',
    ].join('\n'),
  );

  const resultRun = whenTurnEnds(folder);
  const result = thenHookReplies(resultRun, 0);
  const before = whenEventsAreRead(folder);
  thenValueIs(before.at(-1).event, 'recorded', messages(result));
  givenFileContents(folder, planFile, completePlan + 'Second change.\n');

  const refusalRun = whenPlanIsApproved(folder);
  const refusal = thenHookReplies(refusalRun, 0);
  thenValueIs(refusal.recorded, false);
  thenValueIs(refusal.messages[0].for, 'operator');
  thenTextMatches(messages(refusal), /already holds a recorded change[\s\S]*Merge it first[\s\S]*reset/);
  thenEventsEqual(folder, before);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(state.stdout, /^phase\s+recorded$/m);
}, 60_000);

it('A plan file that is missing, not Markdown, or not directly in the plans folder stops for the operator. [AC0013.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'plans/draft.txt', completePlan);
  givenFileContents(folder, 'plans/deeper/draft.md', completePlan);
  for (const [file, reason] of [
    ['plans/missing.md', 'cannot be read'],
    ['plans/draft.txt', 'not a Markdown file directly'],
    ['plans/deeper/draft.md', 'not a Markdown file directly'],
  ]) {
    const answerRun = whenPlanIsApproved(folder, file);
    const answer = thenHookReplies(answerRun, 0);
    thenObjectIncludes(answer, { recorded: false, messages: [{ code: 'stop', for: 'operator' }] });
    thenContains(messages(answer), reason);
    thenEventsEqual(folder, []);
  }
});

it('A broken logbook, a branch with no commit, or no baseline to pin records nothing. [AC0013.7]', () => {
  const broken = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(broken);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const [first] = whenEventsAreRead(broken);
  givenFileContents(
    broken,
    '.katatay/state/work/0001__plan_approved.json',
    JSON.stringify({ ...first, seq: 9 }),
  );
  const before = whenEventsAreRead(broken);

  const refusalRun = whenPlanIsApproved(broken);
  const refusal = thenHookReplies(refusalRun, 0);
  thenValueIs(refusal.recorded, false);
  thenValueIs(refusal.messages[0].for, 'operator');
  thenTextMatches(messages(refusal), /chain is broken/);
  thenEventsEqual(broken, before);

  const unborn = givenAWorkingBranch();
  const rulebook = whenFileIsRead(unborn, rulebookPath);
  whenGitRuns(unborn, 'switch', '--orphan', 'unborn');
  givenFileContents(unborn, rulebookPath, rulebook);

  const state = whenKttyRuns(['state', 'show'], { in: unborn });
  thenStdoutContains(state, 'no commit yet');

  const unbornRefusalRun = whenPlanIsApproved(unborn);
  const unbornRefusal = thenHookReplies(unbornRefusalRun, 0);
  thenValueIs(unbornRefusal.recorded, false);
  thenValueIs(unbornRefusal.messages[0].for, 'operator');
  thenTextMatches(messages(unbornRefusal), /no baseline/);
  thenEventsEqual(unborn, [], 'unborn');

  const unavailable = givenAWorkingBranch();
  whenGitRuns(unavailable, 'remote', 'set-url', 'origin', '../unavailable.git');
  whenGitRuns(unavailable, 'update-ref', '-d', 'refs/remotes/origin/main');

  const unavailableRefusalRun = whenPlanIsApproved(unavailable);
  const unavailableRefusal = thenHookReplies(unavailableRefusalRun, 0);
  thenValueIs(unavailableRefusal.recorded, false);
  thenValueIs(unavailableRefusal.messages[0].for, 'operator');
  thenTextMatches(messages(unavailableRefusal), /never been fetched and the server did not answer/);
  thenEventsEqual(unavailable, []);
});

const declarations =
  'test-only: true\nrequirement-changes:\n  - {id: AC0001, status: active, statement: First.}\n  - {id: INV0001, status: active, statement: Second.}\npredicted-failures: ["tests/add.sh::adds"]';

it('The event holds the proposal hash, the test-only flag, the requirement changes, the plan snapshot and the baseline, and no plan file path. [AC0014.1]', () => {
  const folder = givenAWorkingBranch();
  const bytes = Buffer.from((completePlan + block(declarations)).replaceAll('\n', '\r\n'));
  givenFileContents(folder, planFile, bytes);

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const log = whenEventsAreRead(folder);
  thenLengthIs(log, 1);
  const event = log[0];
  thenObjectIncludes(event, { seq: 1, event: 'plan_approved', branch: 'work', prev: null });
  const snapshot = whenFileIsRead(folder, event.payload.planSnapshot, null);
  thenValuesEqual(snapshot, bytes);
  const baseline = whenGitRuns(folder, 'rev-parse', 'origin/main');
  thenValuesEqual(event.payload, {
    proposal: createHash('sha256').update(bytes).digest('hex'),
    testOnly: true,
    requirementChanges: [
      { id: 'AC0001', status: 'active', statement: 'First.', scenarios: [] },
      { id: 'INV0001', status: 'active', statement: 'Second.', scenarios: [] },
    ],
    baseline,
    planSnapshot: expect.stringMatching(
      /^\.katatay\/local\/work\/plans\/\d{8}T\d{6}\.\d{3}Z_[\w-]{43}\.md$/,
    ),
  });
});

it('The plan is read from the file, never from the request. [AC0014.2]', () => {
  const folder = givenAWorkingBranch();
  const file = completePlan + block('test-only: true');
  givenFileContents(folder, planFile, file);

  const resultRun = whenHookRuns(folder, 'plan-approved', { planFile, plan: completePlan, testOnly: false });
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.recorded, true);
  const { testOnly, planSnapshot } = whenEventsAreRead(folder)[0].payload;
  thenValueIs(testOnly, true);
  thenFileContains(folder, planSnapshot, file);
});

it('Approving identical bytes again, even from another file, appends nothing and keeps the phase. [AC0014.3]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);
  const before = whenEventsAreRead(folder);
  givenFileContents(folder, 'plans/copy.md', completePlan);
  for (const name of [planFile, 'plans/copy.md']) {
    const resultRun = whenPlanIsApproved(folder, name);
    const result = thenHookReplies(resultRun, 0);
    thenValueIs(result.recorded, false);
    thenContains(messages(result), 'already approved');
    thenEventsEqual(folder, before);

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenTextMatches(state.stdout, /^phase\s+converging$/m);
  }
});

it('A revised plan replaces the earlier one, keeps the baseline, and sends the change back to implementing. [AC0014.4]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  const first = whenEventsAreRead(folder)[0].payload;

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);
  givenFileContents(folder, 'tests/new.sh', 'exit 0\n');

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(state.stdout, /^phase\s+converging$/m);
  givenFileContents(folder, planFile, completePlan + 'Revised.\n');

  const resultRun = whenPlanIsApproved(folder);
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.recorded, true);
  thenContains(messages(result), 'back to implementing');
  const revised = whenEventsAreRead(folder).at(-1).payload;
  thenValueIs(revised.baseline, first.baseline);
  thenValueDiffers(revised.proposal, first.proposal);

  const afterRevision = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(afterRevision.stdout, /^phase\s+implementing$/m);

  const stoppedRun = whenTurnEnds(folder);
  const stopped = thenHookReplies(stoppedRun, 0);
  thenValueIs(stopped.keepWorking, true);
  thenContains(messages(stopped), 'tests/new.sh');
});

it('The snapshot stays authoritative after the working plan file is edited or removed. [AC0014.5]', () => {
  for (const [action, newline] of [
    ['edit', '\n'],
    ['remove', '\r\n'],
  ]) {
    const folder = givenAWorkingBranch();
    const original = (completePlan + block('predicted-failures: ["tests/add.sh::adds"]')).replaceAll(
      '\n',
      newline,
    );
    givenFileContents(folder, planFile, original);

    const approvalRun = whenPlanIsApproved(folder);
    const approval = thenHookReplies(approvalRun, 0);
    thenValueIs(approval.recorded, true);
    const snapshot = whenEventsAreRead(folder)[0].payload.planSnapshot;
    if (action === 'edit') givenFileContents(folder, planFile, completePlan);
    else whenFileIsRemoved(folder, planFile);
    thenFileContains(folder, snapshot, original);

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenStdoutContains(state, snapshot);
    givenFileContents(folder, 'src/add.sh', 'echo 5\n');

    const run = whenKttyRuns(['triage'], { in: folder });
    thenItExits(run, 0);
    thenStdoutContains(run, 'predicted 1/1 failed');
    thenTextMatches(run.stdout, /0 surprise/i);
  }
});

it('The approval message names a test-only declaration and the approved requirement ids, and a test-only approval says to run triage first. [AC0014.6]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, completePlan + block(declarations));

  const resultRun = whenPlanIsApproved(folder);
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.recorded, true);
  thenContains(messages(result), 'AC0001, INV0001');
  thenTextMatches(
    result.messages.find((m) => m.code === 'run_triage').text,
    /test-only.*triage.*now, before writing anything/i,
  );
});

it('A first approval warns the operator when the branch already changes files the target lacks. [AC0014.7]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'src/add.sh', 'printf 4\n');
  whenGitRuns(folder, 'commit', '-qam', 'Inherited implementation');

  const resultRun = whenPlanIsApproved(folder);
  const result = thenHookReplies(resultRun, 0);
  thenValueIs(result.recorded, true);
  thenContains(
    result.messages.find((m) => m.for === 'operator' && m.code === 'warning').text,
    'already changes 1 file(s) that are not on origin/main: src/add.sh',
  );
});
