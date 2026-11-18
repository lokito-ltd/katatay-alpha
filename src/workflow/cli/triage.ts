#!/usr/bin/env node
/**
 * `workflow triage` — run the suite and classify what broke, before anything is
 * fixed and before a single test is written.
 *
 * This is the step the workflow is built around. Until it has happened the
 * tests are frozen, so every failure it reports was caused by the
 * implementation and nothing else. After it, the freeze lifts and the failures
 * are worked through. Running the suite only at the end, once it has already
 * been driven green, reports on a suite that was fixed before anyone looked at
 * it.
 *
 * Both preconditions are checked here rather than trusted. The Stop hook says
 * the same things a turn earlier, but it can be stopped past. This cannot,
 * because without the event it appends there is no route to `verified`.
 */
import { junitArtifacts, writeJUnitSnapshot } from '../junit-snapshot.mjs';
import { append } from '../chain.mjs';
import { RESTORE_IMPLEMENTATION, sameMeasurement } from '../phase.mjs';
import { current } from '../state.mjs';
import { changedFiles, implementationChanges, frozenChanges, describeFreeze } from '../frozen.mjs';
import { allFailures, assessChange, totalFailures, type RiskReport } from '../../evidence/risk.js';
import { runTestCommand, type TestRun } from '../../evidence/test-run.js';
import { writeTriageSnapshot } from '../triage-snapshot.mjs';
import { testListOf } from '../../evidence/test-list.js';
import { compileErrors, splitErrors } from '../../evidence/typecheck.js';
import { TargetError } from '../target.mjs';
import { approvedPredictions, PlanEvidenceError } from '../approved-predictions.mjs';
import { agentNotes, refusalSummary, triageReport } from '../triage-summary.mjs';

type Refusal = Parameters<typeof refusalSummary>[0];

/** A refusal that records nothing: there is no logbook to write it to, or no
 *  change for it to be part of. */
function turnAway(refusal: Refusal): never {
  console.error(refusalSummary({ ...refusal, event: null }));
  process.exit(1);
}

let rawEvidence: ReturnType<typeof junitArtifacts> | undefined;
let state: ReturnType<typeof current>;
try {
  state = current();
} catch (error) {
  if (!(error instanceof TargetError)) throw error;
  turnAway({ why: error.message });
}

if (state.broken) {
  turnAway({ why: `The workflow state chain is broken: ${state.broken}`, next: 'Stop and tell the operator. Do not work around it.' });
}

if (!state.grant) {
  turnAway({ why: 'No plan has been approved on this branch, so there is no change to triage.' });
}

/** A refusal is recorded, not just printed. An attempt that was turned away is
 *  part of how the change went, and the logbook is where that belongs. */
function refuse(reason: string, detail: Record<string, unknown>, refusal: Refusal): never {
  const event = append(state.dir, 'triage_refused', { reason, ...detail, ...(rawEvidence && { evidence: rawEvidence }) }, state.branch);
  console.error(refusalSummary({ ...refusal, event: event ?? null, dir: state.dir }));
  process.exit(1);
}

if (state.drift) {
  refuse('implementation_changed', {}, { why: RESTORE_IMPLEMENTATION });
}

const testOnly = state.grant.payload.testOnly;

// Against the baseline the logbook pins, not the target as it stands: tests the
// target gained after this branch was cut are not this change's, and a moved
// ref must not be able to empty the freeze.
const touched = frozenChanges(state.baseline);
if (touched.length > 0) {
  refuse('tests_modified', { files: touched }, {
    why: describeFreeze(),
    // The phrase on a line of its own, so it never wraps apart from the list.
    list: ['These differ from the baseline:', ...touched.map((file) => `  ${file}`)],
    // The old advice was "unwind them and run this again", full stop. For a
    // change whose whole content is tests that is circular, and it is how two
    // changes here concluded the machine had no way to express one.
    next: testOnly
      ? 'This change is declared test-only, so the triage comes first: it runs on the tree as it stands before your work, and all it has to find is a green suite. Unwind these, run it, and then write them.'
      : [
        'Unwind them and run this again. Every failure this report shows was caused by the implementation and nothing else, and the freeze is what makes that true.',
        'If the tests *are* this change, that is a different kind of change. Say so in the plan — `test-only: true` in its closing `workflow` block — and have the operator approve it.',
      ],
  });
}

