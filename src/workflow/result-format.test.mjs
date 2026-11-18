import { verificationInputs, verified } from '../../tests/fixtures/workflow/events.mjs';
import { beforeEach, expect, it, vi } from 'vitest';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { testCase, testRun } from '../../tests/fixtures/workflow/quality-results.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

let brief, sentence, validateChecksResults, validateResult, validateCoverageMeasurement, validateTestRun, validateEvent;
// Construct the validators during the test as well as exercising them then.
// Their schema factories otherwise run only at module import time.
beforeEach(async () => {
  vi.resetModules();
  ({ brief, sentence, validateChecksResults, validateResult, validateCoverageMeasurement, validateTestRun } = await import('./result-format.mjs'));
  ({ validateEvent } = await import('./event-format.mjs'));
});

const ref = (folder, extension) => `.katatay/local/topic/${folder}/20261104T120000.000Z_${'A'.repeat(43)}.${extension}`;
const item = (role, folder, extension) => ({ role, title: 'Evidence', snapshot: ref(folder, extension) });
const skipped = name => ({ name, status: 'skipped', reason: 'Disabled.', evidence: [], summary: {} });
const generic = () => ({ name: 'audit', status: 'ok', evidence: [], summary: { outcome: 'findings', exitCode: 1 } });
const tests = () => ({ name: 'tests', status: 'ok', evidence: [item('raw', 'junit', 'xml'), item('analysis', 'junit/analysis', 'json')],
  summary: { total: 3, passed: 1, failed: 0, skipped: 2, inverted: 1, omittedFiles: 0 } });
const coverage = () => ({ name: 'coverage', status: 'ok', evidence: [item('raw', 'coverage', 'lcov'), item('analysis', 'coverage', 'json')],
  summary: { folders: [{ folder: 'modules/', lines: { percent: 50, target: 40 }, branches: { percent: 100, target: 90 } }] } });
const mutation = () => ({ name: 'mutation', status: 'ok', evidence: [item('raw', 'mutation/raw', 'json'), item('analysis', 'mutation/findings', 'json')],
  summary: { totalMutants: 1, killed: 0, survived: 1, unproved: 0, ignored: 0, errored: 0 } });
const measuredCoverage = () => ({ folders: [{ folder: 'modules/', files: 1, lines: { covered: 1, total: 2, measured: 500, minimum: 400 },
  branches: { covered: 0, total: 0, measured: 1000, minimum: 900 } }], failures: [],
  touched: { covered: 1, total: 2, uncovered: [{ file: 'a.ts', lines: [2] }] } });
const checks = () => [generic(), tests(), coverage(), mutation()];

it('requires a result list and rejects the retired wrappers', () => {
  const current = checks();
  expect(validateChecksResults(current)).toBe(current);
  for (const invalid of [undefined, null, {}, { results: current }, { results: [], testQualityResults: current }, 'results']) {
    expect(() => validateChecksResults(invalid)).toThrow('results must be a list');
  }
});

it('requires three separate named results even when two names are joined by a comma', () => {
  const data = [generic(), skipped('tests,coverage'), skipped('mutation')];
  expect(() => validateChecksResults(data, 'receipt.results')).toThrow(
    new Error('receipt.results must contain tests, coverage and mutation in that order'));
});

it('accepts measured findings and limitations without a duplicate findings flag', () => {
  expect(() => validateChecksResults(checks())).not.toThrow();
  const data = checks();
  data.find(item => item.name === 'mutation').status = 'partial';
  data.find(item => item.name === 'mutation').reason = 'Run ended early.';
  expect(() => validateChecksResults(data)).not.toThrow();
});

it('accepts an earlier source only on reused results and validates its fingerprint', () => {
  const result = { ...generic(), status: 'reused', reason: 'Runs once per plan.', source: { seq: 2, fingerprint: 'a'.repeat(64) } };
  const data = checks();
  data.splice(0, 1, result);
  expect(() => validateChecksResults(data, 'results', 3)).not.toThrow();
  expect(() => validateChecksResults(data, 'results', 2)).toThrow('must precede');
  result.source.fingerprint = 'tree';
  expect(() => validateChecksResults(data)).toThrow('fingerprint');
});

