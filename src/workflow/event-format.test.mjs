import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { append, EVENTS, fileFor, readChain, sha256 } from './chain.mjs';
import { validateEvent, validateMutationAnalysis } from './event-format.mjs';
import { readBaseline } from './phase.mjs';
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { verificationInputs, skippedChecks, verified, treeFingerprint, approval, triaged, recorded } from '../../tests/fixtures/workflow/events.mjs';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

const branch = 'topic';
const analysisFile = `.katatay/local/topic/checks-analysis/20261105T000000.000Z_${'a'.repeat(43)}.txt`;
let dir, root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'event-format-')); dir = join(root, branch); mkdirSync(dir); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Writes events as an earlier referee stored them, linked as `append` links
 * them, for shapes `append` now refuses. */
function stored(...events) {
  let prev = null;
  return events.map(([event, payload, envelope = {}], i) => {
    const record = { version: 1, seq: i + 1, prev, ts: '2026-01-01T00:00:00.000Z', event, payload, ...(i === 0 ? { branch } : {}), ...envelope };
    const bytes = JSON.stringify(record, null, 2) + '\n';
    writeFileSync(join(dir, fileFor(record)), bytes);
    prev = sha256(bytes);
    return record;
  });
}

const change = { id: 'AC0002', renumberedFrom: 'AC0001', status: 'active', statement: 'A change.', scenarios: ['[AC0002.1] A scenario.'] };
const plan = approval({ requirementChanges: [change] });
const { planSnapshot, ...approvalSummary } = plan;
const predictedFailures = ['AC0002.1'];
const combined = { treeFingerprint, implementationFingerprint: treeFingerprint, implemented: true, level: 'HIGH', reasons: ['Raised to HIGH by failing invariants:'], evidence: triaged().evidence, testCount: 3,
  predicted: { failed: 1, total: 2 }, surprise: { failed: 2, total: 3 }, overPredicted: { count: 1, total: 2 }, notRun: { predicted: 1, unpredicted: 1 } };
const findings = findingsOf(reportOf([mutant('Survived')]));
const raw = { role: 'raw', title: 'JUnit: fast.xml',
  snapshot: `.katatay/local/topic/junit/20261105T000000.000Z_${'a'.repeat(43)}.xml` };
const evidence = [raw, ...combined.evidence];
const changeReportSnapshot = '.katatay/local/topic/change-report/20261107T000000.000Z_x.json';
const payloads = {
  plan_approved: plan,
  replan_requested: { approval: 1 },
  replan_resumed: { request: 2 },
  baseline_moved: { from: readBaseline(plan.baseline), to: 'c'.repeat(40) },
  triaged: triaged({ unchecked: ['no compile step'], evidence }), convergence_requested: { triage: 4, reply: treeFingerprint },
  triage_refused: { reason: 'suite_not_green', failures: ['a test failed'], evidence: [] },
  verified: verified(),
  verify_failed: { treeFingerprint, baseline: verificationInputs.baseline, rulebookFingerprint: null, tail: '', results: skippedChecks() },
  checks_analysis: { verification: 4, summary: 'All reported checks completed without findings.', analysisSnapshot: analysisFile },
  record_held: { treeFingerprint, changeReportSnapshot, note: 'retry', gaps: { uncaughtMutants: 1 } }, declared: { treeFingerprint, changeReportSnapshot, note: null, gaps: { uncaughtMutants: 1 }, summary: ['mutants: 1 survived'] },
  recorded, reset: { note: null },
};
it.each(['record_held', 'declared'])('keeps only measured gap counts on new %s events, including measured zeroes', async event => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const variants = [{}, { uncoveredLines: 0 }, { uncaughtMutants: 0 }, { uncoveredLines: 3, uncaughtMutants: 7 }];
  for (const gaps of variants) fresh.append(dir, event, { ...payloads[event], gaps }, branch);
  expect(fresh.readChain(dir, branch).entries.map(e => e.payload.gaps)).toEqual(variants);
});

it.each([40, 64])('round-trips %s-character baseline commits without rewriting approvals', async length => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const baseline = 'a'.repeat(length);
  const approved = fresh.append(dir, 'plan_approved', { ...plan, baseline }, branch);
  const file = join(dir, fileFor(approved));
  const bytes = readFileSync(file);
  const moved = fresh.append(dir, 'baseline_moved', { from: baseline, to: 'b'.repeat(length) }, branch);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [approved, moved], broken: null });
  expect(readFileSync(file)).toEqual(bytes);
});

