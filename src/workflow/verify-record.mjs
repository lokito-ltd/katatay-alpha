/**
 * The referee verify, run and recorded. Shared by the turn-end hook and
 * `workflow verify --rerun`, so a result is measured and recorded the same way
 * whoever started it: the tree fingerprint, the evidence check, mutation once
 * per plan, the verified message and the checks-analysis request.
 *
 * What only the hook does stays in `moments/turn-end.mjs`: the triage summary,
 * the guard that does not run verify again on an unchanged failure, and when
 * the agent is asked to keep working. What only the rerun does is in
 * `rerun.mjs`: its refusals.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { current } from './state.mjs';
import { append, readChain } from './chain.mjs';
import { reviewSuppressions, branchChanges, changedFiles, implementationChanges } from './frozen.mjs';
import { renderAreas, reviewAreas } from './areas.mjs';
import { readMutationSnapshot } from './mutation-snapshot.mjs';
import { reportOf } from './checks-report.mjs';
import { TEST_QUALITY_RESULTS, validateChecksResults } from './result-format.mjs';
import { validateVerificationEvidence } from './verification-results.mjs';
import { coverageMeasurement, mutationReferences, usable } from './result-readers.mjs';
import { analysisRequest } from './checks-analysis.mjs';
import { analysisRequired, rulebookFingerprint as readRulebookFingerprint } from './rulebook.mjs';
import { agentWarnings } from './agent.mjs';
import { sameMeasurement } from './phase.mjs';
import { verificationSummary } from './verification-summary.mjs';
import { runReferee } from './runtime.mjs';
import { command } from './commands.mjs';
import { message } from './moments/messages.mjs';

/**
 * The referee verify, started through `runtime.mjs` and not through npm. A
 * repository in another language has no `package.json` to hold a `verify`
 * script, and the referee owns this command whatever the language. The paths are
 * found from this file, so the command works in a repository other than the
 * one it lives in, as the machine suite runs it.
 */
export const VERIFY = fileURLToPath(new URL('./cli/verify-change.ts', import.meta.url));

/** The `trigger` a rerun's events carry. The hook's events leave it out. */
export const RERUN = 'rerun';

/**
 * Where review has to look, said on the turns the operator is deciding whether
 * to type `record`. The same list reaches the commit message later, but by then
 * the change is declared finished, and this is the moment it can still change
 * their mind.
 */
export function areasSummary(state) {
  const changes = branchChanges(state.baseline);
  const { ignores, suppressed } = reviewSuppressions({ base: state.baseline, added: changes.added });
  const lines = renderAreas(reviewAreas({ ...changes, ignores, suppressed }), '  ');
  return lines.length > 0 ? `\n\nWhere review should look:\n${lines.join('\n')}` : '';
}

/**
 * The review areas as summary lines: each reason, then its files. The
 * summary gives them their heading, so the list's own is left out.
 */
export function reviewLines(state) {
  const changes = branchChanges(state.baseline);
  const { ignores, suppressed } = reviewSuppressions({ base: state.baseline, added: changes.added });
  return renderAreas(reviewAreas({ ...changes, ignores, suppressed })).filter((line) => line !== 'Must look:').map((line) => line.replace(/^ {2}/, ''));
}

/** The warning a rerun carries: its shell is not the hook's. */
export const RERUN_WARNING = `This run came from \`${command('verify')} --rerun\`, not from a turn end. It ran in the shell of whoever started it, so that shell's environment shaped the result.`;

/** The agent's settings warnings, as the summary says them. */
export const settingsWarnings = (root = process.cwd()) => agentWarnings(root).map((warning) => `settings: ${warning}`);

/**
 * The summary of a recorded verification, for the operator. `warnings` come
 * first, then the rerun's and the agent settings' own.
 */
export function summaryMessage(state, event, { warnings = [], review = [] } = {}) {
  const all = [...(event.payload.trigger === RERUN ? [RERUN_WARNING] : []), ...warnings, ...settingsWarnings()];
  return message(event.event, 'operator', verificationSummary(event, { branch: state.branch, dir: state.dir, warnings: all, review, live: state.live }));
}

