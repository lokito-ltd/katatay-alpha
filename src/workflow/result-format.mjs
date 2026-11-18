/** The unified verification format. This module validates data only: it
 * never opens snapshots or consults the current tree while reading history.
 * Unknown fields are refused unless the caller reads stored data inside
 * `leniently` (see `json-fields.mjs`). */
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { fields, schemaVersion } from './json-fields.mjs';
import { STATE_FOLDER_PATTERN } from './folder.mjs';

const SNAPSHOT_REFERENCE = new RegExp(`^${STATE_FOLDER_PATTERN}/local/[^/]+/(?:[^/]+/)+\\d{8}T\\d{6}\\.\\d{3}Z_[\\w-]{43}\\.\\w+$`);

export const TEST_QUALITY_RESULTS = ['tests', 'coverage', 'mutation'];
const fail = (at, why) => { throw new Error(`${at} ${why}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (predicate, why) => (v, at) => { if (!predicate(v)) fail(at, why); };
const text = check(v => typeof v === 'string' && v.trim() !== '', 'must be nonempty text');
const string = check(v => typeof v === 'string', 'must be a string');
const count = check(v => Number.isSafeInteger(v) && v >= 0, 'must be a nonnegative integer');
const positive = check(v => Number.isSafeInteger(v) && v > 0, 'must be a positive integer');
const bool = check(v => typeof v === 'boolean', 'must be a boolean');
const choice = (...values) => check(v => values.includes(v), `must be ${values.join(' or ')}`);
const nullable = validate => (v, at) => { if (v !== null) validate(v, at); };
const list = validate => (v, at) => {
  if (!Array.isArray(v)) fail(at, 'must be a list');
  v.forEach((item, i) => validate(item, `${at}[${i}]`));
};
const description = check(v => typeof v === 'string' && v.trim() !== '' && !/[\r\n\u2028\u2029]/u.test(v)
  && [...v].length <= 256, 'must be nonempty, single-line text of at most 256 characters');
const hash = check(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), 'must be a SHA-256 fingerprint');
const snapshot = check(v => typeof v === 'string'
  && SNAPSHOT_REFERENCE.test(v)
  && !v.split('/').some(part => part === '..'), 'must be a snapshot reference');
export const validateEvidence = list(fields({ role: choice('raw', 'analysis'), title: description, snapshot }));
const outcome = choice('clean', 'findings', 'broken', 'skipped');
const exitCode = nullable(check(v => Number.isInteger(v) && v >= 0 && v <= 255, 'must be an exit code'));
const commandResult = fields({ outcome, exitCode, text: string, reason: string });

/** The command's internal code becomes exitCode only at the storage boundary. */
export function checkDocument(name, { outcome, code, text, reason }, measurement = undefined) {
  const result = { outcome, exitCode: code, text, reason };
  commandResult(result, 'check document.result');
  return { version: HARNESS_SCHEMA_VERSION, name, result, ...(measurement === undefined ? {} : { measurement }) };
}

/** Specialised analyses add their own required measurement to this envelope. */
export const checkDocumentFields = (name, measurement) => fields({
  version: schemaVersion, name: choice(name), result: commandResult, ...(measurement ? { measurement } : {}),
});

const diagnostics = { diagnostics: string };
const generic = fields({ outcome }, { exitCode, limitations: list(text), ...diagnostics });
const tests = fields({ total: count, passed: count, failed: count, skipped: count, inverted: count,
  omittedFiles: count }, diagnostics);
const percent = check(v => typeof v === 'number' && v >= 0 && v <= 100 && v === Math.round(v * 10) / 10,
  'must be a percentage from 0 to 100 with at most one decimal');
const metric = fields({ percent, target: percent });
const coverage = fields({ folders: list(fields({ folder: text, lines: metric, branches: metric })) }, diagnostics);
const mutation = fields({ totalMutants: count, killed: count, survived: count, unproved: count, ignored: count, errored: count }, diagnostics);

// Detailed measurements are validated in their evidence, before projecting a
// summary. Removing details from the event must not remove their checks.
const figures = fields({ covered: count, total: count, measured: count, minimum: count });
const uncovered = fields({ file: text, lines: list(positive) });
const coverageMeasurement = fields({ folders: list(fields({ folder: text, files: count, lines: figures, branches: figures })),
  failures: list(text), touched: nullable(fields({ covered: count, total: count, uncovered: list(uncovered) })) });

export const coverageDocumentFields = checkDocumentFields('coverage', check(object, 'must be a measurement'));

export function validateCoverageMeasurement(value, successful = true) {
  const at = 'coverage evidence';
  coverageMeasurement(value, at);
  const names = value.folders.map(folder => folder.folder);
  if (new Set(names).size !== names.length) fail(at, 'has duplicate folders');
  for (const folder of value.folders) for (const figure of [folder.lines, folder.branches]) {
    const measured = figure.total === 0 ? 1000 : Math.floor(figure.covered * 1000 / figure.total);
    if (figure.covered > figure.total || figure.measured !== measured || figure.minimum > 1000) fail(at, 'has inconsistent coverage figures');
    if (successful && figure.measured < figure.minimum) fail(at, 'cannot pass below a coverage minimum');
  }
  if (successful && (!value.folders.length || value.folders.some(folder => !folder.files) || value.failures.length)) {
    fail(at, 'cannot pass without measured folders or with coverage failures');
  }
  if (value.touched) {
    const lines = value.touched.uncovered.flatMap(item => item.lines.map(line => `${item.file}:${line}`));
    if (new Set(lines).size !== lines.length || value.touched.total !== value.touched.covered + lines.length
      || value.touched.uncovered.some(item => item.lines.some((line, i) => i > 0 && line <= item.lines[i - 1]))) {
      fail(at, 'has inconsistent touched lines');
    }
  }
}

const testCase = fields({ file: text, name: string, status: choice('passed', 'failed', 'skipped'), message: nullable(string),
  ids: list(text), scenarios: list(text), bare: list(text), inverted: bool }, { line: positive, endLine: positive });
const suite = { cases: list(testCase), leftOut: list(fields({ file: text, ids: list(text), scenarios: list(text), bare: list(text) })) };
const testRun = fields({ ...suite,
  exit: nullable(check(v => typeof v === 'string' && v.trim() !== '' || Number.isInteger(v) && v >= 0 && v <= 255,
    'must be an exit code or signal')) });
export const testDocumentFields = checkDocumentFields('tests', fields({ reports: list(snapshot), ...suite }));

export const successfulTestRun = run => run.exit === 0 && !run.leftOut.length && !run.cases.some(test => test.status === 'failed');

export function validateTestRun(run, successful = false) {
  testRun(run, 'test evidence');
  for (const test of run.cases) {
    if ((test.line === undefined) !== (test.endLine === undefined) || test.endLine < test.line) fail('test evidence', 'has invalid test lines');
  }
  if (successful && !successfulTestRun(run)) {
    fail('test evidence', 'cannot pass with failed or omitted tests or an unsuccessful command');
  }
}

/** Descriptions are generated from diagnostics, never used as evidence. */
export function brief(value) {
  const line = String(value).replace(/\s+/gu, ' ').trim();
  const chars = [...line];
  return chars.length > 256 ? chars.slice(0, 255).join('') + '…' : line;
}

/** A reason shown as a sentence: it ends with one full stop, never two.
 * Reasons come from many places, some already ending in one, so the place
 * that builds the sentence decides. */
export function sentence(value) {
  const line = String(value).trim();
  return /[.!?…]$/u.test(line) ? line : `${line}.`;
}

export function validateResult(result, at = 'result') {
  fields({ name: text, status: choice('ok', 'partial', 'failed', 'skipped', 'reused'), evidence: validateEvidence,
    summary: check(object, 'must be an object') },
  { reason: description, source: fields({ seq: positive, fingerprint: hash }) })(result, at);
  const { name, status, summary: s } = result;
  if ((status === 'reused') !== Object.hasOwn(result, 'source')) fail(at + '.source', 'belongs only to a reused result and is required there');
  if (['partial', 'skipped', 'failed', 'reused'].includes(status) && !result.reason) fail(at + '.reason', 'is required for this status');
  if (status === 'partial' && !['tests', 'mutation'].includes(name)) fail(at + '.status', 'partial belongs only to tests and mutation');
  if (status === 'skipped') {
    if (result.evidence.length || Object.keys(s).length) fail(at, 'must have empty evidence and summary when skipped');
    return;
  }
  if (name === 'tests') {
    if (status !== 'failed' && !result.evidence.some(item => item.role === 'raw')) fail(at + '.evidence', 'requires a test report');
    const analyses = result.evidence.filter(item => item.role === 'analysis').length;
    if (analyses > 1 || status !== 'failed' && analyses !== 1) fail(at + '.evidence', 'requires one analysis artifact');
  }
  if (['coverage', 'mutation'].includes(name)) {
    for (const role of ['raw', 'analysis']) {
      const n = result.evidence.filter(item => item.role === role).length;
      if (n > 1 || status !== 'failed' && n !== 1) fail(at + '.evidence', `requires one ${role} artifact`);
    }
  }
  // A failed command may have produced no measurement. Do not give it zero
  // counts: empty or diagnostic-only summaries say precisely that much.
  if (status === 'failed' && Object.keys(s).every(key => key === 'diagnostics')) {
    fields({}, diagnostics)(s, at + '.summary');
    return;
  }
  ({ tests, coverage, mutation }[name] ?? generic)(s, at + '.summary');
  if (name === 'tests') {
    if (s.total !== s.passed + s.failed + s.skipped || s.inverted > s.total) fail(at + '.summary', 'has inconsistent test counts');
    if (status !== 'failed' && (s.failed || s.omittedFiles)) fail(at + '.summary', 'cannot pass with failed or omitted tests');
  }
  if (name === 'coverage') {
    for (const folder of s.folders) for (const metric of [folder.lines, folder.branches]) {
      if (status !== 'failed' && metric.percent < metric.target) fail(at + '.summary', 'cannot pass below a coverage minimum');
    }
    if (status !== 'failed' && !s.folders.length) fail(at + '.summary', 'cannot pass without measured folders');
    if (new Set(s.folders.map(folder => folder.folder)).size !== s.folders.length) fail(at + '.summary', 'has duplicate folders');
  }
  if (name === 'mutation') {
    if (s.totalMutants !== s.killed + s.survived + s.unproved + s.ignored + s.errored) fail(at + '.summary', 'has inconsistent mutation counts');
    if (status === 'ok' && (s.unproved || s.errored)) fail(at + '.status', 'incomplete mutation must be partial');
  }
  if (!TEST_QUALITY_RESULTS.includes(name) && status !== 'failed' && !['clean', 'findings'].includes(s.outcome)) fail(at + '.summary', 'does not describe a completed check');
}

export function validateChecksResults(value, at = 'results', seq = Infinity) {
  list(validateResult)(value, at);
  const quality = value.filter(item => TEST_QUALITY_RESULTS.includes(item.name));
  if (quality.length !== TEST_QUALITY_RESULTS.length || quality.some((item, index) => item.name !== TEST_QUALITY_RESULTS[index])) {
    fail(at, 'must contain tests, coverage and mutation in that order');
  }
  const names = new Set();
  for (const result of value) {
    if (names.has(result.name)) fail(at, `duplicates ${result.name}`);
    names.add(result.name);
    if (result.source && result.source.seq >= seq) fail(at + '.source', 'must precede this verification');
  }
  return value;
}
