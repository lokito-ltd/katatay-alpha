/** Produces a verification's unified results and validates them, reuse
 * included. Snapshots belong to a run, not to whichever working output exists
 * later. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { unprovedCount } from '../evidence/mutation-report.mjs';
import { dirFor, fileFor, readChain, sha256 } from './chain.mjs';
import { publishSnapshot, readNamedSnapshot } from './local-snapshot.mjs';
import { checkedOutput } from './check-output.mjs';
import { current } from './state.mjs';
import { readMutationSnapshot } from './mutation-snapshot.mjs';
import { coverageAnalysis } from './coverage.mjs';
import { readBaseline, sameVerificationInputs } from './phase.mjs';
import { junitArtifacts, readTestAnalysis, TEST_ANALYSIS, writeTestAnalysis } from './junit-snapshot.mjs';
import { mutationIncomplete } from './mutation.mjs';
import { leniently, schemaVersion, versionedReader } from './json-fields.mjs';
import { brief, checkDocument, checkDocumentFields, TEST_QUALITY_RESULTS, validateChecksResults, validateResult, validateTestRun } from './result-format.mjs';

const rawCheck = { folder: 'checks/raw', extension: 'txt', label: 'check output' };
const analysedCheck = { folder: 'checks/analysis', extension: 'json', label: 'check analysis' };
const kinds = {
  tests: { raw: { folder: 'junit', extension: 'xml', label: 'JUnit XML' }, analysis: TEST_ANALYSIS },
  coverage: {
    raw: { folder: 'coverage', extension: 'lcov', label: 'raw coverage' },
    analysis: { folder: 'coverage', extension: 'json', label: 'coverage analysis' },
  },
  mutation: {
    raw: { folder: 'mutation/raw', extension: 'json', label: 'raw mutation report' },
    analysis: { folder: 'mutation/findings', extension: 'json', label: 'mutation findings' },
  },
};
const artifact = (role, title, snapshot) => ({ role, title: brief(title), snapshot });
const skipped = (name, reason) => ({ name, status: 'skipped', reason: brief(reason), evidence: [], summary: {} });
const mutationSummary = ({ findings: { counts: c } }) => ({ totalMutants: c.total, killed: c.caught, survived: c.survived,
  unproved: unprovedCount(c), ignored: c.statuses.Ignored,
  errored: c.statuses.CompileError + c.statuses.RuntimeError });
const coverageSummary = measurement => ({ folders: measurement.folders.map(({ folder, lines, branches }) => ({ folder,
  lines: { percent: lines.measured / 10, target: lines.minimum / 10 },
  branches: { percent: branches.measured / 10, target: branches.minimum / 10 } })) });
const generalSummary = result => ({ outcome: result.outcome, ...(result.code === undefined ? {} : { exitCode: result.code }) });
export const resultIn = (event, name) => event.payload.results.find(item => item.name === name);
const afterApproval = live => live.slice(live.findLastIndex(event => event.event === 'plan_approved') + 1);

/** Every evidence file a result names, read and digest-checked, with its bytes. */
export function readArtifacts(result, branch, root = process.cwd()) {
  return result.evidence.map(item => ({ ...item, bytes: readNamedSnapshot(branch,
    kinds[result.name]?.[item.role] ?? (item.role === 'raw' ? rawCheck : analysedCheck), item.snapshot, root) }));
}

export function checkedSource(source, context) {
  const { live, branch, root = process.cwd(), before = Infinity } = context;
  const history = live.filter(entry => entry.seq < before);
  if (!history.some(event => event.event === 'plan_approved')) throw new Error('Reuse has no current approval');
  const event = afterApproval(history).find(entry => entry.seq === source.seq && entry.event === 'verified');
  if (!event) throw new Error('Reuse source is not an earlier verified event under this approval');
  if (!sameVerificationInputs(event.payload, context)) throw new Error('Reuse source has a different rulebook or baseline');
  const { entries, broken } = readChain(join(root, dirFor(branch)), branch);
  if (broken) throw new Error(`Reuse source logbook is broken: ${broken}`);
  const disk = entries.find(entry => entry.seq === event.seq);
  const bytes = readFileSync(join(root, dirFor(branch), fileFor(event)));
  if (!isDeepStrictEqual(disk, event) || sha256(bytes) !== source.fingerprint) throw new Error('Reuse source fingerprint does not match its verification');
  return event;
}