it.each(['title', 'reason'])('counts Unicode code points in the %s limit and rejects newlines', field => {
  const result = tests();
  const target = field === 'title' ? result.evidence[0] : result;
  target[field] = '🧬'.repeat(256);
  expect(() => validateResult(result)).not.toThrow();
  target[field] += 'x';
  expect(() => validateResult(result)).toThrow('256');
  for (const value of ['', ' ', 'first\nsecond', 'first\rsecond', 'first\u2028second', 'first\u2029second']) {
    target[field] = value;
    expect(() => validateResult(result)).toThrow('single-line');
  }
});

// A reason may already be a sentence; the message ends it with one stop.
it.each([
  ['two findings', 'two findings.'],
  ['Runs once per approved plan.', 'Runs once per approved plan.'],
  ['Two findings!', 'Two findings!'],
  ['Two findings?', 'Two findings?'],
  ['Cut short…', 'Cut short…'],
  ['  padded  ', 'padded.'],
  ['a.b', 'a.b.'],
])('shows %j as the sentence %j', (reason, shown) => {
  expect(sentence(reason)).toBe(shown);
});

it('bounds generated descriptions without imposing that limit on summaries', () => {
  expect(brief('  first\n second\tthird  ')).toBe('first second third');
  expect(brief('🧬'.repeat(256))).toBe('🧬'.repeat(256));
  expect(brief('🧬'.repeat(257))).toBe('🧬'.repeat(255) + '…');
  expect(() => validateResult({ name: 'audit', status: 'failed', reason: 'Could not run.', evidence: [],
    summary: { diagnostics: 'Details\n'.repeat(1000) } })).not.toThrow();
});

it.each([
  ['duplicate name', data => data.push(generic()), 'duplicates audit'],
  ['duplicate mandatory result', data => { data.push(tests()); }, 'tests, coverage and mutation'],
  ['missing quality result', data => data.pop(), 'tests, coverage and mutation'],
  ['wrong order', data => data.reverse(), 'in that order'],
  ['unknown field', data => { data[0].chain = 'referee'; }, 'unknown field'],
  ['unknown status', data => { data[0].status = 'findings'; }, 'must be ok'],
  ['findings boolean', data => { data[0].findings = true; }, 'unknown field'],
  ['source on fresh result', data => { data[0].source = { seq: 1, fingerprint: 'a'.repeat(64) }; }, 'belongs only'],
  ['missing source', data => { data[0].status = 'reused'; }, 'required there'],
  ['missing reason', data => { data[0].status = 'failed'; }, 'reason'],
  ['invalid role', data => { data.find(item => item.name === 'tests').evidence[0].role = 'junit'; }, 'raw or analysis'],
  ['wrong test role', data => { data.find(item => item.name === 'tests').evidence[0].role = 'analysis'; }, 'requires a test report'],
  ['bad path', data => { data.find(item => item.name === 'tests').evidence[0].snapshot = '/tmp/report.xml'; }, 'snapshot reference'],
  ['traversal', data => { data.find(item => item.name === 'tests').evidence[0].snapshot = ref('../junit', 'xml'); }, 'snapshot reference'],
  ['missing report', data => { data.find(item => item.name === 'tests').evidence = []; }, 'requires a test report'],
  ['duplicate role', data => { data.find(item => item.name === 'coverage').evidence.push(data.find(item => item.name === 'coverage').evidence[0]); }, 'one raw artifact'],
  ['missing analysis', data => { data.find(item => item.name === 'mutation').evidence.pop(); }, 'one analysis artifact'],
])('rejects %s', (_, change, message) => {
  const data = checks();
  change(data);
  expect(() => validateChecksResults(data)).toThrow(message);
});

it('allows ordinary checks between the mandatory results, including skipped ones', () => {
  const data = [generic(), skipped('tests'), { ...generic(), name: 'req:trace' },
    skipped('coverage'), { ...generic(), name: 'audit-tests' }, skipped('mutation')];
  expect(validateChecksResults(data)).toBe(data);
});

it.each(['tests', 'coverage', 'mutation'])('rejects a missing %s result even when every other result is skipped', name => {
  const data = ['tests', 'coverage', 'mutation'].filter(item => item !== name).map(skipped);
  expect(() => validateChecksResults(data)).toThrow('must contain tests, coverage and mutation in that order');
});

