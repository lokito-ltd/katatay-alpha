import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  block,
  completePlan,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  givenTheTargetHolds,
  givenTheTestCommandCountsItsRuns,
  planFile,
  whenAWriteIsProposed,
  whenEventsAreRead,
  whenGitRuns,
  whenHookRuns,
  whenPlanIsApproved,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenFileContains,
  thenHookAnswers,
  thenObjectIncludes,
  thenStateShowsPhase,
  thenStderrContains,
  thenValueDiffers,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';

const allowed = { allow: true, messages: [] };
const frozen = { allow: false, messages: [{ code: 'frozen', for: 'agent' }] };
const blocked = { keepWorking: true, messages: [{ code: 'frozen', for: 'agent' }] };
const testOnlyPlan = completePlan + block('test-only: true');

function givenAnApprovedPlan(folder) {
  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, true);
}

function givenATriagedChange(folder) {
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # triaged\n');
  thenItExits(whenTriageRuns(folder), 0);
}

it('Editing a test file or a support file while implementing is denied as frozen. [AC0022.1]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.tests.paths.support = ['fixtures/**']; });
  givenAnApprovedPlan(folder);

  for (const path of ['tests/add.sh', 'tests/new.sh', 'fixtures/data.json']) {
    const run = whenAWriteIsProposed(folder, [path]);

    const answer = thenHookAnswers(run, frozen);
    thenContains(answer.messages[0].text, path + ' is frozen until triage.');
  }
});

it('A turn that changed a test, in any language, is blocked at turn end and the file is named. [AC0022.2]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'tests/add.sh', 'true\n');
  givenFileContents(folder, 'tests/check.py', 'assert True\n');
  givenFileContents(folder, 'tests/check.test.ts', 'export {};\n');

  const run = whenTurnEnds(folder);

  const answer = thenHookAnswers(run, blocked);
  thenContains(answer.messages[0].text, 'These differ from the baseline:\n\n  tests/add.sh\n  tests/check.py\n  tests/check.test.ts\n');
});

it('A turn that changed a fixture matched by the support globs is blocked. [AC0022.3]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.tests.paths.support = ['fixtures/**']; });
  givenFileContents(folder, 'fixtures/data.json', '{"answer": 4}\n');
  givenTheTargetHolds(folder);
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'fixtures/data.json', '{"answer": 5}\n');

  const run = whenTurnEnds(folder);

  const answer = thenHookAnswers(run, blocked);
  thenContains(answer.messages[0].text, '  fixtures/data.json\n');
});

it('A test edited while hidden from git with skip-worktree is still caught. [AC0022.4]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);
  whenGitRuns(folder, 'update-index', '--skip-worktree', 'tests/add.sh');
  givenFileContents(folder, 'tests/add.sh', 'true\n');

  const turnEnd = whenTurnEnds(folder);
  const answer = thenHookAnswers(turnEnd, blocked);
  thenContains(answer.messages[0].text, '  tests/add.sh\n');

  const triage = whenTriageRuns(folder);
  thenItExits(triage, 1);
  thenObjectIncludes(whenEventsAreRead(folder).at(-1), { event: 'triage_refused', payload: { reason: 'tests_modified', files: ['tests/add.sh'] } });
});

it('ktty triage refuses with tests_modified and lists the files that differ from the baseline. [AC0022.5]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'tests/add.sh', 'true\n');
  givenFileContents(folder, 'tests/more.sh', 'true\n');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'These differ from the baseline:\n  tests/add.sh\n  tests/more.sh\n');
  thenValuesEqual(whenEventsAreRead(folder).at(-1).payload, { reason: 'tests_modified', files: ['tests/add.sh', 'tests/more.sh'] });
});

it('Tests the target gained after the baseline, and merged in, are not this change\'s. [AC0022.6]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);
  whenGitRuns(folder, 'add', '-A');
  whenGitRuns(folder, 'commit', '-qm', 'Logbook');
  whenGitRuns(folder, 'switch', '-q', '-c', 'elsewhere', 'origin/main');
  givenFileContents(folder, 'tests/other.sh', 'true\n');
  givenTheTargetHolds(folder, 'Another test');
  whenGitRuns(folder, 'switch', '-q', 'work');
  whenGitRuns(folder, 'merge', '-q', '--no-edit', 'origin/main');

  const prompt = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'Carry on.' }), 0);
  thenContains(prompt.messages[0].text, 'The target was merged into this branch, so the baseline moved forward');

  const turnEnd = whenTurnEnds(folder);
  thenHookAnswers(turnEnd, { keepWorking: false, messages: [{ code: 'run_triage' }] });
  thenEventNamesEqual(folder, ['plan_approved', 'baseline_moved']);
});

it('A test-only plan does not lift the freeze, and a revised plan puts it back. [AC0022.7]', () => {
  const testOnly = givenAWorkingBranch();
  givenFileContents(testOnly, planFile, testOnlyPlan);
  givenAnApprovedPlan(testOnly);

  thenHookAnswers(whenAWriteIsProposed(testOnly, ['tests/add.sh']), frozen);

  const revised = givenAWorkingBranch();
  givenATriagedChange(revised);
  thenHookAnswers(whenAWriteIsProposed(revised, ['tests/add.sh']), allowed);
  givenFileContents(revised, planFile, completePlan + 'Revised.\n');
  givenAnApprovedPlan(revised);

  thenHookAnswers(whenAWriteIsProposed(revised, ['tests/add.sh']), frozen);
});

it('After triage, editing an implementation file is denied as frozen, and the agent is told to present a revised plan. [AC0023.1]', () => {
  const folder = givenAWorkingBranch();
  givenATriagedChange(folder);

  for (const path of ['src/add.sh', 'src/new.sh']) {
    const run = whenAWriteIsProposed(folder, [path]);

    const answer = thenHookAnswers(run, frozen);
    thenContains(answer.messages[0].text, 'To change it, present a revised plan for approval.');
  }
});

it('After triage, tests, change files and git-ignored files may be written. [AC0023.2]', () => {
  const folder = givenAWorkingBranch();
  givenATriagedChange(folder);

  for (const path of ['tests/add.sh', 'tests/new.sh', 'requirements/changes/20261113T000000.000Z__x.md', 'reports/notes.txt']) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, allowed);
  }
});

it('An implementation changed by other means makes ktty state show say to restore it, and the turn end and record refuse. [AC0023.3]', () => {
  const folder = givenAWorkingBranch();
  givenATriagedChange(folder);
  const history = whenEventsAreRead(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # drifted\n');
  const restore = 'The implementation changed after triage. Restore the triaged implementation or approve a revised plan and triage it again.';

  const state = whenStateIsShown(folder);
  thenStateShowsPhase(state, 'converging');
  thenContains(state.stdout, 'next       ' + restore);

  const turnEnd = whenTurnEnds(folder);
  thenHookAnswers(turnEnd, { keepWorking: true, messages: [{ code: 'stop', for: 'operator', text: restore }] });

  const record = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);
  thenObjectIncludes(record.messages[0], { code: 'not_declared', for: 'operator', text: restore });
  thenValuesEqual(whenEventsAreRead(folder), history);
});

it('ktty triage on a changed implementation refuses with implementation_changed, without running the suite. [AC0023.4]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenATriagedChange(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # drifted\n');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'The implementation changed after triage.');
  thenValuesEqual(whenEventsAreRead(folder).at(-1).payload, { reason: 'implementation_changed' });
  thenFileContains(folder, marker, 'start\n');
});

it('Restoring the triaged bytes lets the change verify again. [AC0023.5]', () => {
  const folder = givenAWorkingBranch();
  givenATriagedChange(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # drifted\n');
  thenHookReplies(whenTurnEnds(folder), 0);

  givenFileContents(folder, 'src/add.sh', 'echo 4 # triaged\n');
  const run = whenTurnEnds(folder);

  const answer = thenHookReplies(run, 0);
  thenContains(answer.messages.map(message => message.code), 'verified');
  thenStateShowsPhase(whenStateIsShown(folder), 'verified');
});

it('A revised plan lifts the implementation freeze, and its triage records a new fingerprint. [AC0023.6]', () => {
  const folder = givenAWorkingBranch();
  givenATriagedChange(folder);
  const first = whenEventsAreRead(folder).at(-1).payload.implementationFingerprint;
  givenFileContents(folder, planFile, completePlan + 'Revised.\n');
  givenAnApprovedPlan(folder);

  thenHookAnswers(whenAWriteIsProposed(folder, ['src/add.sh']), allowed);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # revised\n');
  thenItExits(whenTriageRuns(folder), 0);

  const second = whenEventsAreRead(folder).at(-1);
  thenValueIs(second.event, 'triaged');
  thenValueDiffers(second.payload.implementationFingerprint, first);
  thenHookAnswers(whenAWriteIsProposed(folder, ['src/add.sh']), frozen);
});

it('A test-only change\'s implementation is frozen at its triage too. [AC0023.7]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, planFile, testOnlyPlan);
  givenAnApprovedPlan(folder);
  thenItExits(whenTriageRuns(folder), 0);

  thenHookAnswers(whenAWriteIsProposed(folder, ['tests/add.sh']), allowed);
  thenHookAnswers(whenAWriteIsProposed(folder, ['src/add.sh']), frozen);

  givenFileContents(folder, 'src/add.sh', 'echo 4 # changed\n');
  const run = whenTriageRuns(folder);
  thenItExits(run, 1);
  thenValuesEqual(whenEventsAreRead(folder).at(-1).payload, { reason: 'implementation_changed' });
});
