/** The evidence an agent can still inspect after the runner's outputs disappear. */
import { mutationIncomplete } from './mutation.mjs';
import { currentBranch } from './chain.mjs';
import { readBaseline } from './phase.mjs';
import { readMutationSnapshot } from './mutation-snapshot.mjs';
import { checkText, coverageMeasurement, mutationReferences, producerEvent, requireUsable, resultNamed, testMeasurement, usable } from './result-readers.mjs';
import { readSavedCheck } from './verification-results.mjs';

const unavailable = reason => ({ status: 'unavailable', reason });
const skipped = reason => ({ status: reason.startsWith('Mutation testing deferred:') ? 'deferred' : 'skipped', reason });

function mutationReport(measurement, reason, treeFingerprint) {
  const survivors = measurement.findings.survivors.map(({ location, ...variant }) => ({ ...variant, line: location.start.line }));
  const incomplete = mutationIncomplete(measurement.outcome, measurement.findings);
  return { ...(incomplete ? { status: 'partial', reason } : { status: 'complete' }),
    ...(treeFingerprint ? { treeFingerprint } : {}), survivors };
}

/** Runs a reader of one result's evidence. A failure names the result, so
 * lost or altered evidence never reads as some other problem. */
function reading(name, read) {
  try { return read(); }
  catch (error) { throw new Error(`the ${name} evidence cannot be read: ${error.message}`); }
}

/**
 * The checks report, read from a verification's unified results and the
 * snapshots they name, and from nothing else. The rulebook sits outside the
 * tree fingerprint, and historical reports describe the rules that ran. Reading it here
 * would check an analysis against a run other than the one verify asked
 * about. The results already say what the run measured: the runner seeds one
 * result for every check its rulebook configured, and a switched-off check is
 * a skipped result with its reason. A reused result is marked with its
 * producer's tree, which is validated on the way.
 *
 * The context identifies the consuming verification, its inputs and its logbook.
 */
export function reportOf(results, context) {
  const { branch, root = process.cwd() } = context;
  const producerFingerprint = result => producerEvent(result, context)?.payload.treeFingerprint;
  const treeOf = result => {
    const treeFingerprint = producerFingerprint(result);
    return treeFingerprint ? { treeFingerprint } : {};
  };

  const coverage = (() => {
    const result = resultNamed(results, 'coverage');
    if (!result) return { ...unavailable('Verify supplied no coverage result.'), uncovered: [] };
    if (result.status === 'skipped') return { ...skipped(result.reason), uncovered: [] };
    if (!usable(result)) return { ...unavailable(result.reason), uncovered: [] };
    return reading('coverage', () => {
      const tree = treeOf(result);
      const touched = coverageMeasurement(result, context).touched;
      if (!touched) return { ...unavailable('The touched lines could not be measured.'), uncovered: [], ...tree };
      const uncovered = touched.uncovered.flatMap(({ file, lines }) => lines.map(line => ({ file, line })));
      return { status: 'complete', ...tree, uncovered };
    });
  })();

  const mutation = (() => {
    const result = resultNamed(results, 'mutation');
    if (!result) return { ...unavailable('Verify supplied no validated mutation run.'), survivors: [] };
    if (result.status === 'skipped') return { ...skipped(result.reason), survivors: [] };
    if (!usable(result)) return { ...unavailable(result.reason), survivors: [] };
    return reading('mutation', () => {
      const run = readMutationSnapshot(branch, mutationReferences(result), root);
      return mutationReport(run, run.report, producerFingerprint(result));
    });
  })();

  const general = result => {
    const { name } = result;
    if (result.status === 'skipped') return { name, ...skipped(result.reason) };
    if (!usable(result)) return { name, ...unavailable(result.reason) };
    return reading(name, () => {
      const producer = producerEvent(result, context);
      const tree = producer ? { treeFingerprint: producer.payload.treeFingerprint } : {};
      if (name === 'tests') {
        const original = producer ? requireUsable(resultNamed(producer.payload.results, name), name) : result;
        testMeasurement(result, branch, root, original.status);
        if (original.status === 'partial') return { name, status: 'partial', reason: original.reason, ...tree };
        return { name, status: 'clean', ...tree };
      }
      readSavedCheck(result, branch, root);
      const status = result.summary.outcome;
      return { name, status, ...(status === 'findings' ? { report: checkText(result, branch, root) || result.reason } : {}), ...tree };
    });
  };
  const ordered = results.filter(result => !['coverage', 'mutation'].includes(result.name));
  return { coverage, mutation, checks: ordered.map(general) };
}

/** A receipt's report, built from its recorded checks. */
export function reportFor(receipt, live, root = process.cwd()) {
  const { results, rulebookFingerprint } = receipt.payload;
  return reportOf(results, { live, branch: currentBranch(), root, before: receipt.seq,
    baseline: readBaseline(receipt.payload.baseline), rulebookFingerprint });
}
