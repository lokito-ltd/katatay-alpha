import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { current } from '../state.mjs';
import { append, fileFor } from '../chain.mjs';
import { checksAnalyses, publishSnapshot } from '../local-snapshot.mjs';
import { analysisRequired } from '../rulebook.mjs';
import { receiptFor } from '../phase.mjs';
import { reportFor } from '../checks-report.mjs';
import { acceptedText, analysisSummary, savedAnalysis, summaryOf, validateAnalysis } from '../checks-analysis.mjs';

export function submitAnalysis(seq, text) {
  const state = current();
  if (state.broken) throw new Error(`The logbook is broken: ${state.broken}`);
  if (!analysisRequired()) throw new Error('checks.requireAnalysis is off.');
  const receipt = receiptFor(state.live, state);
  if (!receipt || String(receipt.seq) !== seq) throw new Error(`Verification ${seq} is not the current receipt for this tree.`);
  const saved = state.live.find(e => e.event === 'checks_analysis' && e.payload.verification === receipt.seq && e.seq > receipt.seq);
  if (saved) {
    let accepted;
    try { accepted = acceptedText(state.branch, saved, receipt); }
    catch (error) { throw new Error(`The analysis accepted in ${fileFor(saved)} cannot be read from ${saved.payload.analysisSnapshot}: ${error.message}`); }
    return { text: analysisSummary({ text: accepted, seq: receipt.seq, link: join(state.dir, fileFor(saved)) }), conflict: accepted === text ? null
      : `A different analysis was already accepted in ${fileFor(saved)}. Its summary is on stdout.` };
  }
  if (state.phase !== 'verified') throw new Error('Analysis can only be submitted for a verified change.');
  // Lost evidence is said as lost, never as a fault in the agent's text.
  let report;
  try { report = reportFor(receipt, state.live); }
  catch (error) { throw new Error(`Verification ${seq}'s evidence cannot be read: ${error.message}. Restore the files it names. No analysis recorded.`); }
  try { validateAnalysis(report, text); }
  catch (error) { throw new Error(`Verification ${seq}: ${error.message}. No analysis recorded.`); }
  const analysisSnapshot = publishSnapshot(state.branch, checksAnalyses, savedAnalysis(text, receipt));
  const event = append(state.dir, 'checks_analysis', { verification: receipt.seq, summary: summaryOf(text), analysisSnapshot }, state.branch, state.entries.length);
  return { text: analysisSummary({ text, seq: receipt.seq, link: join(state.dir, fileFor(event)) }), conflict: null };
}

export function runChecksAnalysis(args, inputFd = 0) {
  try {
    const [seq, ...extra] = args;
    if (!/^[1-9]\d*$/.test(seq ?? '') || extra.length) throw new Error('usage: workflow checks-analysis <verification-seq> (analysis on stdin)');
    const result = submitAnalysis(seq, readFileSync(inputFd, 'utf8'));
    process.stdout.write(result.text + '\n');
    if (result.conflict) throw new Error(result.conflict);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runChecksAnalysis(process.argv.slice(2));
