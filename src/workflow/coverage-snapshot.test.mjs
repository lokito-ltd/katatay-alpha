import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCoverageSnapshot, writeCoverageSnapshot } from './coverage-snapshot.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'coverage-snapshot-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const baseline = 'b'.repeat(40);
const figure = (covered, total) => ({ covered, total, measured: total === 0 ? 1000 : Math.floor((covered * 1000) / total), minimum: 0 });
const document = (over = {}) => ({
  version: 1,
  name: 'coverage',
  result: { outcome: 'clean', exitCode: 0, text: '', reason: 'every folder is at or above its minimum' },
  measurement: { folders: [{ folder: 'modules/', files: 1, lines: figure(1, 2), branches: figure(0, 0) }], failures: [],
    touched: { covered: 1, total: 2, uncovered: [{ file: 'modules/a.mjs', lines: [2] }] } },
  ...over,
});
const LCOV = 'SF:modules/a.mjs\nDA:1,1\nDA:2,0\nend_of_record\n';
const keep = (analysis = document(), branch = 'feat/x') => writeCoverageSnapshot(branch, { raw: LCOV, analysis: JSON.stringify(analysis) }, root);

it('keeps the raw report and the analysis as two digest-named files and reads the analysis back', () => {
  const references = keep();
  expect(Object.keys(references)).toEqual(['raw', 'analysis']);
  expect(references.raw).toMatch(/^\.katatay\/local\/feat_x\/coverage\/[^/]+_[\w-]{43}\.lcov$/);
  expect(references.analysis).toMatch(/^\.katatay\/local\/feat_x\/coverage\/[^/]+_[\w-]{43}\.json$/);
  expect(readFileSync(join(root, references.raw), 'utf8')).toBe(LCOV);
  expect(readCoverageSnapshot('feat/x', references, baseline, root)).toEqual(document().measurement);
});

it('rejects the former coverage document even with valid figures', () => {
  const { measurement, result } = document();
  const refs = keep({ version: 1, name: 'coverage', chain: 'testQuality', identity: { baseline }, result, coverage: measurement });
  expect(() => readCoverageSnapshot('feat/x', refs, baseline, root)).toThrow('measurement is missing');
});

// An analysis is stored by an earlier run: on read, fields no format lists
// are ignored, at any depth, and so are extra keys in the references.
it('reads a stored analysis and references holding fields no format lists', () => {
  const older = document();
  older.measurement.folders[0].lines.functions = 3;
  older.measurement.source = 'v8';
  const references = keep(older);
  expect(readCoverageSnapshot('feat/x', { ...references, extra: 'extra' }, baseline, root)).toEqual(older.measurement);
});

it('refuses missing or malformed references', () => {
  const references = keep();
  expect(() => readCoverageSnapshot('feat/x', undefined, baseline, root)).toThrow('No coverage snapshots were recorded');
  expect(() => readCoverageSnapshot('feat/x', { raw: references.raw }, baseline, root)).toThrow('Invalid coverage references: .analysis is not a snapshot path');
  expect(() => readCoverageSnapshot('feat/x', { analysis: references.analysis, raw: references.analysis }, baseline, root)).toThrow('raw coverage');
  expect(() => readCoverageSnapshot('other', references, baseline, root)).toThrow('invalid raw coverage reference');
});

it('refuses a raw report whose bytes no longer match its digest', () => {
  const references = keep();
  writeFileSync(join(root, references.raw), 'SF:other\n');
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow(`raw coverage (${references.raw}): SHA-256 digest mismatch`);
});

it('refuses an analysis whose bytes no longer match its digest', () => {
  const references = keep();
  writeFileSync(join(root, references.analysis), '{}');
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow(`coverage analysis (${references.analysis}): SHA-256 digest mismatch`);
});

it('refuses a missing analysis file', () => {
  const references = keep();
  rmSync(join(root, references.analysis));
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow(`coverage analysis (${references.analysis}): ENOENT`);
});

it('refuses an analysis that is not JSON', () => {
  const references = writeCoverageSnapshot('feat/x', { raw: LCOV, analysis: '{' }, root);
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow('not JSON');
});

it('refuses an analysis whose result was not successful', () => {
  const references = keep(document({ result: { outcome: 'findings', exitCode: 0, text: '', reason: 'below a minimum' } }));
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow('not successful (below a minimum)');
});

it('reads an analysis made without a baseline as having no touched lines', () => {
  const references = keep(document({ measurement: { ...document().measurement, touched: null } }));
  expect(readCoverageSnapshot('feat/x', references, null, root).touched).toBeNull();
});

// The shape check runs before anything else is read, so a bad envelope is
// named as one and never surfaces as a TypeError from a later check.
it.each([
  ['another check name', { name: 'other' }],
  ['no measurement', { measurement: undefined }],
  ['no result', { result: undefined }],
  ['an unknown outcome', { result: { outcome: 'passed', exitCode: 0, text: '', reason: 'passed' } }],
])('refuses an analysis with %s as an invalid shape', (_, over) => {
  const references = keep(document(over));
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow('coverage: saved analysis has an invalid shape');
});

it('identifies the missing result field in a digest-valid coverage snapshot', () => {
  const analysis = document();
  delete analysis.result.exitCode;
  const references = keep(analysis);
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root))
    .toThrow(`coverage: saved analysis has an invalid shape: ${references.analysis}: coverage analysis.result.exitCode is missing`);
});

it('names the unsupported schema and its coverage analysis file', () => {
  const refs = keep(document({ version: 2 }));
  expect(() => readCoverageSnapshot('feat/x', refs, baseline, root))
    .toThrow(`${refs.analysis}: coverage analysis.version has unsupported schema version 2`);
});

it('refuses an analysis that is JSON null as an invalid shape', () => {
  const references = writeCoverageSnapshot('feat/x', { raw: LCOV, analysis: 'null' }, root);
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow('coverage: saved analysis has an invalid shape');
});

it.each(['broken', 'skipped'])('names a %s analysis as not successful', (outcome) => {
  const references = keep(document({ result: { outcome, exitCode: null, text: '', reason: `it was ${outcome}` } }));
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow(`not successful (it was ${outcome})`);
});

// Touched lines exist exactly when there was a baseline to measure them from.
it('refuses touched lines in an analysis made without a baseline', () => {
  const references = keep();
  expect(() => readCoverageSnapshot('feat/x', references, null, root)).toThrow('coverage: saved analysis has invalid coverage figures');
});

it('refuses missing touched lines in an analysis made from a baseline', () => {
  const references = keep(document({ measurement: { ...document().measurement, touched: null } }));
  expect(() => readCoverageSnapshot('feat/x', references, baseline, root)).toThrow('coverage: saved analysis has invalid coverage figures');
});