it.each(['server', 'fallback', 'kept'])('rejects a retired %s approval baseline without changing historical bytes', async source => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = { ...plan, baseline: { sha: verificationInputs.baseline, source } };
  expect(() => fresh.append(dir, 'plan_approved', payload, branch)).toThrow('baseline must be a Git commit ID');
  expect(readdirSync(dir)).toEqual([]);
  const [old] = stored(['plan_approved', payload]);
  const file = join(dir, fileFor(old));
  const bytes = readFileSync(file);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [],
    broken: '0001__plan_approved.json: event.payload.baseline must be a Git commit ID' });
  expect(readFileSync(file)).toEqual(bytes);
});

it.each(['server', 'fallback', '', null, 7, {}])('refuses move source %j on append and ignores it on replay', async source => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = { from: 'a'.repeat(40), to: 'b'.repeat(40), source };
  expect(() => fresh.append(dir, 'baseline_moved', payload, branch)).toThrow('source is an unknown field');
  expect(readdirSync(dir)).toEqual([]);
  const [old] = stored(['baseline_moved', payload]);
  const file = join(dir, fileFor(old));
  const bytes = readFileSync(file);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old], broken: null });
  expect(readFileSync(file)).toEqual(bytes);
});

it.each(['from', 'to'])('requires baseline_moved.%s on append and replay through a freshly loaded schema', async field => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = { from: 'a'.repeat(40), to: 'b'.repeat(40) };
  delete payload[field];
  expect(() => fresh.append(dir, 'baseline_moved', payload, branch)).toThrow(`${field} is missing`);
  stored(['baseline_moved', payload]);
  expect(fresh.readChain(dir, branch).broken).toContain(`${field} is missing`);
});

it('reads a past declaration without converting its survivor flag or rewriting the event', () => {
  const old = { ...payloads.declared, gaps: { uncovered: null, survived: true } };
  for (const gaps of [{ uncovered: null }, { survived: true }]) {
    expect(() => append(dir, 'declared', { ...old, gaps }, branch)).toThrow('is an unknown field');
  }
  const [entry] = stored(['declared', old]);
  const file = join(dir, fileFor(entry));
  const original = readFileSync(file);
  expect(readChain(dir, branch)).toEqual({ broken: null, entries: [entry] });
  expect(readFileSync(file)).toEqual(original);
});

it('round-trips every current event', () => {
  expect(Object.keys(payloads).sort()).toEqual([...EVENTS].sort());
  const written = Object.entries(payloads).map(([event, payload]) => append(dir, event, payload, branch));
  written.push(append(dir, 'triaged', combined, branch));
  // A reset names the change files it abandoned. Older ones, above, name none.
  written.push(append(dir, 'reset', { note: null, changeFiles: ['requirements/changes/abandoned.md'] }, branch));
  for (const entry of written) expect(JSON.parse(readFileSync(join(dir, fileFor(entry)))).version, entry.event).toBe(HARNESS_SCHEMA_VERSION);
  expect(readChain(dir, branch)).toEqual({ entries: written, broken: null });
});

it('refuses to extend an unversioned approval and preserves its original bytes', () => {
  const [old] = stored(['plan_approved', plan, { version: undefined }]);
  const path = join(dir, fileFor(old));
  const bytes = readFileSync(path);
  expect(() => validateEvent(JSON.parse(bytes), 1)).toThrow('event.version is missing');
  expect(() => append(dir, 'triaged', combined, branch)).toThrow('0001__plan_approved.json: event.version is missing');
  expect(readChain(dir, branch)).toEqual({ entries: [], broken: '0001__plan_approved.json: event.version is missing' });
  expect(readdirSync(dir)).toEqual([fileFor(old)]);
  expect(readFileSync(path)).toEqual(bytes);
});

it.each([null, '1', 2])('refuses an explicit invalid event version %j before appending', version => {
  const [entry] = stored(['plan_approved', plan, { version }]);
  const { broken } = readChain(dir, branch);
  expect(broken).toContain(fileFor(entry));
  expect(broken).toContain(`event.version has unsupported schema version ${JSON.stringify(version)}`);
  expect(() => append(dir, 'triaged', combined, branch)).toThrow('broken chain');
  expect(readdirSync(dir)).toEqual([fileFor(entry)]);
});