// Only the implementation has to compile. A test file that no longer compiles
// against it is a test result, and is counted as a failure in the report
// below; see `src/evidence/typecheck.ts`. Refusing on those deadlocked any
// change to a public contract's types, because the tests that needed changing
// were frozen until this ran.
//
// The errors come from the rulebook's `code.compile`. A compiler that
// broke, or a step that is not configured, is a refusal like any other here:
// there is no telling what the triage would have found.
let typeErrors: ReturnType<typeof compileErrors>;
let report: RiskReport;
let run: TestRun;
try {
  typeErrors = compileErrors();
} catch (error) {
  if (!(error instanceof TargetError)) throw error;
  turnAway({ why: error.message });
}
const { elsewhere } = splitErrors(typeErrors ?? []);
if (elsewhere.length > 0) {
  refuse('typecheck_failed', { files: [...new Set(elsewhere.map((e) => e.file))] }, {
    why: 'The implementation does not compile yet, so there is nothing to classify. A suite that cannot run says nothing about what this change broke.',
    list: elsewhere.slice(0, 20).map((e) => `  ${e.file}:${e.line} ${e.message}`),
    next: 'Finish the implementation, then run this again. Compile errors in test files do not count here: they are reported as failing tests.',
  });
}

try {
  const predictions = approvedPredictions(state.branch, state.grant);
  run = runTestCommand({ shown: false, capture: reports => {
    rawEvidence = junitArtifacts(writeJUnitSnapshot(state.branch, reports));
  } });
  report = assessChange(typeErrors, predictions, run);
} catch (error) {
  if (rawEvidence) refuse('invalid_test_run', { message: (error as Error).message }, { why: (error as Error).message });
  if (!(error instanceof TargetError || error instanceof PlanEvidenceError)) throw error;
  turnAway({ why: error.message });
}

/**
 * Whether there is an implementation for this report to be about.
 *
 * A triage of a tree with no implementation in it prints exactly what a clean
 * triage of a finished one prints, and the machine used to let that stand. It
 * is the ordinary case for a test-only change and a warning sign for any other,
 * so it is recorded either way, and the summary's title says so.
 */
const implementation = implementationChanges(changedFiles(state.baseline));

// A test-only change needs the suite green before it starts. Afterwards there
// is no telling a failure the new tests found from one that was already there,
// and the new tests are the only thing anybody will be looking at.
if (testOnly && totalFailures(report) > 0) {
  refuse('suite_not_green', { failures: allFailures(report) }, {
    why: 'This change is declared test-only, and the suite is not green:',
    list: allFailures(report).map((failure) => `  ${failure}`),
    next: 'Fix these first, as their own change. Once new tests land on top of them there is no telling which failures they found from which were already here.',
  });
}

// The tests are frozen until this runs, so this run is the baseline's tests.
// The change report counts tests added, modified and removed against it.
const list = testListOf(run);
const measured = current();
if (!sameMeasurement(state, measured)) {
  refuse('measurement_changed', {}, { why: 'The working tree or approval changed during the run.', next: 'Run triage again.' });
}

let snapshot;
try { snapshot = writeTriageSnapshot(state.branch, list, report); }
catch (error) {
  refuse('snapshot_failed', { message: (error as Error).message }, { why: 'Could not publish the triage snapshot: ' + (error as Error).message });
}

const recorded = append(
  state.dir,
  'triaged',
  {
    treeFingerprint: state.treeFingerprint,
    implementationFingerprint: state.implementationFingerprint,
    level: report.level,
    reasons: report.reasons.map(reason => reason.text),
    ...snapshot,
    evidence: [...(rawEvidence ?? []), ...snapshot.evidence],
    implemented: implementation.length > 0,
    // What the adapter says this language lacks, so the logbook shows the triage
    // was made without it. Left out when nothing was.
    ...(report.unchecked.length > 0 ? { unchecked: report.unchecked } : {}),
  },
  state.branch,
  measured.entries.length,
);

// Turn end builds the same report from the recorded triage and its approval.
// The agent's next steps follow, apart from the report the agent posts.
console.log(triageReport(recorded, { branch: state.branch, dir: state.dir, testOnly }) + '\n\n' + agentNotes(recorded.payload, testOnly));
