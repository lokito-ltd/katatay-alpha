import { it } from 'vitest';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { thenHookReplies, thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import {
  block,
  completePlan,
  givenAPlanPredicting,
  givenAPublishedSuite,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  givenTheSuiteReports,
  givenTheTargetHolds,
  givenTheTestCommandCountsItsRuns,
  planFile,
  whenAWriteIsProposed,
  whenEventsAreRead,
  whenFileIsRead,
  whenFileIsRemoved,
  whenPlanIsApproved,
  whenRiskIsAssessed,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventsEqual,
  thenFileContains,
  thenHookAnswers,
  thenObjectIncludes,
  thenOmits,
  thenPathsExist,
  thenStateShowsPhase,
  thenStderrContains,
  thenStdoutContains,
  thenTextMatches,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';

const title = "Triage of plan's missed predictions and test regressions.";
const unchecked = 'not checked: compile (the adapter says "none" in .katatay/rulebook.json): a test that runs green while it would not compile counts as passing';
const compile = {
  command: 'sh compile.sh',
  pattern: '^(?<file>\\S.*?)\\((?<line>\\d+),\\d+\\): error (?<message>TS\\d+: .*)$',
  exitCodes: { 0: 'clean', 1: 'errors' },
};

function givenAnApprovedPlan(folder) {
  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, true);
}

function givenABreakingChange(folder) {
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');
}

// A compile step that reports every source or test file holding BAD.
function givenACompileStep(folder) {
  givenFileContents(folder, 'compile.sh',
    'grep -l BAD src/* tests/* | while read f; do echo "$f(1,1): error TS1: bad"; done | grep . && exit 1; exit 0\n');
  givenRulebookChanges(folder, book => { book.code.compile = compile; });
}

const cases = (file, names, fails = false) => names.map(name => ({ file, name, fails }));
const latest = folder => whenEventsAreRead(folder).at(-1);

it('A successful triage appends triaged with the tree and implementation fingerprints, the level, its reasons, the counts and the snapshot evidence. [AC0024.1]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);

  thenItExits(whenTriageRuns(folder), 0);

  const event = latest(folder);
  thenObjectIncludes(event, {
    seq: 2, event: 'triaged',
    payload: {
      level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.'],
      implemented: true, testCount: 1,
      predicted: { failed: 0, total: 0 }, surprise: { failed: 1, total: 1 },
      overPredicted: { count: 0, total: 0 }, notRun: { predicted: 0, unpredicted: 0 },
    },
  });
  thenTextMatches(event.payload.treeFingerprint, /^[a-f0-9]{64}$/);
  thenTextMatches(event.payload.implementationFingerprint, /^[a-f0-9]{64}$/);
  thenValuesEqual(event.payload.evidence.map(item => [item.role, item.title]), [['raw', 'JUnit: reports/junit.xml'], ['analysis', 'Triage analysis']]);
  thenPathsExist(folder, event.payload.evidence.map(item => item.snapshot), true);
  thenValueIs(whenFileIsRead(folder, event.payload.evidence[0].snapshot), whenFileIsRead(folder, 'reports/junit.xml'));
});

it('A triage that finds HIGH risk still exits 0. [AC0024.2]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'Risk: HIGH\n');
  thenValueIs(latest(folder).payload.level, 'HIGH');
});

it('The output starts with what the level measures, then the level, the counts, the named lists and the event link, then notes for the agent. [AC0024.3]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);

  const run = whenTriageRuns(folder);

  thenItPrintsLines(run, [
    title,
    '',
    'Risk: HIGH',
    'Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.',
    '1 test ran, 1 failed',
    'predicted 0/0 failed · 1 surprise (0%) · 0 over-predictions (0%)',
    '',
    unchecked,
    '',
    'Surprises:',
    'tests/add.sh — adds',
    '',
    'Details: .katatay/state/work/0002__triaged.json',
    '',
    'For the agent, not part of the report:',
    'Next: start with the surprises: they are the part of the change the plan did not predict.',
    'Tests are editable. The implementation is frozen at this triage.',
  ]);
});