it('keeps a checks analysis summary of exactly the limit, counting each astral character once', () => {
  const summary = '𝄞'.repeat(2000);
  const written = append(dir, 'checks_analysis', { ...payloads.checks_analysis, summary }, branch);
  expect(readChain(dir, branch).entries.at(-1).payload.summary).toBe(summary);
  expect(written.payload.summary).toBe(summary);
});

it('writes approvals without excerpts and reads historical excerpts without changing their bytes', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const historical = { ...plan, excerpt: '# Approved plan' };
  expect(() => fresh.append(dir, 'plan_approved', historical, branch)).toThrow('excerpt is an unknown field');
  expect(readdirSync(dir)).toEqual([]);
  const [old] = stored(['plan_approved', historical]);
  const file = join(dir, fileFor(old));
  const bytes = readFileSync(file);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old], broken: null });
  const current = fresh.append(dir, 'plan_approved', plan, branch);
  expect(current.payload).not.toHaveProperty('excerpt');
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old, current], broken: null });
  expect(readFileSync(file)).toEqual(bytes);
});

it('reads a dual-field approval and appends a canonical commit approval', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const [old] = stored(['plan_approved', { ...plan, planSnapshotFile: planSnapshot }]);
  const payload = { ...plan, baseline: verificationInputs.baseline };
  const current = fresh.append(dir, 'plan_approved', payload, branch);
  expect(current.payload).toEqual(payload);
  const invalid = { ...payload, baseline: 'not-a-commit' };
  expect(() => fresh.append(dir, 'plan_approved', invalid, branch)).toThrow('baseline must be a Git commit ID');
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old, current], broken: null });
});

it('writes approvals without working paths and reads historical paths without changing their bytes', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const historical = { ...plan, planFile: '/plans/old-input.md' };
  expect(() => fresh.append(dir, 'plan_approved', historical, branch)).toThrow('planFile is an unknown field');
  expect(readdirSync(dir)).toEqual([]);
  const [old] = stored(['plan_approved', historical]);
  const file = join(dir, fileFor(old));
  const bytes = readFileSync(file);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old], broken: null });
  const current = fresh.append(dir, 'plan_approved', plan, branch);
  expect(current.payload).not.toHaveProperty('planFile');
  expect(current.payload.planSnapshot).toBe(plan.planSnapshot);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [old, current], broken: null });
  expect(readFileSync(file)).toEqual(bytes);
});

it('requires results even when a failed verification could not start', () => {
  expect(() => append(dir, 'verify_failed', { treeFingerprint, baseline: verificationInputs.baseline, rulebookFingerprint: null, tail: 'Could not start.' }, branch))
    .toThrow('event.payload.results is missing');
  expect(() => append(dir, 'verified', verified({ results: [] }), branch))
    .toThrow('must contain tests, coverage and mutation in that order');
});

it.each(['verified', 'verify_failed'])('requires a flat ordered result list on a new %s receipt', event => {
  const results = skippedChecks();
  const write = value => append(dir, event, { ...payloads[event], results: value }, branch);
  for (const invalid of [{ results, testQualityResults: [] }, { results, qualityResults: [] }, null, {}]) {
    expect(() => write(invalid)).toThrow('event.payload.results must be a list');
  }
  const { results: omitted, ...missing } = payloads[event];
  expect(() => append(dir, event, missing, branch)).toThrow('event.payload.results is missing');
  expect(() => append(dir, event, { ...missing, checks: { results: [], testQualityResults: results } }, branch))
    .toThrow('event.payload.checks is an unknown field');
  stored([event, { ...missing, checks: { results: [], testQualityResults: results } }]);
  expect(readChain(dir, branch).broken).toContain('event.payload.results is missing');
  rmSync(join(dir, '0001__' + event + '.json'));
  for (const invalid of [results.slice(0, 2), [...results].reverse()]) {
    expect(() => write(invalid)).toThrow('event.payload.results must contain tests, coverage and mutation in that order');
  }
  const entry = write(results);
  expect(entry.payload.results.map(result => result.name)).toEqual(['tests', 'coverage', 'mutation']);
  expect(readChain(dir, branch)).toEqual({ entries: [entry], broken: null });
});

it.each(['triaged', 'verified', 'verify_failed', 'record_held', 'declared', 'recorded'])(
  'requires treeFingerprint when appending or reading %s', async event => {
    vi.resetModules();
    const fresh = await import('./chain.mjs');
    const { treeFingerprint, ...rest } = payloads[event];
    const old = { tree: treeFingerprint, ...rest };
    expect(() => fresh.append(dir, event, old, branch)).toThrow('tree is an unknown field');
    expect(readdirSync(dir)).toEqual([]);
    stored([event, old]);
    expect(fresh.readChain(dir, branch).broken).toContain('treeFingerprint is missing');
  });

