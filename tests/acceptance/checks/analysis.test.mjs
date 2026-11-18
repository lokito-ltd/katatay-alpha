import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsError, thenItPrintsLines } from '../support/ktty.mjs';
import {
  exists,
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenEventsAreRead,
  whenFileIsRemoved,
  whenHookRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import { codesOf, givenAConvergingChange, textOf, whenChecksAnalysisIsSubmitted } from '../support/checks.mjs';
import { thenContains, thenEventNamesEqual, thenPathsExist, thenTextMatches, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';

const analysis = [
  'Summary: Nothing to add.',
  'Limit coverage [skipped]', 'Impact: Coverage was not measured.',
  'Limit mutation [skipped]', 'Impact: Mutation was not measured.',
  'Limit compile [skipped]', 'Impact: Nothing was compiled.', '',
].join('\n');
const analysisFolder = '.katatay/local/work/checks-analysis';

// A converging change verified at a turn end, with the analysis switch as given.
function givenAVerifiedChange(folder, requireAnalysis) {
  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = requireAnalysis; });
  givenAConvergingChange(folder);
  return thenHookReplies(whenTurnEnds(folder), 0);
}

it('An accepted analysis prints only its summary on stdout, and a rejection goes to stderr with exit 1. [AC0037.2]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder, true);

  const rejected = whenChecksAnalysisIsSubmitted(folder, ['3'], 'Looks fine to me.\n');

  thenItExits(rejected, 1);
  thenItPrintsError(rejected, ['Verification 3: missing Summary. No analysis recorded.']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified']);

  const accepted = whenChecksAnalysisIsSubmitted(folder, ['3'], analysis);

  thenItExits(accepted, 0);
  thenItPrintsLines(accepted, [
    "Agent's assessment for verification 3 checks results.",
    '',
    'Nothing to add.',
    '',
    'Limitations: 3 (coverage [skipped], mutation [skipped], compile [skipped]).',
    '',
    'Full analysis: .katatay/state/work/0004__checks_analysis.json',
  ]);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'checks_analysis']);
});

it('An analysis is refused, and nothing is written, for a receipt that is not current, outside verified, while the switch is off, or on a broken logbook. [AC0037.3]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder, true);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # a second pass\n');
  thenHookReplies(whenTurnEnds(folder), 0);

  const stale = whenChecksAnalysisIsSubmitted(folder, ['3'], analysis);

  thenItExits(stale, 1);
  thenItPrintsError(stale, ['Verification 3 is not the current receipt for this tree.']);

  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4 # converging\n');

  const converging = whenChecksAnalysisIsSubmitted(folder, ['4'], analysis);

  thenItExits(converging, 1);
  thenItPrintsError(converging, ['Verification 4 is not the current receipt for this tree.']);

  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = false; });

  const off = whenChecksAnalysisIsSubmitted(folder, ['4'], analysis);

  thenItExits(off, 1);
  thenItPrintsError(off, ['checks.requireAnalysis is off.']);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'verified']);
  thenPathsExist(folder, [analysisFolder], false);

  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = true; });
  givenFileContents(folder, '.katatay/state/work/0004__verified.json', '{ not json\n');

  const broken = whenChecksAnalysisIsSubmitted(folder, ['4'], analysis);

  thenItExits(broken, 1);
  thenTextMatches(broken.stderr, /^The logbook is broken: /);
  thenPathsExist(folder, [analysisFolder], false);
});

it('Evidence the verification names that is missing or invalid is named both at checks-analysis and at record. [AC0037.4]', () => {
  const folder = givenAWorkingBranch();
  givenAVerifiedChange(folder, true);
  const report = whenEventsAreRead(folder).at(-1).payload.results.find(result => result.name === 'tests').evidence[0].snapshot;
  whenFileIsRemoved(folder, report);

  const submitted = whenChecksAnalysisIsSubmitted(folder, ['3'], analysis);

  thenItExits(submitted, 1);
  thenTextMatches(submitted.stderr, /^Verification 3's evidence cannot be read: the tests evidence cannot be read: JUnit XML \((.+)\): ENOENT: no such file or directory, lstat '.*\/case\/(.+)'\. Restore the files it names\. No analysis recorded\.\n$/);
  thenContains(submitted.stderr, `JUnit XML (${report}): ENOENT`);

  const record = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);

  thenValuesEqual(codesOf(record), ['not_declared', 'state']);
  thenTextMatches(textOf(record, 'not_declared'), /^Verification 3 needs its checks analysis, but its evidence cannot be read: the tests evidence cannot be read: JUnit XML \(.+\): ENOENT/);
  thenContains(textOf(record, 'not_declared'), `JUnit XML (${report}): ENOENT`);
  thenContains(textOf(record, 'not_declared'), report + "'. Nothing was declared. Restore the files it names, and tell the operator.");
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified']);

  givenFileContents(folder, report, '<testsuites><testsuite name="altered"/></testsuites>\n');

  const altered = whenChecksAnalysisIsSubmitted(folder, ['3'], analysis);

  thenItExits(altered, 1);
  thenItPrintsError(altered, [`Verification 3's evidence cannot be read: the tests evidence cannot be read: JUnit XML (${report}): SHA-256 digest mismatch. Restore the files it names. No analysis recorded.`]);

  const recordAltered = thenHookReplies(whenHookRuns(folder, 'prompt', { prompt: 'record' }), 0);

  thenValueIs(textOf(recordAltered, 'not_declared'), `Verification 3 needs its checks analysis, but its evidence cannot be read: the tests evidence cannot be read: JUnit XML (${report}): SHA-256 digest mismatch. Nothing was declared. Restore the files it names, and tell the operator.`);
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified']);
});

it('checks.requireAnalysis false turns off the snapshot, the request and the record prerequisite together. [AC0037.5]', () => {
  const on = givenAWorkingBranch();
  const requested = givenAVerifiedChange(on, true);

  thenValuesEqual(codesOf(requested), ['triaged', 'verified', 'info']);
  thenValueIs(textOf(requested, 'info').startsWith('Write the checks analysis for verification 3.'), true);
  thenValuesEqual(codesOf(thenHookReplies(whenHookRuns(on, 'prompt', { prompt: 'record' }), 0)), ['not_declared', 'state']);
  thenItExits(whenChecksAnalysisIsSubmitted(on, ['3'], analysis), 0);
  thenValueIs(exists(on, analysisFolder), true);

  const off = givenAWorkingBranch();
  const answer = givenAVerifiedChange(off, false);

  thenValuesEqual(codesOf(answer), ['triaged', 'verified']);

  const submitted = whenChecksAnalysisIsSubmitted(off, ['3'], analysis);

  thenItExits(submitted, 1);
  thenItPrintsError(submitted, ['checks.requireAnalysis is off.']);
  thenPathsExist(off, [analysisFolder], false);

  const record = thenHookReplies(whenHookRuns(off, 'prompt', { prompt: 'record' }), 0);

  thenValuesEqual(codesOf(record), ['declared', 'state']);
  thenEventNamesEqual(off, ['plan_approved', 'triaged', 'verified', 'declared']);
});