it('keeps skips empty and distinguishes an absent failed measurement from measured zeros', () => {
  expect(() => validateResult(skipped('coverage'))).not.toThrow();
  expect(() => validateResult({ ...skipped('coverage'), summary: { failures: [] } })).toThrow('empty');
  expect(() => validateResult({ ...skipped('coverage'), evidence: [item('raw', 'coverage', 'lcov')] })).toThrow('empty');
  expect(() => validateResult({ name: 'tests', status: 'failed', reason: 'Runner crashed.', evidence: [], summary: {} })).not.toThrow();
  expect(() => validateResult({ ...tests(), summary: {} })).toThrow('total');
});

it.each([
  ['test total', tests, result => { result.summary.total++; }, 'counts'],
  ['too many inverted tests', tests, result => { result.summary.inverted = 4; }, 'counts'],
  ['omitted files', tests, result => { result.summary.omittedFiles = 1; }, 'omitted tests'],
  ['fractional test count', tests, result => { result.summary.passed = 0.5; }, 'integer'],
  ['coverage precision', coverage, result => { result.summary.folders[0].lines.percent = 50.01; }, 'percentage'],
  ['coverage minimum', coverage, result => { result.summary.folders[0].lines.target = 60; }, 'below'],
  ['mutant total', mutation, result => { result.summary.totalMutants++; }, 'mutation counts'],
  ['mutant killed count', mutation, result => { result.summary.killed++; }, 'mutation counts'],
  ['unproved mutants', mutation, result => { result.summary.unproved++; }, 'mutation counts'],
])('rejects inconsistent %s', (_, make, change, message) => {
  const result = make();
  change(result);
  expect(() => validateResult(result)).toThrow(message);
});

it('accepts failed measurements with real failures and below-minimum coverage', () => {
  const result = coverage();
  result.status = 'failed'; result.reason = 'Coverage below minimum.';
  result.summary.folders[0].lines.target = 60;
  expect(() => validateResult(result)).not.toThrow();
  const run = tests();
  run.status = 'failed'; run.reason = 'A test failed.';
  run.summary.passed = 0; run.summary.failed = 1;
  expect(() => validateResult(run)).not.toThrow();
});

it('permits failure evidence and rejects a passing receipt containing failed results', () => {
  const event = { version: 1, seq: 1, ts: '2026-11-04T12:00:00.000Z', prev: null, branch: 'topic', event: 'verified', payload: verified() };
  expect(() => validateEvent(event, 1)).not.toThrow();
  event.payload.results = checks();
  expect(() => validateEvent(event, 1)).not.toThrow();
  event.payload.results[0] = { name: 'audit', status: 'failed', reason: 'Command broke.', evidence: [], summary: {} };
  expect(() => validateEvent(event, 1)).toThrow('cannot contain a failed result');
  event.event = 'verify_failed';
  event.payload = { treeFingerprint: event.payload.treeFingerprint, results: event.payload.results, baseline: verificationInputs.baseline, rulebookFingerprint: null, tail: 'Command broke.' };
  expect(() => validateEvent(event, 1)).not.toThrow();
});

const set = (value, path, replacement) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((at, key) => at[key], value)[last] = replacement;
};
const invalidFields = [
  [generic, 'name', [null, 1, '', '  ']],
  [generic, 'summary', [null, [], 'text', false]],
  [generic, 'summary.exitCode', [-1, 256, 0.5, '0', false]],
  [generic, 'summary.outcome', ['', 'ok', true]],
  [generic, 'summary.limitations', [null, 7, [7], [' ']]],
  [generic, 'summary.diagnostics', [null, 1, []]],
  [tests, 'evidence', [null, {}, 7]],
  [tests, 'evidence.0', [null, [], 'raw']],
  [tests, 'evidence.0.title', [null, 1, false]],
  [tests, 'evidence.0.snapshot', [null, 1, 'prefix' + ref('junit', 'xml'), ref('junit', 'xml') + '/suffix']],
  [tests, 'summary.total', [-1, Number.MAX_SAFE_INTEGER + 1, '3', null]],
  [tests, 'summary.omittedFiles', [null, 'file', [1], [' ']]],
  [coverage, 'summary.folders', [null, {}, [null]]],
  [coverage, 'summary.folders.0.folder', [null, 1, ' ']],
  [coverage, 'summary.folders.0.lines', [null, [], 7]],
  [coverage, 'summary.folders.0.lines.percent', [-0.1, 100.1, 50.01, null, '50', NaN, Infinity]],
  [coverage, 'summary.folders.0.branches.target', [-1, 101, 0.01, null]],
  [mutation, 'summary.totalMutants', [-1, 0.5, null]],
];
it.each(invalidFields.flatMap(([make, path, values]) => values.map(value => [path, value, make])))('rejects malformed field %s = %j', (path, value, make) => {
  const result = make();
  set(result, path, value);
  const expected = 'result.' + path.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  expect(() => validateResult(result)).toThrow(expected);
});