// `workflow verify --rerun` marks its events; the hook's leave the field out.
it('reads a verification marked as a rerun', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const written = [
    fresh.append(dir, 'verified', verified({ trigger: 'rerun' }), branch),
    fresh.append(dir, 'verify_failed', { treeFingerprint, baseline: verificationInputs.baseline, rulebookFingerprint: verificationInputs.rulebookFingerprint, tail: '', results: skippedChecks(), trigger: 'rerun' }, branch),
  ];
  expect(fresh.readChain(dir, branch)).toEqual({ entries: written, broken: null });
});

it('reads an event whose envelope holds a field no format lists', () => {
  const written = stored(['reset', { note: null }, { surprise: 1 }]);
  expect(readChain(dir, branch)).toEqual({ entries: written, broken: null });
});

it('reads verification results that hold fields no format lists, at any depth', () => {
  const checks = skippedChecks();
  checks.find(item => item.name === 'tests').producer = 'vitest';
  const written = stored(['verified', verified({ results: checks, origin: 'an older referee', checks: { results: 'retired wrapper' } })]);
  expect(readChain(dir, branch)).toEqual({ entries: written, broken: null });
});

it('still refuses an unknown field when appending after reading one', () => {
  const [old] = stored(['reset', { note: null, reason: 'an older field' }]);
  expect(() => append(dir, 'reset', { note: null, reason: 'a typo' }, branch)).toThrow('event.payload.reason is an unknown field');
  const next = append(dir, 'reset', { note: null }, branch);
  expect(readChain(dir, branch)).toEqual({ entries: [old, next], broken: null });
});

it.each(['invalid_test_run', 'snapshot_failed'])('requires a diagnostic for a %s refusal', reason => {
  const payload = { reason, evidence: [raw] };
  expect(() => append(dir, 'triage_refused', payload, branch)).toThrow('message is missing');
  append(dir, 'triage_refused', { ...payload, message: 'could not read report' }, branch);
  expect(readChain(dir, branch).entries[0].payload).toEqual({ ...payload, message: 'could not read report' });
});

it.each(['LOW', 'MEDIUM', 'HIGH'])('preserves the %s triage level and the checks the adapter could not run', level => {
  const payload = { ...combined, level, reasons: level === 'LOW' ? [] : ['A regression raised the risk.'], unchecked: ['compile unavailable', 'coverage unavailable'] };
  append(dir, 'triaged', payload, branch);
  expect(readChain(dir, branch)).toMatchObject({ broken: null, entries: [{ payload }] });
});

it.each([
  ['LOW', ['Raised.'], 'reasons must be empty for LOW risk'],
  ['MEDIUM', [], 'reasons must contain one to four reasons for raised risk'],
  ['HIGH', [], 'reasons must contain one to four reasons for raised risk'],
  ['MEDIUM', Array(5).fill('Raised.'), 'reasons must contain one to four reasons for raised risk'],
  ['HIGH', Array(5).fill('Raised.'), 'reasons must contain one to four reasons for raised risk'],
  ['MEDIUM', 'Raised.', 'reasons must be a list'],
  ['HIGH', ['  '], 'reasons[0] must be nonempty text'],
  ['HIGH', [{ text: 'Raised.', items: ['test name'] }], 'reasons[0] must be nonempty text'],
])('refuses invalid reasons for %s risk: %j', (level, reasons, diagnostic) => {
  const payload = triaged({ level, reasons });
  expect(() => append(dir, 'triaged', payload, branch)).toThrow('event.payload.' + diagnostic);
  stored(['triaged', payload]);
  expect(readChain(dir, branch).broken).toContain('event.payload.' + diagnostic);
});

it.each(['LOW', 'MEDIUM', 'HIGH'])('requires reasons when appending or reading %s risk', level => {
  const payload = triaged({ level });
  delete payload.reasons;
  expect(() => append(dir, 'triaged', payload, branch)).toThrow('event.payload.reasons is missing');
  stored(['triaged', payload]);
  expect(readChain(dir, branch).broken).toContain('event.payload.reasons is missing');
});