function originalSource(event, branch, root) {
  return { seq: event.seq, fingerprint: sha256(readFileSync(join(root, dirFor(branch), fileFor(event)))) };
}

/** A coverage or mutation result's snapshots, keyed as their readers expect. */
export function referencesOf(result) {
  return Object.fromEntries(result.evidence.map(item => [item.role === 'analysis' ? 'findings' : item.role, item.snapshot]));
}

/** Verify provenance against the original event: its own result for the
 * check must be complete or partial, with the same summary and evidence.
 * Validate the original measurement too: reuse cannot turn a changed status
 * or a false summary into trusted evidence merely by copying it. */
function validateReuse(result, context) {
  const { branch, root } = context;
  const source = checkedSource(result.source, context);
  const original = resultIn(source, result.name);
  if (!original) throw new Error(`Reuse source ${source.seq} has no ${result.name} result`);
  if (!['ok', 'partial'].includes(original.status) || !isDeepStrictEqual(original.summary, result.summary)
    || !isDeepStrictEqual(original.evidence, result.evidence)) throw new Error('Reused evidence differs from the original successful result');
  // The original is stored in an earlier event, so it is read leniently.
  leniently(() => validateResult(original));
  validateMeasurement(original, { branch, root, baseline: readBaseline(source.payload.baseline) });
}

const readCheckDocument = versionedReader((document, at, result, raw) => {
  checkDocumentFields(result.name)(document, at);
  if (document.result.outcome !== result.summary.outcome || document.result.exitCode !== result.summary.exitCode) {
    throw new Error('Check analysis differs from its producing measurement');
  }
  if ((raw?.bytes.toString('utf8') ?? '') !== document.result.text) throw new Error('Check output differs from its analysis');
});

function validateSavedCheck(result, files) {
  const raw = files.find(item => item.role === 'raw');
  for (const analysis of files.filter(item => item.role === 'analysis')) {
    const document = JSON.parse(analysis.bytes);
    leniently(() => readCheckDocument(document, `${analysis.snapshot}: check analysis`, result, raw));
  }
}

/** Ordinary checks can keep a result document alongside the printed bytes. */
export function readSavedCheck(result, branch, root = process.cwd()) {
  if (result.evidence.some(item => item.role === 'analysis')) {
    validateSavedCheck(result, readArtifacts(result, branch, root));
  }
}

function validateMeasurement(result, { branch, root, baseline }) {
  const files = readArtifacts(result, branch, root);
  if (result.name === 'tests') {
    const run = readTestAnalysis(branch, result.evidence, root, result.status);
    leniently(() => validateTestRun(run, true));
    if (!isDeepStrictEqual(testSummary(run), result.summary)) {
      throw new Error('Test summary or status differs from its evidence');
    }
  }
  if (result.name === 'mutation') {
    const run = readMutationSnapshot(branch, referencesOf(result), root);
    if (!isDeepStrictEqual(mutationSummary(run), result.summary)
      || (result.status === 'partial') !== mutationIncomplete(run.outcome, run.findings)) {
      throw new Error('Mutation summary or status differs from its evidence');
    }
  }
  if (result.name === 'coverage') {
    const analysis = files.find(item => item.role === 'analysis');
    const measurement = leniently(() => coverageAnalysis(JSON.parse(analysis.bytes), baseline, true, `${analysis.snapshot}: coverage analysis`));
    if (!isDeepStrictEqual(coverageSummary(measurement), result.summary)) throw new Error('Coverage summary differs from its measurement');
  }
  if (!TEST_QUALITY_RESULTS.includes(result.name)) {
    validateSavedCheck(result, files);
  }
}

/** Used by the writer and by turn end before trusting its transport. Failed
 * results may name damaged evidence for diagnosis; only usable results vouch
 * for evidence. The event schema still checks every reference's shape. */