it.each([null, undefined, 7])('rejects a nonobject result %j before reading fields', value => {
  expect(() => validateResult(value)).toThrow('result must be an object');
});

it.each([
  ['name', generic], ['status', generic], ['summary', generic], ['evidence', generic],
  ['summary.outcome', generic], ['evidence.0.role', tests], ['evidence.0.title', tests], ['evidence.0.snapshot', tests],
  ['summary.total', tests], ['summary.omittedFiles', tests],
  ['summary.folders.0.lines.target', coverage], ['summary.folders.0.branches.percent', coverage],
  ['summary.totalMutants', mutation], ['summary.killed', mutation], ['summary.unproved', mutation],
])('names the missing required field %s exactly', (path, make) => {
  const result = make();
  const keys = path.split('.');
  const last = keys.pop();
  delete keys.reduce((at, key) => at[key], result)[last];
  expect(() => validateResult(result)).toThrow(`result.${path.replace(/\.(\d+)(?=\.|$)/g, '[$1]')} is missing`);
});

it('accepts boundary exits and rejects contradictory successful generic outcomes', () => {
  for (const exitCode of [null, 0, 255]) expect(() => validateResult({ ...generic(), summary: { outcome: 'clean', exitCode } })).not.toThrow();
  for (const outcome of ['broken', 'skipped']) expect(() => validateResult({ ...generic(), summary: { outcome } })).toThrow('does not describe a completed check');
  for (const exit of [null, 0, 255, 'SIGTERM']) {
    expect(() => validateTestRun(testRun({ exit }))).not.toThrow();
  }
});

it('checks source hash boundaries and the exact source error path', () => {
  for (const fingerprint of [1, 'prefix' + 'a'.repeat(64), 'a'.repeat(64) + 'suffix', 'A'.repeat(64)]) {
    expect(() => validateResult({ ...generic(), status: 'reused', reason: 'Once per plan.', source: { seq: 1, fingerprint } }))
      .toThrow('result.source.fingerprint must be a SHA-256 fingerprint');
  }
});

it('allows exact coverage floors and rejects impossible measurements and empty folders', () => {
  for (const target of [50, 100]) {
    const result = coverage(); result.summary.folders[0].lines = { percent: target, target };
    expect(() => validateResult(result)).not.toThrow();
  }
  for (const change of [
    result => { result.summary.folders[0].lines.percent = 150; },
    result => { result.summary.folders[0].lines.target = 101; },
    result => { result.summary.folders = []; },
    result => { result.summary.folders.push(result.summary.folders[0]); },
  ]) {
    const result = coverage(); change(result);
    expect(() => validateResult(result)).toThrow('result.summary');
  }
  const measurement = measuredCoverage(); measurement.folders[0].files = 0;
  expect(() => validateCoverageMeasurement(measurement)).toThrow('without measured folders');
});

it('accounts for all mutant categories and requires partial for unproved or errored work', () => {
  const result = mutation(); result.status = 'partial'; result.reason = 'Some mutants could not be proved.';
  result.summary = { totalMutants: 15, killed: 1, survived: 2, unproved: 3, ignored: 4, errored: 5 };
  expect(() => validateResult(result)).not.toThrow();
  result.summary.totalMutants--;
  expect(() => validateResult(result)).toThrow('inconsistent mutation counts');
  result.summary.totalMutants++; result.status = 'ok';
  expect(() => validateResult(result)).toThrow('incomplete mutation must be partial');
});