it('A triage of a tree with no implementation records that and says so in its title. [AC0024.4]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  const [first, second] = run.stdout.split('\n');
  thenValueIs(first, "Triage of plan's missed predictions and test regressions, on a tree with no implementation in it.");
  thenValueIs(second, "The counts below are the suite's, not this change's.");
  thenValueIs(latest(folder).payload.implemented, false);
});

it('After triage the phase is converging and tests may be edited. [AC0024.5]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);

  thenItExits(whenTriageRuns(folder), 0);

  thenStateShowsPhase(whenStateIsShown(folder), 'converging');
  thenHookAnswers(whenAWriteIsProposed(folder, ['tests/add.sh']), { allow: true, messages: [] });
});

it('The next turn end puts the triage report in front of the operator, ending at its Details link. [AC0024.6]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  const triage = whenTriageRuns(folder);
  thenItExits(triage, 0);

  const run = whenTurnEnds(folder);

  const answer = thenHookReplies(run, 0);
  const report = answer.messages.find(message => message.code === 'triaged');
  thenObjectIncludes(report, { for: 'operator' });
  const printed = triage.stdout.slice(0, triage.stdout.indexOf('\n\nFor the agent'));
  thenValueIs(report.text, printed);
  thenTextMatches(report.text, /\nDetails: \.katatay\/state\/work\/0002__triaged\.json$/);
});

it('ktty state show shows the risk level and its reasons. [AC0024.7]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  thenItExits(whenTriageRuns(folder), 0);

  const run = whenStateIsShown(folder);

  thenStdoutContains(run, [
    ". Its counts are the suite's as it stood then.",
    '           ' + title,
    '',
    '           Risk: HIGH',
    '           Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.',
    '           1 test ran, 1 failed',
    '           predicted 0/0 failed · 1 surprise (0%) · 0 over-predictions (0%)',
    '',
    '           ' + unchecked,
    '',
    '           Surprises:',
    '           tests/add.sh — adds',
    '',
    '           Details: .katatay/state/work/0002__triaged.json',
    '',
  ].join('\n'));
});

it('The report names each failing invariant test and each predicted test file that never ran, each in a list of its own. [AC0024.8]', () => {
  const folder = givenAWorkingBranch();
  const suite = [...cases('acceptance/inv.sh', ['Holds. [INV0001]']), { file: 'tests/gone.sh', name: 'gone', missing: true }];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['acceptance/inv.sh', 'tests/gone.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: !item.missing })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, [
    'Risk: HIGH',
    'Raised to HIGH by failing invariants, named below.',
    '2 tests ran, 2 failed',
    'predicted 2/2 failed · 0 surprises (0%) · 0 over-predictions (0%)',
    '',
    unchecked,
    '',
    'Failing invariants:',
    'acceptance/inv.sh — Holds. [INV0001]',
    '',
    'Predicted files that never ran:',
    'tests/gone.sh',
    '',
    'Details: .katatay/state/work/0002__triaged.json',
  ].join('\n'));
});

