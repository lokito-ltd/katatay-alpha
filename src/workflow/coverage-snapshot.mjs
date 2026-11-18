/**
 * The coverage a verification measured, kept as two snapshots under the
 * branch's local folder: the raw report the coverage command printed, and the
 * referee's analysis of it. The `verified` or `verify_failed` event names both.
 *
 * The working output file, such as `reports/checks/coverage.json`, can change
 * or vanish after verify: a manual `workflow coverage`, a later run, a
 * cleanup. A verification's evidence must not change with it, so everything
 * read after verify comes from these files, each named by the SHA-256 digest
 * of its bytes and checked against it on every read.
 *
 * Two references, not one: the analysis is what the referee decided, the raw
 * report what it decided from. Either can be checked without the other.
 */
import { coverageReferencesProblem } from './event-format.mjs';
import { publishSnapshot, readSnapshot } from './local-snapshot.mjs';
import { coverageAnalysis } from './coverage.mjs';
import { leniently } from './json-fields.mjs';

const raw = { folder: 'coverage', extension: 'lcov', label: 'raw coverage' };
const analysis = { folder: 'coverage', extension: 'json', label: 'coverage analysis' };

/** Publish both and return the references the event stores. The event is
 * appended after this returns, so it can only name complete files. */
export function writeCoverageSnapshot(branch, report, root = process.cwd()) {
  return {
    raw: publishSnapshot(branch, raw, Buffer.from(report.raw), root),
    analysis: publishSnapshot(branch, analysis, Buffer.from(report.analysis), root),
  };
}

/**
 * The analysis a verification kept, after checking both files.
 *
 * @param {string} branch
 * @param {unknown} references the event's `coverage`
 * @param {string | null} baseline the baseline at the producing verification
 * @returns {ReturnType<typeof coverageAnalysis>}
 */
export function readCoverageSnapshot(branch, references, baseline, root = process.cwd()) {
  if (references === undefined) throw new Error('No coverage snapshots were recorded');
  const problem = coverageReferencesProblem(references);
  if (problem) throw new Error(`Invalid coverage references: ${problem}`);
  const read = (kind, reference) => {
    try { return readSnapshot(branch, kind, reference, root); }
    catch (error) { throw new Error(`${kind.label} (${reference}): ${error.message}`); }
  };
  read(raw, references.raw);
  let document;
  try { document = JSON.parse(read(analysis, references.analysis).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`coverage analysis (${references.analysis}): not JSON`);
    throw error;
  }
  // Stored by an earlier run: fields its format no longer lists are ignored.
  return leniently(() => coverageAnalysis(document, baseline, true, `${references.analysis}: coverage analysis`));
}