it('accepts multiline and zero-width survivor ranges but rejects reversed positive positions', () => {
  for (const [start, end, valid] of [
    [{ line: 1, column: 3 }, { line: 2, column: 1 }, true],
    [{ line: 1, column: 3 }, { line: 1, column: 3 }, true],
    [{ line: 2, column: 1 }, { line: 1, column: 3 }, false],
    [{ line: 1, column: 3 }, { line: 1, column: 2 }, false],
  ]) {
    const report = reportOf([mutant('Survived', { location: { start, end } })]);
    if (valid) expect(() => findingsOf(report)).not.toThrow();
    else expect(() => findingsOf(report)).toThrow('invalid location');
  }
});

it.each(['verified', 'verify_failed'])('validates reuse order against the enclosing %s event sequence', event => {
  const entry = { version: 1, seq: 4, ts: '2026-11-04T12:00:00.000Z', prev: 'a'.repeat(64), event,
    payload: event === 'verified' ? verified({ results: checks() })
      : { treeFingerprint: 'b'.repeat(64), results: checks(), baseline: verificationInputs.baseline, rulebookFingerprint: null, tail: 'Other step failed.' } };
  Object.assign(entry.payload.results[0], { status: 'reused', reason: 'Once per plan.', source: { seq: 3, fingerprint: 'c'.repeat(64) } });
  expect(() => validateEvent(entry, 4)).not.toThrow();
  for (const seq of [4, 5]) {
    entry.payload.results[0].source.seq = seq;
    expect(() => validateEvent(entry, 4)).toThrow('event.payload.results.source must precede this verification');
  }
});

it.each(['treeFingerprint', 'rulebookFingerprint', 'baseline', 'tail'])('still requires %s on a failed verification that carries results', field => {
  const entry = { version: 1, seq: 1, ts: '2026-11-04T12:00:00.000Z', prev: null, branch: 'topic', event: 'verify_failed',
    payload: { treeFingerprint: 'a'.repeat(64), baseline: verificationInputs.baseline, rulebookFingerprint: null, tail: '', results: checks() } };
  expect(() => validateEvent(entry, 1)).not.toThrow();
  delete entry.payload[field];
  expect(() => validateEvent(entry, 1)).toThrow(`event.payload.${field} is missing`);
});

it.each(['skipped', 'failed', 'reused'])('requires a reason for %s even with an otherwise complete result', status => {
  const result = status === 'skipped' ? skipped('audit') : generic();
  result.status = status;
  if (status === 'reused') result.source = { seq: 1, fingerprint: 'a'.repeat(64) };
  delete result.reason;
  expect(() => validateResult(result)).toThrow('result.reason is required for this status');
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects reused source sequence %j', seq => {
  expect(() => validateResult({ ...generic(), status: 'reused', reason: 'Once per plan.', source: { seq, fingerprint: 'a'.repeat(64) } }))
    .toThrow('result.source.seq must be a positive integer');
});

it.each(['coverage', 'mutation'])('allows incomplete failed %s evidence but rejects duplicate roles', name => {
  const result = { name, status: 'failed', reason: 'Publication interrupted.', evidence: [], summary: { diagnostics: 'Only raw output was saved.' } };
  const raw = item('raw', name === 'mutation' ? 'mutation/raw' : 'coverage', name === 'mutation' ? 'json' : 'lcov');
  const analysis = item('analysis', name === 'mutation' ? 'mutation/findings' : 'coverage', 'json');
  for (const artifacts of [[], [raw], [analysis], [raw, analysis]]) {
    result.evidence = artifacts;
    expect(() => validateResult(result)).not.toThrow();
  }
  for (const artifacts of [[raw, raw], [analysis, analysis]]) {
    result.evidence = artifacts;
    expect(() => validateResult(result)).toThrow(`result.evidence requires one ${artifacts[0].role} artifact`);
  }
});

it('validates failed measurements as measurements instead of treating every failure as diagnostics only', () => {
  const result = { ...tests(), status: 'failed', reason: 'Test failed.' };
  result.summary.passed--;
  result.summary.failed++;
  expect(() => validateResult(result)).not.toThrow();
  result.summary.total++;
  expect(() => validateResult(result)).toThrow('result.summary has inconsistent test counts');
  result.summary = { failed: 1, diagnostics: 'Incomplete summary' };
  expect(() => validateResult(result)).toThrow('result.summary.total is missing');
});

