/**
 * Readers of one verification's unified results, `payload.results`, the only
 * evidence a receipt carries.
 *
 * Absence is never a measurement. A missing result, a skipped one, or one
 * whose evidence cannot be read throws or reads as not measured here. None of
 * them reads as clean, complete or zero.
 */
import { checkedSource, readArtifacts, resultIn } from './verification-results.mjs';
import { readCoverageSnapshot } from './coverage-snapshot.mjs';
import { readTestAnalysis } from './junit-snapshot.mjs';
import { readBaseline } from './phase.mjs';

/** The named result in a set of unified results, or null. */
export const resultNamed = (results, name) => resultIn({ payload: { results } }, name) ?? null;

/** A result a later reader can use: run on this pass, or reused from an
 * earlier one. Skipped and failed results measured nothing. */
export const usable = result => ['ok', 'partial', 'reused'].includes(result?.status);

/** The snapshot paths a result names for one evidence role. Roles say what a
 * file is; titles are for people and never choose a reader. */
export const snapshotsOf = (result, role) => result.evidence.filter(item => item.role === role).map(item => item.snapshot);

function only(result, role) {
  const [snapshot, ...more] = snapshotsOf(result, role);
  if (!snapshot || more.length) throw new Error(`The ${result.name} result names ${more.length ? 'more than one' : 'no'} ${role} snapshot`);
  return snapshot;
}

/** Throws unless the result exists and measured something. */
export function requireUsable(result, name) {
  if (!result) throw new Error(`The verification recorded no ${name} result`);
  if (!usable(result)) throw new Error(`The verification's ${name} result is ${result.status}: ${result.reason}`);
  return result;
}

/** Coverage snapshots as `readCoverageSnapshot` takes them. */
export const coverageReferences = result => ({ raw: only(result, 'raw'), analysis: only(result, 'analysis') });

/** Mutation snapshots as `readMutationSnapshot` takes them. */
export const mutationReferences = result => ({ raw: only(result, 'raw'), findings: only(result, 'analysis') });

/** Coverage is measured against the baseline at its producing event. */
export function coverageMeasurement(result, context) {
  requireUsable(result, 'coverage');
  const { branch, root } = context;
  const source = producerEvent(result, context);
  const baseline = readBaseline(source?.payload.baseline) ?? context.baseline;
  return readCoverageSnapshot(branch, coverageReferences(result), baseline, root);
}

export function testMeasurement(result, branch, root = process.cwd(), status = result?.status) {
  requireUsable(result, 'tests');
  return readTestAnalysis(branch, result.evidence, root, status);
}

/** The JUnit reports a tests result names, read and digest-checked. The
 * report's file name lives only in the title, so the snapshot path names it. */
export function junitReports(result, branch, root = process.cwd()) {
  requireUsable(result, 'tests');
  const reports = readArtifacts({ ...result, evidence: result.evidence.filter(item => item.role === 'raw') }, branch, root)
    .map(item => ({ name: item.snapshot, bytes: item.bytes }));
  if (!reports.length) throw new Error('The verification recorded no JUnit report');
  return reports;
}

/**
 * The verified event that produced a reused result, validated as reuse is
 * at turn end: under the current approval, before `before`, and with the
 * fingerprint of its exact bytes. Null for a result that was not reused.
 */
export function producerEvent(result, context) {
  if (result.status !== 'reused') return null;
  return checkedSource(result.source, context);
}

/** The tree a usable result measured: the producer's for a reused one. */
export function measuredTree(result, treeFingerprint, context) {
  return producerEvent(result, context)?.payload.treeFingerprint ?? treeFingerprint;
}

/** The text a general check printed, from its raw snapshot, or ''. */
export function checkText(result, branch, root = process.cwd()) {
  const raw = readArtifacts({ ...result, evidence: result.evidence.filter(item => item.role === 'raw') }, branch, root);
  return raw.map(item => item.bytes.toString('utf8')).join('\n');
}
