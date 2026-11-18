import { expect, it } from 'vitest';
import { thenHookReplies, whenKttyRuns, thenItExits } from '../support/ktty.mjs';
import {
  planFile,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenFileIsRead,
  whenHookRuns,
  whenEventsAreRead,
  whenPlanIsApproved,
  whenTurnEnds,
  messages,
} from '../support/project.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenTextMatches,
  thenContains,
  thenObjectIncludes,
  thenContainsEntry,
  thenEventsEqual,
  thenFileContains,
  thenStdoutContains,
  thenEventNamesEqual,
} from '../support/assertions.mjs';

it('One revision request defers turn-end verification throughout the planning conversation. [AC0030.8]', () => {
  const folder = givenAWorkingBranch();
  const marker = 'reports/test-command-starts';
  givenRulebookChanges(folder, (book) => {
    book.tests.run.command = 'mkdir -p reports && echo start >> ' + marker + ' && sh run-tests.sh';
  });

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);
  const afterTriage = whenFileIsRead(folder, marker);
  thenValueIs(afterTriage, 'start\n');

  const revision = whenKttyRuns(['replan'], { in: folder });
  thenItExits(revision, 0);
  const history = whenEventsAreRead(folder);
  thenObjectIncludes(history.at(-1), { event: 'replan_requested', payload: { approval: history[0].seq } });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenStdoutContains(state, 'A plan revision is pending');

  const hookRun = whenHookRuns(folder, 'prompt', { prompt: 'Another draft, please.' });
  const hookReply = thenHookReplies(hookRun, 0);
  thenContains(messages(hookReply), 'A plan revision is pending');

  const turnEndRun = whenTurnEnds(folder);
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenContainsEntry(turnEnd.messages, expect.objectContaining({ code: 'triaged', for: 'operator' }));

  givenFileContents(folder, planFile, 'Incomplete draft.');

  const draftRun = whenTurnEnds(folder, { planFile });
  const draft = thenHookReplies(draftRun, 0);
  thenValueIs(draft.keepWorking, true);

  const repeatedStopRun = whenTurnEnds(folder, { planFile, stopRefusedBefore: true });
  const repeatedStop = thenHookReplies(repeatedStopRun, 0);
  thenValueIs(repeatedStop.keepWorking, false);
  givenFileContents(folder, planFile, completePlan);

  const correctedRun = whenTurnEnds(folder, { planFile });
  const corrected = thenHookReplies(correctedRun, 0);
  thenValueIs(corrected.keepWorking, false);

  const repeatRequest = whenKttyRuns(['replan'], { in: folder });
  thenItExits(repeatRequest, 0);
  for (const adapter of ['claude', 'codex']) {
    const input = {
      cwd: folder.cwd,
      stop_hook_active: true,
      turn_id: 'revision',
      last_assistant_message: 'Discuss the revision.',
      transcript_path: folder.cwd + '/transcript.jsonl',
    };

    const run = whenKttyRuns(['agent', adapter, 'turn-end'], { in: folder, input: JSON.stringify(input) });
    const answer = thenHookReplies(run, 0);
    thenContains(answer.systemMessage, 'A plan revision is pending');
    thenValueIs(answer.decision, undefined);
  }

  const run = whenKttyRuns(['verify', '--rerun'], { in: folder });
  thenItExits(run, 2);

  const recordRun = whenHookRuns(folder, 'prompt', { prompt: 'record' });
  const declaration = thenHookReplies(recordRun, 0);
  thenObjectIncludes(declaration.messages[0], { code: 'not_declared', for: 'operator' });
  thenEventsEqual(folder, history);
  thenFileContains(folder, marker, afterTriage);

  const resume = whenKttyRuns(['replan', '--resume'], { in: folder });
  thenItExits(resume, 0);

  const verificationRun = whenTurnEnds(folder);
  const verification = thenHookReplies(verificationRun, 0);
  thenContains(
    verification.messages.map((message) => message.code),
    'verified',
  );
  thenFileContains(folder, marker, afterTriage + 'start\n');
});