it('validates fractional coverage arithmetic in evidence and branch targets in summaries', () => {
  const measurement = measuredCoverage();
  measurement.folders[0].branches = { covered: 2, total: 3, measured: 666, minimum: 666 };
  expect(() => validateCoverageMeasurement(measurement)).not.toThrow();
  measurement.folders[0].branches.measured = 667;
  expect(() => validateCoverageMeasurement(measurement)).toThrow('inconsistent coverage figures');
  const result = coverage(); result.summary.folders[0].branches = { percent: 66.6, target: 66.7 };
  expect(() => validateResult(result)).toThrow('cannot pass below a coverage minimum');
});

it('allows the same mutant id in different files while rejecting duplicate evidence identities', () => {
  const report = reportOf([mutant('Survived', { file: 'a.ts', id: '1' }),
    mutant('Survived', { file: 'b.ts', id: '1' }), mutant('Survived', { file: 'b.ts', id: '2' })]);
  expect(() => findingsOf(report)).not.toThrow();
  report.files['b.ts'].mutants[1].id = '1';
  expect(() => findingsOf(report)).toThrow('invalid or duplicate mutant');
});

it('rejects duplicated touched locations in evidence without confusing different files', () => {
  const measurement = measuredCoverage();
  measurement.touched = { covered: 0, total: 2, uncovered: [{ file: 'a.ts', lines: [3] }, { file: 'b.ts', lines: [3] }] };
  expect(() => validateCoverageMeasurement(measurement)).not.toThrow();
  measurement.touched.uncovered[1].file = 'a.ts';
  expect(() => validateCoverageMeasurement(measurement)).toThrow('inconsistent touched lines');
});

it.each([tests, mutation])('requires a reason and complete artifact references on partial measurements (%#)', make => {
  const result = make(); result.status = 'partial';
  expect(() => validateResult(result)).toThrow('reason is required');
  result.reason = 'The measurement is incomplete.';
  expect(() => validateResult(result)).not.toThrow();
  result.evidence.pop();
  expect(() => validateResult(result)).toThrow('one analysis artifact');
});

it.each([coverage, generic])('does not allow partial on other checks (%#)', make => {
  expect(() => validateResult({ ...make(), status: 'partial', reason: 'Incomplete.' }))
    .toThrow('result.status partial belongs only to tests and mutation');
});

it.each([
  [tests, 'exit', 0], [coverage, 'failures', []], [mutation, 'counts', {}],
])('rejects retired summary field %s.%s', (make, field, value) => {
  const result = make(); result.summary[field] = value;
  expect(() => validateResult(result)).toThrow(`result.summary.${field} is an unknown field`);
});

it.each(['files', 'lines.covered', 'branches.covered'])
  ('rejects retired coverage folder field %s', path => {
    const result = coverage(); set(result, `summary.folders.0.${path}`, 1);
    expect(() => validateResult(result)).toThrow(`result.summary.folders[0].${path} is an unknown field`);
  });

it.each(['killed', 'survived', 'unproved', 'ignored', 'errored'])('reconciles the mutation total when %s changes', category => {
  const result = mutation(); result.summary[category]++;
  expect(() => validateResult(result)).toThrow('inconsistent mutation counts');
});

it.each([
  ['missing file', c => { c.failures = ['A code file is absent from LCOV']; }],
  ['covered count', c => { c.folders[0].lines.covered = 3; }],
  ['total', c => { c.folders[0].lines.total = -1; }],
  ['target', c => { c.folders[0].lines.minimum = 1001; }],
  ['duplicate folder', c => { c.folders.push(c.folders[0]); }],
  ['unsorted touched lines', c => { c.touched = { covered: 0, total: 2, uncovered: [{ file: 'a', lines: [3, 2] }] }; }],
  ['touched total', c => { c.touched.total++; }],
])('retains the detailed coverage guard for %s after removing it from summaries', (_, change) => {
  const measurement = measuredCoverage(); change(measurement);
  expect(() => validateCoverageMeasurement(measurement)).toThrow('coverage evidence');
});