export function validateVerificationEvidence(results, context) {
  const { branch, root = process.cwd(), before = Infinity, baseline } = context;
  validateChecksResults(results, 'results', before);
  for (const result of results) {
    try {
      if (result.status === 'reused') validateReuse(result, context);
      if (['ok', 'partial'].includes(result.status)) validateMeasurement(result, { branch, root, baseline });
    } catch (error) { error.resultName = result.name; throw error; }
  }
}

/** Whether a unified result is this approval's run of a once-per-plan
 * check. A skipped or failed result ran nothing that a later pass could use. */
const ran = result => ['ok', 'partial', 'reused'].includes(result?.status);

/**
 * Which verification produced this approval's run of a once-per-plan check,
 * read newest first. The first receipt whose result for the check ran
 * decides. An `ok` or `partial` result is its own producer; a `reused` one names its
 * producer in `source`, which is validated here. `result` is the usable
 * result: the original, or the reused copy carrying the same evidence and
 * summary.
 *
 * A skipped or failed result supplies no measurement, so an older receipt is asked. Returns null when
 * nothing under the current approval ran it.
 *
 * @param {string} name
 * @param {{ live: any[], branch: string, root?: string, rulebookFingerprint: string|null, baseline: string|null }} context
 * @returns {any}
 */
export function producerOf(name, context) {
  const { live } = context;
  if (!live.some(event => event.event === 'plan_approved')) return null;
  const epoch = afterApproval(live);
  for (const event of [...epoch].reverse()) {
    if (event.event !== 'verified' || !sameVerificationInputs(event.payload, context)) continue;
    const result = resultIn(event, name);
    if (!ran(result)) continue;
    if (result.status !== 'reused') return { event, result };
    return { event: checkedSource(result.source, { ...context, before: event.seq }), result };
  }
  return null;
}

/** State belongs to the real runner; no producer ever reconstructs a missing
 * historical file from today's working outputs. */
function reuse(name, branch, root) {
  const { live, baseline, rulebookFingerprint } = current();
  const context = { live, branch, root, baseline, rulebookFingerprint };
  const producer = producerOf(name, context);
  if (!producer) throw new Error(`No producing verification for reused ${name}`);
  const source = producer.result.status === 'reused' ? producer.result.source : originalSource(producer.event, branch, root);
  const { evidence, summary } = structuredClone(producer.result);
  const result = { name, status: 'reused', reason: 'Runs once per approved plan.', source, evidence, summary };
  validateResult(result);
  validateReuse(result, context);
  return result;
}

export function testSummary(run) {
  return { total: run.cases.length, passed: run.cases.filter(test => test.status === 'passed').length,
    failed: run.cases.filter(test => test.status === 'failed').length, skipped: run.cases.filter(test => test.status === 'skipped').length,
    inverted: run.cases.filter(test => test.inverted).length, omittedFiles: run.leftOut.length };
}

/** Mutable only while the runner is executing; each completed step replaces
 * its initial omission. */