it.each(['MEDIUM', 'HIGH'])('preserves four reasons in order on a %s triage', level => {
  const four = ['Failing invariants.', 'Test files never ran.', 'Surprise failures.', 'Over-predictions.'];
  const entry = append(dir, 'triaged', { ...combined, level, reasons: four }, branch);
  expect(entry.payload.reasons).toEqual(four);
  expect(readChain(dir, branch)).toEqual({ entries: [entry], broken: null });
});

it('accepts a triage whose only surprises are files that never ran', () => {
  const payload = { ...combined, surprise: { failed: 1, total: 2 } };
  append(dir, 'triaged', payload, branch);
  expect(readChain(dir, branch).entries[0].payload).toEqual(payload);
});

function mutationDocument(exitCode = 1, toolOutcome = 'survived', measured = findings) {
  return { version: 1, name: 'mutation', result: { exitCode, outcome: exitCode === 0 ? 'clean' : 'findings', text: 'Measured result', reason: 'Completed.' },
    measurement: { toolOutcome, findings: measured } };
}

it('accepts saved mutation findings without optional source lines', () => {
  const { sourceLine, ...survivor } = findings.survivors[0];
  expect(() => validateMutationAnalysis(mutationDocument(1, 'survived', { ...findings, survivors: [survivor] }))).not.toThrow();
});

it.each([
  ['missing counts', d => { d.measurement.findings = {}; }, 'findings.counts'],
  ['exit', d => { d.result.exitCode = 0; }, 'result.exitCode'],
  ['check outcome', d => { d.result.outcome = 'clean'; }, 'result.outcome'],
  ['survivor count', d => { d.measurement.findings.survivors = []; }, 'counts'],
  ['multiline source', d => { d.measurement.findings.survivors[0].sourceLine = 'a\nb'; }, 'sourceLine'],
])('rejects inconsistent mutation analysis: %s', (_, change, problem) => {
  const document = structuredClone(mutationDocument());
  change(document);
  expect(() => validateMutationAnalysis(document)).toThrow(problem);
});

describe('mutation schemas loaded during a test', () => {
  it.each([
    [0, 'clean', findingsOf(reportOf([mutant('Killed')]))],
    [1, 'survived', findingsOf(reportOf([mutant('Survived')]))],
    [2, 'nothing', findingsOf({ ...reportOf([mutant('Pending')]), partial: true })],
  ])('checks both outcomes for tool exit %i', async (exit, tool, measured) => {
    vi.resetModules();
    const { validateMutationAnalysis } = await import('./event-format.mjs');
    const document = mutationDocument(exit, tool, measured);
    expect(() => validateMutationAnalysis(document)).not.toThrow();
    document.measurement.toolOutcome = '';
    expect(() => validateMutationAnalysis(document)).toThrow('measurement.toolOutcome');
  });

  it.each(['name', 'result', 'measurement', 'result.exitCode', 'result.text', 'result.reason', 'result.outcome',
    'measurement.toolOutcome', 'measurement.findings'])('requires %s', async path => {
    vi.resetModules();
    const { validateMutationAnalysis } = await import('./event-format.mjs');
    const document = mutationDocument();
    const [first, second] = path.split('.');
    if (second) delete document[first][second];
    else delete document[first];
    expect(() => validateMutationAnalysis(document)).toThrow(`mutation analysis.${path} is missing`);
  });
});

it('appends and reads a triage with its optional fields through a newly loaded event format', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = triaged({ unchecked: ['no compile step'], evidence });
  const written = fresh.append(dir, 'triaged', payload, branch);
  expect(fresh.readChain(dir, branch)).toEqual({ entries: [written], broken: null });
  expect(() => fresh.append(dir, 'triaged', { ...payload, junitFile: 'manifest' }, branch)).toThrow('junitFile is an unknown field');
});

it('requires the changed files on a frozen-test refusal through a newly loaded event format', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = { reason: 'tests_modified', files: ['proposal.test.ts'] };
  fresh.append(dir, 'triage_refused', payload, branch);
  expect(fresh.readChain(dir, branch).entries[0].payload).toEqual(payload);
  expect(() => fresh.append(dir, 'triage_refused', { reason: 'tests_modified' }, branch)).toThrow('event.payload.files is missing');
});

