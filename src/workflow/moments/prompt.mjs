#!/usr/bin/env node
/**
 * `on prompt`: the operator sent a message. Records the operator's `reset` and
 * `record`, and tells the agent where it is, so knowing never depends on it
 * having remembered.
 *
 * In:  `{ version, prompt: string }`, the operator's message as they typed it.
 * Out: `{ version, messages }`, with no decision: a prompt is never refused.
 *      What happened to the operator's word comes first (`reset`, `declared`,
 *      `held`, `not_declared`, `recorded` for a `record` repeated on a
 *      recorded tree, or `stop` on a broken logbook), then news
 *      (`info`), then the agent's setup warnings (`warning`), and last where
 *      the change stands (`state`). When the state cannot be read at all, the
 *      answer is one `stop` instead.
 */
import { fileURLToPath } from 'node:url';
import { operatorToken } from '../hooks/operator.mjs';
import { current, followTarget, summarise } from '../state.mjs';
import { join } from 'node:path';
import { analysisRequired } from '../rulebook.mjs';
import { acceptedText, analysisRequest, analysisSummary, lostAnalysisSummary } from '../checks-analysis.mjs';
import { reportFor } from '../checks-report.mjs';
import { append, fileFor } from '../chain.mjs';
import { heldFor, latestVerified, receiptFor, REPLAN_PENDING, testsChangedSinceVerify, verificationMismatch, sameMeasurement } from '../phase.mjs';
import { REPORT_TIMEOUT_MS, readReport, recordContext, recordDecision, repeatedRecordContext } from '../record.mjs';
import { runReferee } from '../runtime.mjs';
import { writeChangeReport } from '../change-summary.mjs';
import { TargetError } from '../target.mjs';
import { setupMessages } from '../agent.mjs';
import { serve, versionShape } from './io.mjs';
import { answer, message } from './messages.mjs';

export const SHAPE = { version: versionShape, prompt: 'string' };

/** The change report, started through `../runtime.mjs` like the referee's other
 *  TypeScript, and found from this file so it works in any repository. */
const REPORT = fileURLToPath(new URL('../../evidence/report.ts', import.meta.url));

function recordVerified(state, token) {
  const receipt = receiptFor(state.live, state);
  let savedAnalysis;
  if (analysisRequired()) {
    const event = state.live.find(e => e.event === 'checks_analysis' && e.payload.verification === receipt.seq && e.seq > receipt.seq);
    if (!event) {
      let report;
      try { report = reportFor(receipt, state.live); }
      catch (error) {
        return message('not_declared', 'operator', `Verification ${receipt.seq} needs its checks analysis, but its evidence cannot be read: ${error.message}. `
          + 'Nothing was declared. Restore the files it names, and tell the operator.');
      }
      return message('not_declared', 'operator', `Verification ${receipt.seq} needs its checks analysis. This attempt was not a hold or declaration.\n\n`
        + analysisRequest(receipt.seq, report) + '\n\nMeasured evidence:\n' + JSON.stringify(report, null, 2)
        + '\nWait for the operator to type `record` again after presenting the accepted analysis.');
    }
    const logged = join(state.dir, fileFor(event));
    let summary;
    try { summary = analysisSummary({ text: acceptedText(state.branch, event, receipt), seq: receipt.seq, link: logged }); }
    catch (error) {
      summary = lostAnalysisSummary({ summary: event.payload.summary, seq: receipt.seq, link: logged, evidence: event.payload.analysisSnapshot, why: error.message });
    }
    savedAnalysis = `The accepted analysis is recorded in ${logged}. If its summary is missing from this chat, show it verbatim:\n\n${summary}`;
  }
  const built = readReport(runReferee(REPORT, ['--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: REPORT_TIMEOUT_MS,
  }));
  const after = current();
  if (after.replan) return message('not_declared', 'operator', REPLAN_PENDING);
  if (!sameMeasurement(state, after) || latestVerified(after.live)?.seq !== receipt.seq) {
    return message('not_declared', 'operator', after.drift || !receiptFor(after.live, after)
      ? recordMismatch(after) : 'The verification changed while the report ran. Type `record` again for the current receipt.');
  }
  const acted = testsChangedSinceVerify(state.live, receipt);
  const held = heldFor(after.live, after) !== null;
  const decision = recordDecision({
    report: 'report' in built ? built.report : null,
    held,
    acted,
  });
  if (decision === 'stop') return message('not_declared', 'operator', recordContext({ decision, built, held }));
  const { lines, summary, gaps } = built.report;
  const event = decision === 'declare' ? 'declared' : 'record_held';
  // The full report the decision was made on, kept before the event that
  // names it, so the event never points at a file that was not written.
  const changeReportSnapshot = writeChangeReport(state.branch, { treeFingerprint: state.treeFingerprint, decision: event, lines, summary, gaps });
  const link = join(state.dir, fileFor({ seq: after.entries.length + 1, event }));
  if (decision === 'declare') {
    // The gaps the operator accepted, kept with their word, and the
    // report summary, which the change file must open with. See
    // `reportSection` in `../record.mjs`.
    append(state.dir, 'declared', { treeFingerprint: state.treeFingerprint, note: token.note, gaps, summary, changeReportSnapshot }, state.branch, after.entries.length);
  } else {
    append(state.dir, 'record_held', { treeFingerprint: state.treeFingerprint, note: token.note, gaps, changeReportSnapshot }, state.branch, after.entries.length);
  }
  return message(decision === 'declare' ? 'declared' : 'held', 'operator',
    recordContext({ decision, built, held, acted, savedAnalysis, link, reportFile: changeReportSnapshot }));
}