/**
 * Where verify writes its checks' results for this run: the system's
 * temporary folder, outside the repository, so the file never moves the tree
 * fingerprint. Named by process and time, so two runs never share one.
 */
const checkResultsFile = () => join(tmpdir(), `workflow-checks-${process.pid}-${Date.now()}.json`);

/**
 * Read this run's unified results and remove the temporary file.
 * Undefined when verify wrote none or the file cannot be read.
 */
function readCheckResults(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).results;
  } catch {
    return undefined;
  } finally {
    rmSync(file, { force: true });
  }
}

export const tail = (text, lines = 40) => text.trim().split('\n').slice(-lines).join('\n');

/** What the agent does about a failed verify, with the output's tail. */
export const failureNote = (text) => message('info', 'agent',
  `\`${command('verify')}\` failed on the current working tree.\n\nCheck the failing tests. If the triaged implementation needs a fix, present a revised plan. Never weaken a requirement or delete its evidence to get this green.\n\n${tail(text)}`);

/**
 * A failed verify's messages: the summary for the operator, read from the
 * `verify_failed` event, then the agent's note with the output's tail.
 */
export const failureMessages = (state, { event, text }) => [summaryMessage(state, event), failureNote(text)];

/**
 * Run verify on `state`, which must be in `converging`, and record what it
 * found. `deadline` is the absolute time, in milliseconds, verify must finish
 * by, or undefined for none. `trigger` is written on the event when given.
 *
 * Returns one of:
 * - `{ outcome: 'failed', text, event }`: `verify_failed` was recorded as
 *   `event`. `text` is the output, or the reason the evidence was unusable.
 * - `{ outcome: 'changed', why }`: the tree or the approval moved while verify
 *   ran, so nothing was recorded.
 * - `{ outcome: 'passed', receipt, messages }`: `verified` was recorded, and
 *   `messages` say so: the summary, with a test-only plan's stray files, the
 *   setup warnings and the review areas in it, then the analysis request.
 */