it.each([
  ['measurement_changed', {}, []],
  ['invalid_test_run', { message: 'invalid XML' }, [raw]],
  ['snapshot_failed', { message: 'disk full' }, [raw]],
  ['suite_not_green', { failures: ['failed test'] }, [raw]],
])('requires captured evidence for a %s refusal on append and replay', async (reason, detail, evidence) => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = { reason, ...detail, evidence };
  fresh.append(dir, 'triage_refused', payload, branch);
  expect(fresh.readChain(dir, branch).entries[0].payload).toEqual(payload);
  expect(() => fresh.append(dir, 'triage_refused', { reason, ...detail }, branch)).toThrow('event.payload.evidence is missing');
  const junitReports = evidence.map(({ snapshot }) => ({ name: 'fast.xml', snapshot }));
  stored(['triage_refused', { reason, ...detail, junitReports }]);
  expect(fresh.readChain(dir, branch).broken).toContain('event.payload.evidence is missing');
});

it('round-trips the checks assessment and requires its snapshot through a newly loaded event format', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = payloads.checks_analysis;
  fresh.append(dir, 'checks_analysis', payload, branch);
  expect(fresh.readChain(dir, branch).entries[0].payload).toEqual(payload);
  const { verification, summary } = payload;
  expect(() => fresh.append(dir, 'checks_analysis', { verification, summary }, branch)).toThrow('event.payload.analysisSnapshot is missing');
  stored(['checks_analysis', { verification, summary, evidence: payload.analysisSnapshot }]);
  expect(fresh.readChain(dir, branch).broken).toContain('event.payload.analysisSnapshot is missing');
});

it('accepts MEDIUM and rejects an empty triage level through a newly loaded event format', async () => {
  vi.resetModules();
  const fresh = await import('./chain.mjs');
  const payload = triaged({ level: 'MEDIUM', reasons: ['Raised to MEDIUM by a surprise failure.'] });
  fresh.append(dir, 'triaged', payload, branch);
  expect(fresh.readChain(dir, branch).entries[0].payload.level).toBe('MEDIUM');
  expect(() => fresh.append(dir, 'triaged', { ...payload, level: '' }, branch)).toThrow('event.payload.level');
});

