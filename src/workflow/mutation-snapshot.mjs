/** Mutation evidence belonging to a verification. The working report may be
 * replaced by another run; these digest-named files preserve the report and
 * what the referee derived from it. Both must be readable before a passing
 * receipt can name them. */
import { isDeepStrictEqual } from 'node:util';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutationReferencesProblem, validateMutationAnalysis } from './event-format.mjs';
import { publishSnapshot, readSnapshot } from './local-snapshot.mjs';
import { mutationReason } from './mutation.mjs';
import { checkDocument } from './result-format.mjs';
import { leniently } from './json-fields.mjs';

// Both are JSON, so the folder identifies the kind when reading a reference.
const raw = { folder: 'mutation/raw', extension: 'json', label: 'raw mutation report' };
const findings = { folder: 'mutation/findings', extension: 'json', label: 'mutation findings' };

/** Publish both files before the event names them. */
export function writeMutationSnapshot(branch, { raw: standardReport, status, outcome, report, findings: measured }, root = process.cwd()) {
  const document = checkDocument('mutation', {
    outcome: outcome === 'clean' ? 'clean' : 'findings', code: status, text: report, reason: mutationReason(outcome, measured),
  }, { toolOutcome: outcome, findings: measured });
  validateMutationAnalysis(document);
  return {
    raw: publishSnapshot(branch, raw, Buffer.from(standardReport), root),
    findings: publishSnapshot(branch, findings, Buffer.from(JSON.stringify(document) + '\n'), root),
  };
}

/** Check both digests and bind the analysis to the raw report it describes. */
export function readMutationSnapshot(branch, references, root = process.cwd()) {
  if (references === undefined) throw new Error('No mutation snapshots were recorded');
  const problem = mutationReferencesProblem(references);
  if (problem) throw new Error(`Invalid mutation references: ${problem}`);
  const read = (kind, reference) => {
    try { return JSON.parse(readSnapshot(branch, kind, reference, root).toString('utf8')); }
    catch (error) {
      const why = error instanceof SyntaxError ? 'not JSON' : error.message;
      throw new Error(`${kind.label} (${reference}): ${why}`);
    }
  };
  const standardReport = read(raw, references.raw);
  const document = read(findings, references.findings);
  // Stored by an earlier run: fields its format no longer lists are ignored.
  leniently(() => validateMutationAnalysis(document, `${references.findings}: mutation analysis`));
  if (!isDeepStrictEqual(findingsOf(standardReport), document.measurement.findings)) {
    throw new Error('Mutation findings do not match the raw report');
  }
  return { status: document.result.exitCode, report: document.result.text,
    outcome: document.measurement.toolOutcome, findings: document.measurement.findings };
}