it('Tests or support files that differ from the baseline give tests_modified with the files, before the suite runs. [AC0025.1]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.tests.paths.support = ['fixtures/**']; });
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'tests/add.sh', 'true\n');
  givenFileContents(folder, 'fixtures/data.json', '{}\n');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenValuesEqual(latest(folder).payload, { reason: 'tests_modified', files: ['fixtures/data.json', 'tests/add.sh'] });
  thenPathsExist(folder, [marker], false);
});

it('An implementation that changed since the last triage gives implementation_changed. [AC0025.2]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  thenItExits(whenTriageRuns(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo 6\n');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'Triage refused.',
    '',
    'The implementation changed after triage. Restore the triaged implementation or approve a revised plan and triage it again.',
    '',
    'Details: .katatay/state/work/0003__triage_refused.json',
  ]);
  thenValuesEqual(latest(folder).payload, { reason: 'implementation_changed' });
});

it('An implementation that does not compile gives typecheck_failed with the files, and compile errors in tests count as failing tests. [AC0025.3]', () => {
  const source = givenAWorkingBranch();
  givenACompileStep(source);
  givenTheTargetHolds(source);
  givenAnApprovedPlan(source);
  givenFileContents(source, 'src/add.sh', 'echo 4 # BAD\n');

  const refused = whenTriageRuns(source);
  thenItExits(refused, 1);
  thenStderrContains(refused, '  src/add.sh:1 TS1: bad\n');
  thenValuesEqual(latest(source).payload, { reason: 'typecheck_failed', files: ['src/add.sh'] });

  const tests = givenAWorkingBranch();
  givenACompileStep(tests);
  givenFileContents(tests, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # BAD\n');
  givenTheTargetHolds(tests);
  givenAnApprovedPlan(tests);
  givenFileContents(tests, 'src/add.sh', 'echo 4 # changed\n');

  const triaged = whenTriageRuns(tests);
  thenItExits(triaged, 0);
  thenStdoutContains(triaged, 'Surprises:\ntests/add.sh — adds\n');
  thenObjectIncludes(latest(tests), { event: 'triaged', payload: { surprise: { failed: 1, total: 1 } } });
});

it('Test reports that cannot be read give invalid_test_run, and the raw reports are kept. [AC0025.4]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.tests.run.command = 'mkdir -p reports && echo "<testsuites><testcase" > reports/junit.xml'; });
  givenABreakingChange(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'test run: a test report could not be read: reports/junit.xml:2:');
  const { payload } = latest(folder);
  thenObjectIncludes(payload, { reason: 'invalid_test_run', evidence: [{ role: 'raw', title: 'JUnit: reports/junit.xml' }] });
  thenValueIs(whenFileIsRead(folder, payload.evidence[0].snapshot), '<testsuites><testcase\n');
});

it('A tree or approval that changed during the run gives measurement_changed. [AC0025.5]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.tests.run.command = 'sh run-tests.sh; echo "# during the run" >> src/add.sh'; });
  givenABreakingChange(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'Triage refused.',
    '',
    'The working tree or approval changed during the run.',
    '',
    'Run triage again.',
    '',
    'Details: .katatay/state/work/0002__triage_refused.json',
  ]);
  thenObjectIncludes(latest(folder).payload, { reason: 'measurement_changed', evidence: [{ role: 'raw' }] });
});

it('A triage snapshot that cannot be saved gives snapshot_failed, and the test reports are kept. [AC0025.6]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  givenFileContents(folder, '.katatay/local/work/triage', 'not a folder');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'Could not publish the triage snapshot: EEXIST');
  const { payload } = latest(folder);
  thenObjectIncludes(payload, { reason: 'snapshot_failed', evidence: [{ role: 'raw', title: 'JUnit: reports/junit.xml' }] });
  thenValueIs(whenFileIsRead(folder, payload.evidence[0].snapshot), whenFileIsRead(folder, 'reports/junit.xml'));
});

it('A test-only change whose suite is not green gives suite_not_green with the failures. [AC0025.7]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');
  givenTheTargetHolds(folder);
  givenFileContents(folder, planFile, completePlan + block('test-only: true'));
  givenAnApprovedPlan(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'This change is declared test-only, and the suite is not green:\n\n  tests/add.sh — adds\n');
  thenObjectIncludes(latest(folder).payload, { reason: 'suite_not_green', failures: ['tests/add.sh — adds'], evidence: [{ role: 'raw' }] });
});

it('With no target in the rulebook it refuses and says no logbook event was recorded. [AC0026.1]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  const history = whenEventsAreRead(folder);
  givenRulebookChanges(folder, book => { delete book.targetBranch; });

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'No logbook event was recorded.');
  thenEventsEqual(folder, history);
});

it('With a broken logbook it refuses and says to stop and tell the operator. [AC0026.2]', () => {
  const folder = givenAWorkingBranch();
  givenABreakingChange(folder);
  givenFileContents(folder, '.katatay/state/work/0001__plan_approved.json', '{"broken": true}');

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'Stop and tell the operator. Do not work around it.\n\nNo logbook event was recorded.\n');
  thenFileContains(folder, '.katatay/state/work/0001__plan_approved.json', '{"broken": true}');
});

it('With no approved plan it refuses and says there is no change to triage. [AC0026.3]', () => {
  const folder = givenAWorkingBranch();

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenItPrintsError(run, [
    'Triage refused.',
    '',
    'No plan has been approved on this branch, so there is no change to triage.',
    '',
    'No logbook event was recorded.',
  ]);
  thenEventsEqual(folder, []);
});

it('When the compile step cannot run it refuses and passes on why. [AC0026.4]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.code.compile = { ...compile, command: 'no-such-compiler-in-path' }; });
  givenABreakingChange(folder);
  const history = whenEventsAreRead(folder);

  const run = whenTriageRuns(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'compile (`no-such-compiler-in-path`) exited with 127, which "code.compile.exitCodes" does not list, so it means broken.');
  thenStderrContains(run, 'no-such-compiler-in-path');
  thenStderrContains(run, 'No logbook event was recorded.');
  thenEventsEqual(folder, history);
});

it('When the approved plan snapshot is unreadable or belongs to another branch, it refuses before any test runs. [AC0026.5]', () => {
  const missing = givenAWorkingBranch();
  const missingMarker = givenTheTestCommandCountsItsRuns(missing);
  givenABreakingChange(missing);
  const lost = whenEventsAreRead(missing)[0].payload.planSnapshot;
  whenFileIsRemoved(missing, lost);

  const missingRun = whenTriageRuns(missing);
  thenItExits(missingRun, 1);
  thenStderrContains(missingRun, 'Restore the exact approved snapshot at the recorded path and retry.');
  thenPathsExist(missing, [missingMarker], false);

  const other = givenAWorkingBranch();
  const otherMarker = givenTheTestCommandCountsItsRuns(other);
  givenABreakingChange(other);
  const [approval] = whenEventsAreRead(other);
  const borrowed = approval.payload.planSnapshot.replace('/work/', '/peer/');
  mkdirSync(join(other.cwd, dirname(borrowed)), { recursive: true });
  cpSync(join(other.cwd, approval.payload.planSnapshot), join(other.cwd, borrowed));
  givenFileContents(other, '.katatay/state/work/0001__plan_approved.json',
    JSON.stringify({ ...approval, payload: { ...approval.payload, planSnapshot: borrowed } }));

  const otherRun = whenTriageRuns(other);
  thenItExits(otherRun, 1);
  thenStderrContains(otherRun, 'approval 1 ' + borrowed + ': invalid approved plan reference');
  thenPathsExist(other, [otherMarker], false);
});

it('A scenario id predicts every acceptance test tagged with it. [AC0027.1]', () => {
  const folder = givenAWorkingBranch();
  const suite = [...cases('acceptance/a.sh', ['One. [AC0001.1]', 'Two. [AC0001.1]', 'Three. [AC0001.2]']), ...cases('tests/b.sh', ['other'])];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['AC0001.1']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.name.includes('[AC0001.1]') })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'Risk: LOW\n4 tests ran, 2 failed\npredicted 2/2 failed · 0 surprises (0%) · 0 over-predictions (0%)\n');
});

it('A file path predicts every test in that file. [AC0027.2]', () => {
  const folder = givenAWorkingBranch();
  const suite = [...cases('tests/b.sh', ['one', 'two']), ...cases('tests/c.sh', ['three'])];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/b.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.file === 'tests/b.sh' })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'Risk: LOW\n3 tests ran, 2 failed\npredicted 2/2 failed · 0 surprises (0%) · 0 over-predictions (0%)\n');
});

it('A path::name entry predicts one test, with or without its group names, ignoring case and punctuation. [AC0027.3]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('tests/b.sh', ['group > one', 'group > two', 'group > three']);
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/b.sh::Group > One!', 'tests/b.sh::TWO']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.name !== 'group > three' })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'Risk: LOW\n3 tests ran, 2 failed\npredicted 2/2 failed · 0 surprises (0%) · 0 over-predictions (0%)\n');
});

it('A file that failed to load is matched by its path, by any path::name in it, or by a scenario its text holds. [AC0027.4]', () => {
  const folder = givenAWorkingBranch();
  const suite = [
    ...cases('tests/ok.sh', ['passes']),
    { file: 'tests/x.sh', name: 'ex', missing: true },
    { file: 'tests/y.sh', name: 'why', missing: true },
    { file: 'acceptance/z.sh', name: 'Zed. [AC0001.2]', missing: true },
  ];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/x.sh', 'tests/y.sh::why', 'AC0001.2']);
  givenAnApprovedPlan(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 4 # changed\n');

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenObjectIncludes(latest(folder).payload, { level: 'LOW', reasons: [], notRun: { predicted: 3, unpredicted: 0 }, surprise: { failed: 0 } });
});

it('An entry that matches no test counts as an over-prediction and is shown as matching no test. [AC0027.5]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('tests/b.sh', ['one', 'two', 'three', 'four', 'five']);
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/b.sh', 'tests/none.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: true })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'predicted 5/6 failed · 0 surprises (0%) · 1 over-prediction (17%)\n');
  thenStdoutContains(run, 'Over-predictions:\ntests/none.sh — matched no test\n');
  thenObjectIncludes(latest(folder).payload, { overPredicted: { count: 1, total: 6 } });
});

it('Predictions are read from the approved snapshot, not from the working plan file. [AC0027.6]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('tests/b.sh', ['one', 'two']);
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/b.sh::one']);
  givenAnApprovedPlan(folder);
  givenAPlanPredicting(folder, ['tests/b.sh::two']);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.name === 'one' })));

  const edited = whenTriageRuns(folder);
  thenItExits(edited, 0);
  thenStdoutContains(edited, 'predicted 1/1 failed · 0 surprises (0%) · 0 over-predictions (0%)\n');

  whenFileIsRemoved(folder, planFile);
  const removed = whenRiskIsAssessed(folder);
  thenItExits(removed, 0);
  thenStdoutContains(removed, 'predicted 1/1 failed · 0 surprises (0%) · 0 over-predictions (0%)');
});

it('Predicted failures are counted but not named, and each surprise is named by file and title without its message. [AC0027.7]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('tests/b.sh', ['expected one', 'unexpected two']);
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/b.sh::expected one']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: 'boom in ' + item.name })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'predicted 1/1 failed · 1 surprise (100%) · 0 over-predictions (0%)\n');
  thenStdoutContains(run, 'Surprises:\ntests/b.sh — unexpected two\n\n');
  thenOmits(run.stdout, 'expected one');
  thenOmits(run.stdout, 'boom');
  thenOmits(JSON.stringify(latest(folder)), 'expected one');
});

it('A failing invariant test makes the level HIGH, even when it was predicted. [AC0028.1]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('acceptance/inv.sh', ['Holds. [INV0001]']);
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['acceptance/inv.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: true })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  const { payload } = latest(folder);
  thenObjectIncludes(payload, { level: 'HIGH', predicted: { failed: 1 }, surprise: { failed: 0 } });
  thenValueIs(payload.reasons.length, 1);
  thenTextMatches(payload.reasons[0], /^Raised to HIGH by failing invariants/);
});

it('An unpredicted test file that never ran makes it HIGH, while a predicted one raises nothing but is still named. [AC0028.2]', () => {
  const unpredicted = givenAWorkingBranch();
  givenAPublishedSuite(unpredicted, [...cases('tests/ok.sh', ['passes']), { file: 'tests/gone.sh', name: 'gone', missing: true }]);
  givenAPlanPredicting(unpredicted, []);
  givenAnApprovedPlan(unpredicted);

  thenItExits(whenTriageRuns(unpredicted), 0);
  thenObjectIncludes(latest(unpredicted).payload, {
    level: 'HIGH', notRun: { predicted: 0, unpredicted: 1 },
    reasons: [
      'Raised to HIGH by test files the plan did not predict that never ran, named below among the surprises: nothing in them was classified.',
      'Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.',
    ],
  });

  const predicted = givenAWorkingBranch();
  givenAPublishedSuite(predicted, [...cases('tests/ok.sh', ['passes']), { file: 'tests/gone.sh', name: 'gone', missing: true }]);
  givenAPlanPredicting(predicted, ['tests/gone.sh']);
  givenAnApprovedPlan(predicted);

  thenItExits(whenTriageRuns(predicted), 0);
  thenObjectIncludes(latest(predicted).payload, { level: 'LOW', reasons: [], notRun: { predicted: 1, unpredicted: 0 } });
  thenStdoutContains(whenStateIsShown(predicted), '           Predicted files that never ran:\n           tests/gone.sh\n');
});

it('Surprises at 20% or more of the predicted tests make it HIGH, and one below that makes it MEDIUM. [AC0028.3]', () => {
  for (const [size, level, reason] of [
    [5, 'HIGH', 'Raised to HIGH by surprise failures: 1 against 5 predicted, 20% or more.'],
    [10, 'MEDIUM', 'Raised to MEDIUM by a surprise failure.'],
  ]) {
    const folder = givenAWorkingBranch();
    const predicted = cases('tests/p.sh', Array.from({ length: size }, (_, i) => 'predicted ' + i));
    const suite = [...predicted, ...cases('tests/s.sh', ['surprise'])];
    givenAPublishedSuite(folder, suite);
    givenAPlanPredicting(folder, ['tests/p.sh']);
    givenAnApprovedPlan(folder);
    givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: true })));

    thenItExits(whenTriageRuns(folder), 0);

    const { payload } = latest(folder);
    thenValueIs(payload.level, level);
    thenValueIs(payload.reasons.length, 1);
    if (typeof reason === 'string') thenValueIs(payload.reasons[0], reason);
    else thenTextMatches(payload.reasons[0], reason);
  }
});

it('Over-predictions at 20% or more of the predicted tests make it HIGH, and one below that makes it MEDIUM. [AC0028.4]', () => {
  for (const [size, level, reason] of [
    [5, 'HIGH', 'Raised to HIGH by over-predictions: 1 of 5 predicted failures passed, 20% or more.'],
    [10, 'MEDIUM', 'Raised to MEDIUM by an over-prediction: a test the plan said would fail passed.'],
  ]) {
    const folder = givenAWorkingBranch();
    const suite = cases('tests/p.sh', Array.from({ length: size }, (_, i) => 'predicted ' + i));
    givenAPublishedSuite(folder, suite);
    givenAPlanPredicting(folder, ['tests/p.sh']);
    givenAnApprovedPlan(folder);
    givenTheSuiteReports(folder, suite.map((item, i) => ({ ...item, fails: i > 0 })));

    thenItExits(whenTriageRuns(folder), 0);

    const { payload } = latest(folder);
    thenValueIs(payload.level, level);
    thenValuesEqual(payload.reasons, [reason]);
  }
});

it('Any surprise when nothing was predicted makes it HIGH. [AC0028.5]', () => {
  const folder = givenAWorkingBranch();
  const suite = cases('tests/b.sh', Array.from({ length: 20 }, (_, i) => 'test ' + i));
  givenAPublishedSuite(folder, suite);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map((item, i) => ({ ...item, fails: i === 0 })));

  thenItExits(whenTriageRuns(folder), 0);

  thenObjectIncludes(latest(folder).payload, {
    level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.'],
    surprise: { failed: 1, total: 20 },
  });
});

it('Every predicted test failing and nothing else failing is LOW, with no reasons. [AC0028.6]', () => {
  const folder = givenAWorkingBranch();
  const suite = [...cases('tests/p.sh', ['one', 'two']), ...cases('tests/q.sh', ['three'])];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['tests/p.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.file === 'tests/p.sh' })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, '\nRisk: LOW\n3 tests ran, 2 failed\n');
  thenObjectIncludes(latest(folder).payload, { level: 'LOW', reasons: [] });
});

it('Each reason starts with the level it raises the report to, in the order shown. [AC0028.7]', () => {
  const folder = givenAWorkingBranch();
  const suite = [
    ...cases('acceptance/inv.sh', ['Holds. [INV0001]']),
    ...cases('tests/p.sh', ['one', 'two', 'three', 'four']),
    ...cases('tests/s.sh', ['surprise']),
    { file: 'tests/gone.sh', name: 'gone', missing: true },
  ];
  givenAPublishedSuite(folder, suite);
  givenAPlanPredicting(folder, ['acceptance/inv.sh', 'tests/p.sh']);
  givenAnApprovedPlan(folder);
  givenTheSuiteReports(folder, suite.map(item => ({ ...item, fails: item.name !== 'four' })));

  const run = whenTriageRuns(folder);

  thenItExits(run, 0);
  const { reasons } = latest(folder).payload;
  thenValueIs(reasons.length, 4);
  thenTextMatches(reasons[0], /^Raised to HIGH by failing invariants/);
  thenValueIs(reasons[1], 'Raised to HIGH by test files the plan did not predict that never ran, named below among the surprises: nothing in them was classified.');
  thenValueIs(reasons[2], 'Raised to HIGH by surprise failures: 2 against 5 predicted, 20% or more.');
  thenValueIs(reasons[3], 'Raised to HIGH by over-predictions: 1 of 5 predicted failures passed, 20% or more.');
  thenStdoutContains(run, 'Risk: HIGH\n' + reasons.join('\n') + '\n');
});

it('With a plan that predicted the one failing test, it reports it as predicted and exits 0. [AC0029.1]', () => {
  const folder = givenAWorkingBranch();
  givenAPlanPredicting(folder, ['tests/add.sh::adds']);
  givenABreakingChange(folder);
  const history = whenEventsAreRead(folder);

  const run = whenRiskIsAssessed(folder);

  thenItExits(run, 0);
  thenStdoutContains(run, 'Risk: LOW\n1 test ran, 1 failed\npredicted 1/1 failed · 0 surprises (0%) · 0 over-predictions (0%)\n');
  thenEventsEqual(folder, history);
});

it('With no approved plan, every failure is a surprise and it exits 1. [AC0029.2]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');

  const run = whenRiskIsAssessed(folder);

  thenItExits(run, 1);
  thenStdoutContains(run, 'predicted 0/0 failed · 1 surprise (0%)');
  thenStdoutContains(run, '\nSurprises:\ntests/add.sh — adds\n');
  thenEventsEqual(folder, []);
});

it('At MEDIUM or HIGH it exits 1 and says the operator needs to look. [AC0029.3]', () => {
  const high = givenAWorkingBranch();
  givenABreakingChange(high);

  const highRun = whenRiskIsAssessed(high);
  thenItExits(highRun, 1);
  thenStdoutContains(highRun, '\nRisk: HIGH\n');
  thenStderrContains(highRun, 'Stop here. HIGH needs the operator to look — no approval clears it.');

  const medium = givenAWorkingBranch();
  const suite = [...cases('tests/p.sh', Array.from({ length: 10 }, (_, i) => 'predicted ' + i)), ...cases('tests/s.sh', ['surprise'])];
  givenAPublishedSuite(medium, suite);
  givenAPlanPredicting(medium, ['tests/p.sh']);
  givenAnApprovedPlan(medium);
  givenTheSuiteReports(medium, suite.map(item => ({ ...item, fails: true })));

  const mediumRun = whenRiskIsAssessed(medium);
  thenItExits(mediumRun, 1);
  thenStdoutContains(mediumRun, '\nRisk: MEDIUM\n');
  thenStderrContains(mediumRun, 'MEDIUM needs the operator to look');
});

it('A broken logbook is refused before any test runs. [AC0029.4]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenABreakingChange(folder);
  givenFileContents(folder, '.katatay/state/work/0001__plan_approved.json', '{"broken": true}');

  const run = whenRiskIsAssessed(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'req:risk: refused — the workflow state chain is broken: 0001__plan_approved.json');
  thenPathsExist(folder, [marker], false);
});

it('Unreadable approved-plan evidence is refused before any test runs. [AC0029.5]', () => {
  const folder = givenAWorkingBranch();
  const marker = givenTheTestCommandCountsItsRuns(folder);
  givenABreakingChange(folder);
  whenFileIsRemoved(folder, whenEventsAreRead(folder)[0].payload.planSnapshot);

  const run = whenRiskIsAssessed(folder);

  thenItExits(run, 1);
  thenStderrContains(run, 'Restore the exact approved snapshot at the recorded path and retry.');
  thenPathsExist(folder, [marker], false);
});

it("It prints triage's report without the event link or the notes for the agent. [AC0029.6]", () => {
  const folder = givenAWorkingBranch();
  givenAPlanPredicting(folder, ['tests/add.sh::adds']);
  givenABreakingChange(folder);

  const risk = whenRiskIsAssessed(folder);
  const triage = whenTriageRuns(folder);

  thenItExits(risk, 0);
  thenItExits(triage, 0);
  thenItPrintsLines(risk, [
    title,
    '',
    'Risk: LOW',
    '1 test ran, 1 failed',
    'predicted 1/1 failed · 0 surprises (0%) · 0 over-predictions (0%)',
    '',
    unchecked,
  ]);
  thenValueIs(risk.stdout, triage.stdout.slice(0, triage.stdout.indexOf('\n\nDetails: ')) + '\n');
});