it.each([
  ['waiver_granted', {}, 'unknown event type'],
  ['plan_approved', {}, 'proposal'],
  ...['main', 'a'.repeat(39), 'g'.repeat(40), '', null, [], 7, { sha: 'b'.repeat(40) }].map(baseline =>
    ['plan_approved', { ...plan, baseline }, 'baseline']),
  ['baseline_moved', { ...payloads.baseline_moved, from: null }, 'from'],
  ['baseline_moved', { ...payloads.baseline_moved, to: 'main' }, 'to'],
  ['plan_approved', { ...plan, requirementChanges: [{ ...change, scenarios: undefined }] }, 'scenarios'],
  ['plan_approved', { ...plan, requirementChanges: [{ ...change, renumberedFrom: change.id }] }, 'renumberedFrom'],
  ['plan_approved', approvalSummary, 'planSnapshot is missing'],
  ['plan_approved', { ...plan, planSnapshot: ' ' }, 'planSnapshot must be nonempty text'],
  ...['evidence', 'implementationFingerprint'].map(key => {
    const payload = { ...combined }; delete payload[key];
    return ['triaged', payload, key + ' is missing'];
  }),
  ['triaged', { ...combined, level: '' }, 'level'],
  ['triaged', { ...combined, unchecked: [''] }, 'unchecked[0]'],
  ['triaged', { ...combined, predicted: { failed: 1, total: 0 } }, 'predicted.failed disagrees with the bucket'],
  ['triaged', { ...combined, predicted: { failed: 0, total: 2 } }, 'predicted.failed disagrees with the bucket'],
  ['triaged', { ...combined, surprise: { failed: 2, total: 1 } }, 'surprise.failed disagrees with the bucket'],
  ['triaged', { ...combined, surprise: { failed: 0, total: 2 } }, 'surprise.failed disagrees with the bucket'],
  ['triaged', { ...combined, overPredicted: { count: 0, total: 2 } }, 'overPredicted.count disagrees with the prediction total'],
  ['triaged', triaged({ predicted: { failed: 0 } }), 'predicted.total'],
  ['triaged', triaged({ surprise: { failed: 2, total: 1 } }), 'surprise.failed'],
  ['triaged', triaged({ predicted: { failed: 3, total: 2 } }), 'predicted.failed'],
  ['triaged', triaged({ overPredicted: { count: 1, total: 2 } }), 'overPredicted.count'],
  ['triaged', triaged({ testCount: -1 }), 'testCount'],
  ['triage_refused', { reason: 'tests_modified', files: [] }, 'files'],
  ['triage_refused', { reason: 'invalid' }, 'reason'],
  ['triaged', triaged({ evidence: 'triage.json' }), 'evidence must be a list'],
  ['triaged', triaged({ evidence: [raw] }), 'evidence requires one triage analysis'],
  ['triaged', triaged({ evidence: [...evidence, ...combined.evidence] }), 'evidence requires one triage analysis'],
  ['triaged', triaged({ evidence: [{ ...raw, snapshot: '' }] }), 'evidence[0].snapshot must be a snapshot reference'],
  ['triaged', triaged({ evidence: [{ ...raw, role: 'report' }] }), 'evidence[0].role'],
  ['triaged', triaged({ evidence: [{ ...raw, title: '' }] }), 'evidence[0].title'],
  ['triage_refused', { reason: 'measurement_changed', evidence }, 'evidence must contain only raw reports'],
  ['triage_refused', { reason: 'measurement_changed' }, 'evidence is missing'],
  ['triage_refused', { reason: 'implementation_changed', evidence: [] }, 'evidence belongs only to a refusal after the suite ran'],
  ['verify_failed', { treeFingerprint, baseline: verificationInputs.baseline, rulebookFingerprint: null }, 'tail is missing'],
  ['triaged', triaged({ implementationFingerprint: 'bad' }), 'implementationFingerprint'],
  ['verified', { treeFingerprint, testFingerprint: treeFingerprint }, 'implementationFingerprint'],
  ['verified', { treeFingerprint, implementationFingerprint: treeFingerprint }, 'testFingerprint'],
  ['verified', { treeFingerprint, implementationFingerprint: treeFingerprint, testFingerprint: 'bad' }, 'testFingerprint'],
  ...['verified', 'verify_failed'].flatMap(event => [
    [event, { ...payloads[event], rulebookFingerprint: 'g'.repeat(64) }, 'rulebookFingerprint'],
    [event, { ...payloads[event], baseline: 'a'.repeat(39) }, 'baseline'],
    [event, { ...payloads[event], baseline: null }, 'baseline'],
  ]),
  ['verified', verified({ rulebookFingerprint: null }), 'rulebookFingerprint'],
  ['verified', verified({ trigger: 'hook' }), 'trigger'],
  ['verify_failed', { ...payloads.verify_failed, trigger: 'hook' }, 'trigger'],
  ['checks_analysis', { ...payloads.checks_analysis, verification: 0 }, 'verification'],
  ['checks_analysis', { ...payloads.checks_analysis, summary: ' ' }, 'summary must be nonempty text of at most 2000 characters'],
  ['checks_analysis', { ...payloads.checks_analysis, summary: '𝄞'.repeat(2001) }, 'summary must be nonempty text of at most 2000 characters'],
  ['checks_analysis', { ...payloads.checks_analysis, analysisSnapshot: analysisFile.replace('checks-analysis', 'checks/raw') }, 'analysisSnapshot must be a checks analysis snapshot reference'],
  ['checks_analysis', { ...payloads.checks_analysis, analysisSnapshot: analysisFile.replace('.txt', '.md') }, 'analysisSnapshot must be a checks analysis snapshot reference'],
  ['checks_analysis', { ...payloads.checks_analysis, summary: 5 }, 'summary must be nonempty text of at most 2000 characters'],
  ['checks_analysis', { ...payloads.checks_analysis, analysisSnapshot: 'x/' + analysisFile }, 'analysisSnapshot must be a checks analysis snapshot reference'],
  ['checks_analysis', { ...payloads.checks_analysis, analysisSnapshot: analysisFile + '.bak' }, 'analysisSnapshot must be a checks analysis snapshot reference'],
  ['declared', { ...payloads.declared, gaps: null }, 'gaps'],
  ...['record_held', 'declared'].flatMap(event => [null, [], { uncoveredLines: -1 }, { uncoveredLines: 1.5 },
    { uncaughtMutants: '1' }, { uncaughtMutants: Number.MAX_SAFE_INTEGER + 1 }]
    .map(gaps => [event, { ...payloads[event], gaps }, 'gaps'])),
  ...[['verified', 'results'], ['verified', 'testFingerprint'], ['verified', 'implementationFingerprint'],
    ['verified', 'baseline'], ['verified', 'rulebookFingerprint'], ['verify_failed', 'baseline'], ['verify_failed', 'rulebookFingerprint'],
    ['declared', 'changeReportSnapshot'], ['declared', 'gaps'], ['record_held', 'changeReportSnapshot'], ['record_held', 'gaps'],
    ['plan_approved', 'baseline']].map(([event, key]) => {
    const payload = { ...payloads[event] }; delete payload[key];
    return [event, payload, key + ' is missing'];
  }),
  ['declared', { ...payloads.declared, summary: [' ', '\t'] }, 'summary'],
  ['declared', { ...payloads.declared, summary: ['first\nsecond'] }, 'summary'],
  ['declared', { ...payloads.declared, summary: null }, 'summary'],
  ['declared', { ...payloads.declared, changeReportSnapshot: ' ' }, 'changeReportSnapshot'],
  ['record_held', { ...payloads.record_held, changeReportSnapshot: 7 }, 'changeReportSnapshot'],
  ['recorded', { ...recorded, files: [] }, 'files'],
].map(([event, payload, problem]) => ({ event, payload, problem })))('rejects invalid $event evidence on append and on disk: $problem', ({ event, payload, problem }) => {
  const first = append(dir, 'reset', { note: null }, branch);
  const bytes = readFileSync(join(dir, fileFor(first)));
  expect(() => append(dir, event, payload, branch)).toThrow(problem);
  expect(readdirSync(dir)).toEqual([fileFor(first)]);
  expect(readFileSync(join(dir, fileFor(first)))).toEqual(bytes);
  const record = { ...first, event, payload };
  rmSync(join(dir, fileFor(first)));
  writeFileSync(join(dir, fileFor(record)), JSON.stringify(record));
  expect(readChain(dir, branch).broken).toContain(problem);
});
// Writing refuses a field no format lists, because it is a writer's typo.
// Reading ignores it: committed events never change, and no code reads it.
it.each([
  ['plan_approved', { ...plan, predictedFailures }, 'predictedFailures is an unknown field'],
  ['triage_refused', { ...payloads.triage_refused, evidence: [{ ...raw, branch }] }, 'evidence[0].branch is an unknown field'],
  ['verified', verified({ extra: true }), 'extra is an unknown field'],
].map(([event, payload, problem]) => ({ event, payload, problem })))('refuses $event evidence on append and reads it from disk: $problem', ({ event, payload, problem }) => {
  const first = append(dir, 'reset', { note: null }, branch);
  expect(() => append(dir, event, payload, branch)).toThrow(problem);
  expect(readdirSync(dir)).toEqual([fileFor(first)]);
  rmSync(join(dir, fileFor(first)));
  const written = stored([event, payload]);
  expect(readChain(dir, branch)).toEqual({ entries: written, broken: null });
});