export function verifyAndRecord(state, { deadline, referee = runReferee, trigger } = {}) {
  const marked = trigger === undefined ? {} : { trigger };
  const { treeFingerprint, baseline, rulebookFingerprint } = state;
  const inputs = { treeFingerprint, baseline, rulebookFingerprint };
  const reading = { live: state.live, branch: state.branch, before: state.entries.length + 1, baseline, rulebookFingerprint };
  // Said, not pushed back on. The declaration was the operator's and the
  // branch is theirs to review; what the machine owes them is not being
  // silent about a change that stopped being the one they approved.
  const strayed = state.grant.payload.testOnly ? implementationChanges(changedFiles(state.baseline)) : [];
  const resultsFile = checkResultsFile();
  const args = ['--results', resultsFile, ...(deadline === undefined ? [] : ['--deadline', String(deadline)])];
  const verifyRun = referee(VERIFY, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Everything the verify prints is kept, for the tail shown on a
    // failure. The suite's own output is far more than Node's default.
    maxBuffer: 512 * 1024 * 1024,
  });
  const suppliedResults = readCheckResults(resultsFile);
  // The unified results are the only evidence a pass carries. A successful
  // exit without them measured nothing a receipt could vouch for. Their
  // check reads back every snapshot they name: the test reports, coverage
  // and mutation, and reused results against their producer. This holds
  // whether or not the operator asks for an agent-written analysis.
  let evidenceProblem = verifyRun.status === 0 && suppliedResults === undefined ? 'verify returned no check results' : null;
  // A verifier that could not answer measured none of these steps. Required
  // omissions describe that absence without inventing a failed measurement
  // or claiming that an unreadable rulebook disabled a check.
  let results = TEST_QUALITY_RESULTS.map(name => ({ name, status: 'skipped',
    reason: 'Verify supplied no usable results.', evidence: [], summary: {} }));
  if (suppliedResults !== undefined) {
    try {
      validateChecksResults(suppliedResults, 'results', state.entries.length + 1);
      results = suppliedResults;
      validateVerificationEvidence(results, reading);
      if (verifyRun.status === 0 && results.some(result => result.status === 'failed')) {
        throw new Error('a successful verify contains a failed result');
      }
    } catch (error) {
      evidenceProblem = `verify returned unusable check evidence: ${error.message}`;
      const failed = results.find(result => result.name === error.resultName);
      if (failed) {
        failed.status = 'failed';
        failed.reason = 'Verification evidence could not be validated.';
        delete failed.source;
        failed.summary = { ...failed.summary, diagnostics: error.message };
      }
    }
  }
  // A request can open and close while verify is running. Either decision
  // makes this run obsolete, even if the tree still matches at publication.
  const interrupted = entries => entries.slice(state.entries.length).some(e => e.event === 'replan_requested');
  const deferred = { outcome: 'changed', why: 'A plan revision was requested during verification. Check the current plan before continuing.' };
  const failed = text => {
    // Failure may have come from an invalid rulebook, so read the logbook
    // directly. A full state read would conceal the original diagnostic.
    const { entries } = readChain(state.dir, state.branch);
    if (interrupted(entries)) return deferred;
    const event = append(state.dir, 'verify_failed', { ...inputs, tail: tail(text, 20), results, ...marked }, state.branch, entries.length);
    return { outcome: 'failed', text, event };
  };
  if (verifyRun.status !== 0 || evidenceProblem) {
    const diagnostic = `${verifyRun.stdout ?? ''}${verifyRun.stderr ?? ''}${verifyRun.error ? `\n${verifyRun.error.message}` : ''}`;
    return failed(verifyRun.status === 0 ? evidenceProblem : [evidenceProblem, diagnostic].filter(Boolean).join('\n'));
  }
  if (rulebookFingerprint === null) return failed('The rulebook could not be read at the start of verification.');
  let analysing;
  // The summary and the analysis request read the evidence the results
  // name. Unreadable evidence fails the pass before any receipt.
  let report, after;
  try {
    analysing = analysisRequired();
    report = readableEvidence(results, reading, analysing);
    after = current();
  } catch (error) {
    // A deleted or invalid rulebook can prevent a second state read.
    if (readRulebookFingerprint() !== rulebookFingerprint) {
      return { outcome: 'changed', why: 'The rulebook changed during verify. Run verification again.' };
    }
    return failed(`verify returned unusable check evidence: ${error.message}`);
  }
  if (interrupted(after.entries)) return deferred;
  if (!sameMeasurement(state, after)) {
    const changed = rulebookFingerprint !== after.rulebookFingerprint ? 'rulebook'
      : baseline !== after.baseline ? 'baseline' : 'working tree or approval';
    return { outcome: 'changed', why: after.drift ? after.why : `The ${changed} changed during verify. Run verification again.` };
  }
  const receipt = append(state.dir, 'verified', { ...inputs, results,
    testFingerprint: state.testFingerprint, implementationFingerprint: state.implementationFingerprint, ...marked }, state.branch, after.entries.length);
  const warnings = strayed.length > 0 ? [`The plan declared this change test-only, and these are not tests: ${strayed.join(', ')}`] : [];
  return {
    outcome: 'passed',
    receipt,
    messages: [
      summaryMessage(state, receipt, { warnings, review: reviewLines(state) }),
      analysing && report && message('info', 'agent', analysisRequest(receipt.seq, report)),
    ].filter(Boolean),
  };
}

/**
 * Read the evidence the summary and the analysis report read, so evidence
 * that cannot be read fails the pass before any receipt: coverage and
 * mutation. Reuse sources were checked by `validateVerificationEvidence`,
 * and the summary never reads them. Returns the analysis report, or null
 * when no analysis is asked for.
 */
function readableEvidence(results, context, analysing) {
  for (const result of results) {
    if (!usable(result)) continue;
    if (result.name === 'coverage') coverageMeasurement(result, context);
    if (result.name === 'mutation') readMutationSnapshot(context.branch, mutationReferences(result));
  }
  return analysing ? reportOf(results, context) : null;
}