it('rejects unknown fields in detailed coverage before projecting a summary', () => {
  const measurement = measuredCoverage();
  measurement.folders[0].lines.unexplained = 1;
  expect(() => validateCoverageMeasurement(measurement))
    .toThrow('coverage evidence.folders[0].lines.unexplained is an unknown field');
});

it('explains duplicate measured folders', () => {
  const measurement = measuredCoverage();
  measurement.folders.push(structuredClone(measurement.folders[0]));
  expect(() => validateCoverageMeasurement(measurement)).toThrow('coverage evidence has duplicate folders');
});

it.each(['lines', 'branches'])('rejects impossible %s counts even when their percentage agrees and the check failed', metric => {
  const measurement = measuredCoverage();
  measurement.folders[0][metric] = { covered: 3, total: 2, measured: 1500, minimum: 0 };
  expect(() => validateCoverageMeasurement(measurement, false)).toThrow('coverage evidence has inconsistent coverage figures');
});

it.each(['lines', 'branches'])('rejects a %s target above 100 percent even for a failed check', metric => {
  const measurement = measuredCoverage(); measurement.folders[0][metric].minimum = 1001;
  expect(() => validateCoverageMeasurement(measurement, false)).toThrow('coverage evidence has inconsistent coverage figures');
});

it('accepts detailed coverage exactly at a 100 percent line and branch target', () => {
  const measurement = measuredCoverage();
  for (const metric of ['lines', 'branches']) {
    measurement.folders[0][metric] = { covered: 2, total: 2, measured: 1000, minimum: 1000 };
  }
  expect(() => validateCoverageMeasurement(measurement)).not.toThrow();
});

it.each(['lines', 'branches'])('checks the %s threshold independently of recorded failure messages', metric => {
  const measurement = measuredCoverage();
  measurement.folders[0][metric] = { covered: 1, total: 2, measured: 500, minimum: 600 };
  expect(() => validateCoverageMeasurement(measurement)).toThrow('coverage evidence cannot pass below a coverage minimum');
  expect(() => validateCoverageMeasurement(measurement, false)).not.toThrow();
});

it('rejects an empty folder alongside a measured folder', () => {
  const measurement = measuredCoverage();
  measurement.folders.push({ ...structuredClone(measurement.folders[0]), folder: 'empty/', files: 0 });
  expect(() => validateCoverageMeasurement(measurement))
    .toThrow('coverage evidence cannot pass without measured folders or with coverage failures');
});

it.each([false, {}, -1, 0.5, 256, '', ' \t ', NaN, Infinity])('rejects invalid parsed test exit %j with its evidence path', exit => {
  expect(() => validateTestRun(testRun({ exit }))).toThrow('test evidence.exit must be an exit code or signal');
});

it('rejects the retired writer capability in newly written test evidence', () => {
  expect(() => validateTestRun(testRun())).not.toThrow();
  expect(() => validateTestRun(testRun({ reported: false }))).toThrow('test evidence.reported is an unknown field');
});

it.each([{ line: 4 }, { endLine: 4 }, { line: 4, endLine: 3 }])('rejects incomplete or reversed test locations %j', location => {
  expect(() => validateTestRun(testRun({ cases: [testCase(location)] })))
    .toThrow('test evidence has invalid test lines');
});

it.each([{}, { line: 4, endLine: 4 }, { line: 4, endLine: 8 }])('accepts absent, single-line and multiline test locations %j', location => {
  expect(() => validateTestRun(testRun({ cases: [testCase(location)] }))).not.toThrow();
});

it.each([
  ['a failed test', { cases: [testCase({ status: 'failed' })] }],
  ['an omitted file', { leftOut: [{ file: 'missing.test.mjs', ids: [], scenarios: [], bare: [] }] }],
  ['a failed command', { exit: 1 }],
])('refuses successful test evidence with %s, while preserving it as failed evidence', (_, details) => {
  const run = testRun(details);
  expect(() => validateTestRun(run, true))
    .toThrow('test evidence cannot pass with failed or omitted tests or an unsuccessful command');
  expect(() => validateTestRun(run, false)).not.toThrow();
});

it('identifies missing raw JUnit evidence even when test analysis is present', () => {
  const result = tests(); result.evidence = result.evidence.filter(item => item.role === 'analysis');
  expect(() => validateResult(result)).toThrow('result.evidence requires a test report');
});