it('refuses a stored checks analysis that lacks its summary', () => {
  stored(['checks_analysis', { verification: 3, text: 'The full analysis.' }]);
  expect(readChain(dir, branch).broken).toContain('summary is missing');
});

it.each([
  ['0002__reset.json', {}, 'expected 0001__reset.json'],
  ['0001__plan_approved.json', {}, 'expected 0001__reset.json'],
  ['0001__reset.json.bak', {}, 'numbered event file'],
  ['0001__reset.json', { prev: undefined }, 'prev'],
  ['0001__reset.json', { branch: undefined }, 'branch'],
  ['0001__reset.json', { branch: 'another' }, 'belongs'],
  ['0001__reset.json', { ts: '2026-02-31T00:00:00.000Z' }, 'timestamp'],
])('diagnoses an invalid envelope or filename: %s, %s', (file, overrides, problem) => {
  writeFileSync(join(dir, file), JSON.stringify({ version: 1, seq: 1, event: 'reset', prev: null, branch, payload: { note: '' },
    ts: '2026-01-01T00:00:00.000Z', ...overrides }));
  const { broken } = readChain(dir);
  expect(broken).toContain(file);
  expect(broken).toContain(problem);
});

it.each([
  ['truncated JSON', Buffer.from('{"event":"reset"')],
  ['invalid UTF-8 inside a JSON string', Buffer.concat([
    Buffer.from('{"seq":1,"prev":null,"ts":"2026-01-01T00:00:00.000Z","branch":"topic","event":"reset","payload":{"note":"'),
    Buffer.from([0xff]), Buffer.from('"}}'),
  ])],
])('rejects %s without trusting any evidence from the file', (_, bytes) => {
  writeFileSync(join(dir, '0001__reset.json'), bytes);
  expect(readChain(dir, branch)).toEqual({ entries: [], broken: '0001__reset.json: is not readable as JSON' });
});