export function verificationResults(branch, configured, builtinNames, root = process.cwd()) {
  const problems = new Map();
  // The runner supplies its referee steps in execution order. Even callers
  // collecting only configured checks still owe the three mandatory results.
  const builtins = builtinNames.includes('tests') ? builtinNames : [...builtinNames, 'tests'];
  const names = [...builtins, 'coverage', 'mutation',
    ...configured.map(check => check.name).filter(name => !TEST_QUALITY_RESULTS.includes(name))];
  const results = names.map(name => skipped(name, ['coverage', 'mutation'].includes(name)
    && !configured.some(check => check.name === name) ? 'Disabled in the rulebook.' : 'An earlier step stopped verification.'));
  const put = result => {
    results[results.findIndex(item => item.name === result.name)] = result;
  };
  const failed = (name, error, previous) => {
    problems.set(name, String(error.message ?? error));
    const result = { name, status: 'failed', reason: 'Verification evidence could not be preserved.',
      evidence: previous?.evidence ?? [], summary: { ...previous?.summary, diagnostics: String(error.message ?? error) } };
    // A malformed reference is no artifact; preserve the diagnostic instead.
    try { validateResult(result); }
    catch {
      result.evidence = [];
      result.summary = { diagnostics: String(error.message ?? error) };
    }
    put(result);
    return false;
  };
  return {
    results,
    problem: name => String(problems.get(name) ?? 'Unknown evidence failure'),
    fail: (name, error, run = {}) => failed(name, error,
      name === 'tests' ? { evidence: junitArtifacts(run.junitReports ?? []) } : undefined),
    record(result, run = {}) {
      const { name } = result;
      let entry = { name, status: result.outcome === 'broken' || result.outcome === 'findings' && result.onFailure !== 'report' ? 'failed' : 'ok',
        reason: brief(result.reason || 'Check completed.'), evidence: [], summary: {} };
      try {
        if (result.ranBefore) { put(reuse(name, branch, root)); return true; }
        if (result.outcome === 'skipped' && !(name === 'tests' && run.tests)) {
          put(skipped(name, result.reason)); return true;
        }
        if (name === 'tests') {
          entry.evidence = junitArtifacts(run.junitReports ?? []);
          if (run.tests) {
            if (!entry.evidence.length && typeof run.tests.exit !== 'string') throw new Error('Tests require a test report');
            const analysis = writeTestAnalysis(branch, run.junitReports ?? [], run.tests, root, result);
            entry.evidence.push(artifact('analysis', 'Parsed test run and execution metadata', analysis));
            entry.summary = testSummary(run.tests);
            validateTestRun(run.tests, entry.status !== 'failed');
          }
        } else if (name === 'coverage') {
          if (result.snapshots) {
            entry.evidence = [artifact('raw', 'Raw LCOV coverage', result.snapshots.raw),
              artifact('analysis', 'Coverage thresholds and changed lines', result.snapshots.analysis)];
            const files = readArtifacts(entry, branch, root);
            const analysis = files.find(file => file.role === 'analysis');
            const document = JSON.parse(analysis.bytes);
            const measurement = coverageAnalysis(document, result.baseline, entry.status !== 'failed', `${analysis.snapshot}: coverage analysis`);
            if (document.name !== name || !isDeepStrictEqual(document.result, checkDocument(name, result).result)) {
              throw new Error(`${analysis.snapshot}: Coverage analysis does not match its result`);
            }
            entry.summary = coverageSummary(measurement);
          }
        } else if (name === 'mutation') {
          if (result.snapshots) {
            entry.evidence = [artifact('raw', 'Raw mutation results', result.snapshots.raw),
              artifact('analysis', 'Mutation findings and limitations', result.snapshots.findings)];
            const measurement = readMutationSnapshot(branch, result.snapshots, root);
            entry.summary = mutationSummary(measurement);
            if (entry.status === 'ok' && mutationIncomplete(measurement.outcome, measurement.findings)) {
              entry.status = 'partial';
              entry.reason = brief(`Mutation measurement is incomplete: ${result.reason || 'some mutants were not proved.'}`);
            }
          }
        } else {
          entry.summary = generalSummary(result);
          if (run.limitations?.length) entry.summary.limitations = run.limitations;
          if (result.text) entry.evidence.push(artifact('raw', `${name} output`, publishSnapshot(branch, rawCheck, Buffer.from(result.text), root)));
          const config = configured.find(check => check.name === name);
          if (config?.output) {
            const bytes = readFileSync(checkedOutput(config.output, root));
            const document = JSON.parse(bytes);
            schemaVersion(document?.version, `${config.output}.version`);
            if (!isDeepStrictEqual(document, checkDocument(name, result))) throw new Error('Check output does not match its producing run');
            entry.evidence.push(artifact('analysis', `${name} result`, publishSnapshot(branch, analysedCheck, bytes, root)));
          }
        }
        if (entry.status === 'failed' && !Object.keys(entry.summary).length) entry.summary = { diagnostics: result.text || result.reason };
        validateResult(entry);
        readArtifacts(entry, branch, root);
        if (['ok', 'partial'].includes(entry.status)) validateMeasurement(entry, { branch, root, baseline: result.baseline });
        put(entry);
        return true;
      } catch (error) { return failed(name, error, entry); }
    },
  };
}