function recordMismatch(state) {
  if (state.drift) return state.why;
  const mismatch = verificationMismatch(latestVerified(state.live)?.payload, state);
  if (mismatch) return mismatch;
  return `The operator typed \`record\`, but it was not recorded. The change is ${state.phase}, and only a verified working tree can be declared finished. Tell the operator.`;
}

export function onPrompt({ prompt }) {
  try {
    const token = operatorToken(prompt);
    const notes = [];
    const refusedOnBroken = (state) => message('stop', 'operator', `Refused to record \`${token.token}\`: the state chain is broken (${state.broken}).`);

    // A reset abandons the change epoch, so it is also how a logbook broken
    // only by a missing change file is mended: the `recorded` event naming the
    // file belongs to the epoch it abandons. Any other breakage is in events
    // every later read still sees, and a reset on top would fix nothing.
    if (token?.token === 'reset') {
      const state = current();
      if (state.broken && !state.resetRepairs) {
        notes.push(refusedOnBroken(state));
      } else {
        const changeFiles = [...state.changeFiles, ...state.earlierChangeFiles].sort();
        append(state.dir, 'reset', { note: token.note, ...(changeFiles.length > 0 ? { changeFiles } : {}) }, state.branch);
        notes.push(message('reset', 'agent', 'The operator reset the workflow. The logbook is intact, and a new change epoch starts here.'));
        if (changeFiles.length > 0) {
          notes.push(message('info', 'operator', 'These change files are on the branch from before the reset. They no longer count for the change, '
            + 'but they stay on the branch and are merged with it. Delete any you do not want:\n\n'
            + changeFiles.map((file) => `  ${file}`).join('\n')));
        }
      }
    }

    // `record` is a statement about the code as it stands, so it needs the
    // tree, and it is worth something only once that tree has passed
    // verification. Said earlier, it would declare finished a change nobody
    // has seen go green.
    if (token?.token === 'record') {
      const state = current();
      if (state.broken) {
        notes.push(refusedOnBroken(state));
      } else if (state.replan) {
        notes.push(message('not_declared', 'operator', REPLAN_PENDING));
      } else if (!state.drift && state.declaration && (state.phase === 'declared' || state.phase === 'recorded')) {
        // Already declared on this tree. Another `record` must not declare it
        // twice, nor send a recorded change back to `declared`. It repeats the
        // handoff instead, which is how a lost one is recovered.
        const context = repeatedRecordContext({ phase: state.phase, summary: state.declaration.payload.summary,
          link: join(state.dir, fileFor(state.declaration)), changeFiles: state.changeFiles });
        notes.push(state.phase === 'recorded' ? message('recorded', 'agent', context) : message('declared', 'operator', context));
      } else if (state.drift || !receiptFor(state.live, state)) {
        notes.push(message('not_declared', 'operator', recordMismatch(state)));
      } else {
        notes.push(recordVerified(state, token));
      }
    }

    // After the operator's word, so a `record` is judged against the baseline
    // it was typed under. A sync made since the last turn is caught up here.
    let state = current();
    if (followTarget(state)) {
      const moved = current();
      notes.push(message('info', 'agent', `The target was merged into this branch, so the baseline moved forward from ${state.baseline.slice(0, 12)} to ${moved.baseline.slice(0, 12)}.`));
      state = moved;
    }
    // The agent's own setup is asked of the agent adapter's `check` command,
    // as `state:show` asks it. See `agent.mjs`.
    return answer({}, [...notes, ...setupMessages(), message('state', 'agent', summarise(state))]);
  } catch (error) {
    // Injecting context is a convenience. Failing at it must not swallow the
    // prompt. No target is said as the refusal it is, so the agent stops.
    return answer({}, [message('stop', 'operator', error instanceof TargetError
      ? `workflow: refused — ${error.message}\nStop and tell the operator.`
      : `workflow: state unavailable (${error.message})`)]);
  }
}

await serve(import.meta.url, 'prompt', SHAPE, onPrompt);