it('When the operator rejects the revision and chooses the original plan, work resumes from its existing phase. [AC0030.9]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);

  const revision = whenKttyRuns(['replan'], { in: folder });
  thenItExits(revision, 0);
  const request = whenEventsAreRead(folder).at(-1);

  const resume = whenKttyRuns(['replan', '--resume'], { in: folder });
  thenItExits(resume, 0);

  const repeatResume = whenKttyRuns(['replan', '--resume'], { in: folder });
  thenItExits(repeatResume, 0);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'replan_requested', 'replan_resumed']);
  const resumed = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(resumed.payload, { request: request.seq });

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(state.stdout, /^phase\s+converging$/m);

  const turnEndRun = whenTurnEnds(folder);
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenContains(
    turnEnd.messages.map((m) => m.code),
    'verified',
  );
});

it('Approving a changed plan ends the revision request and returns the change to implementing. [AC0030.10]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);

  const revision = whenKttyRuns(['replan'], { in: folder });
  thenItExits(revision, 0);
  const original = whenEventsAreRead(folder);

  const identicalRun = whenPlanIsApproved(folder);
  const identical = thenHookReplies(identicalRun, 0);
  thenValueIs(identical.recorded, false);
  thenEventsEqual(folder, original);

  const turnEndRun = whenTurnEnds(folder);
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenContains(messages(turnEnd), 'A plan revision is pending');
  givenFileContents(folder, planFile, completePlan + 'Fix the implementation.\n');

  const revisedRun = whenPlanIsApproved(folder);
  const revised = thenHookReplies(revisedRun, 0);
  thenValueIs(revised.recorded, true);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'replan_requested', 'plan_approved']);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenTextMatches(state.stdout, /^phase\s+implementing$/m);

  const beforeTriageRun = whenTurnEnds(folder);
  const beforeTriage = thenHookReplies(beforeTriageRun, 0);
  thenValuesEqual(
    beforeTriage.messages.map((m) => m.code),
    ['run_triage'],
  );

  const freshTriage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(freshTriage, 0);

  const verificationRun = whenTurnEnds(folder);
  const verification = thenHookReplies(verificationRun, 0);
  thenContains(
    verification.messages.map((m) => m.code),
    'verified',
  );
});

it('A revision request after recording tells the agent and operator to merge or reset first, even after an edit returns the change to converging. [AC0030.11]', () => {
  const folder = givenAWorkingBranch();

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);

  const triage = whenKttyRuns(['triage'], { in: folder });
  thenItExits(triage, 0);

  const turnEndRun = whenTurnEnds(folder);
  const turnEnd = thenHookReplies(turnEndRun, 0);
  thenContains(
    turnEnd.messages.map((m) => m.code),
    'verified',
  );

  const declarationRun = whenHookRuns(folder, 'prompt', { prompt: 'record' });
  const declaration = thenHookReplies(declarationRun, 0);
  thenValueIs(declaration.messages[0].code, 'declared', messages(declaration));
  const summary = whenEventsAreRead(folder).at(-1).payload.summary;
  givenFileContents(
    folder,
    'requirements/changes/20261113T000000.000Z__revision.md',
    [
      '---',
      '---',
      '',
      '# Revision',
      '',
      '## Report',
      '',
      '```text',
      ...summary,
      '```',
      '',
      '## Departures',
      '',
      'None.',
      '',
    ].join('\n'),
  );

  const recordingRun = whenTurnEnds(folder);
  const recording = thenHookReplies(recordingRun, 0);
  thenContains(
    recording.messages.map((m) => m.code),
    'recorded',
  );
  const history = whenEventsAreRead(folder);
  for (const phase of ['recorded', 'converging']) {
    if (phase === 'converging') givenFileContents(folder, 'tests/add.sh', 'exit 0\n');

    const state = whenKttyRuns(['state', 'show'], { in: folder });
    thenTextMatches(state.stdout, new RegExp('^phase\\s+' + phase + '$', 'm'));

    const refused = whenKttyRuns(['replan'], { in: folder });
    thenItExits(refused, 2);
    thenTextMatches(
      refused.stderr,
      /For the operator:.*recorded change.*Merge it first.*operator type `reset`/,
    );
    thenEventsEqual(folder, history);
  }
});
