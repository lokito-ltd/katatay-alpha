import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findingsOf } from '../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';
import { publishSnapshot } from './local-snapshot.mjs';
import { readMutationSnapshot, writeMutationSnapshot } from './mutation-snapshot.mjs';

let root;
const branch = 'feat/x';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mutation-snapshot-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const standard = reportOf([mutant('Survived', { replacement: 'a !== b\n// replacement' })]);
const raw = JSON.stringify(standard, null, 2) + '\n';
const run = { raw, status: 1, outcome: 'survived', report: 'One survivor.\nOriginal command text.', findings: findingsOf(standard) };
const { raw: _raw, ...parsed } = run;
const document = () => ({ version: 1, name: 'mutation', result: { exitCode: 1, outcome: 'findings', text: run.report, reason: '1 mutant, 0 caught, 1 survived' },
  measurement: { toolOutcome: 'survived', findings: structuredClone(run.findings) } });
const keep = () => writeMutationSnapshot(branch, run, root);
const publish = (kind, bytes) => publishSnapshot(branch,
  { folder: 'mutation/' + kind, extension: 'json', label: kind }, Buffer.from(bytes), root);

it('preserves the exact raw report and complete findings in separately named snapshots', () => {
  const references = keep();
  expect(Object.keys(references)).toEqual(['raw', 'findings']);
  expect(references.raw).toMatch(/^\.katatay\/local\/feat_x\/mutation\/raw\/[^/]+_[\w-]{43}\.json$/);
  expect(references.findings).toMatch(/^\.katatay\/local\/feat_x\/mutation\/findings\/[^/]+_[\w-]{43}\.json$/);
  expect(readFileSync(join(root, references.raw), 'utf8')).toBe(raw);
  expect(JSON.parse(readFileSync(join(root, references.findings), 'utf8'))).toEqual(document());
  expect(readMutationSnapshot(branch, references, root)).toEqual(parsed);
});

it('uses the current repository when no root is supplied', () => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  expect(readMutationSnapshot(branch, writeMutationSnapshot(branch, run))).toEqual(parsed);
});

it.each(['raw', 'findings'])('refuses %s bytes whose digest no longer matches', kind => {
  const references = keep();
  writeFileSync(join(root, references[kind]), '{}');
  expect(() => readMutationSnapshot(branch, references, root)).toThrow(`(${references[kind]}): SHA-256 digest mismatch`);
});

it.each(['raw', 'findings'])('refuses a missing %s file', kind => {
  const references = keep();
  rmSync(join(root, references[kind]));
  expect(() => readMutationSnapshot(branch, references, root)).toThrow(`(${references[kind]}): ENOENT`);
});

it.each(['raw', 'findings'])('refuses %s that is not JSON even with a correct digest', kind => {
  const references = { ...keep(), [kind]: publish(kind, '{') };
  expect(() => readMutationSnapshot(branch, references, root)).toThrow(`(${references[kind]}): not JSON`);
});

it('refuses absent references before attempting a read', () => {
  expect(() => readMutationSnapshot(branch, undefined, root)).toThrow('No mutation snapshots were recorded');
});

it.each([
  [null, 'is not an object'], [[], 'is not an object'], ['raw', 'is not an object'],
  [{}, '.raw is not a snapshot path'], [{ raw: 'raw' }, '.findings is not a snapshot path'],
  [{ raw: ' ', findings: 'findings' }, '.raw is not a snapshot path'],
  [{ raw: 'raw', findings: 1 }, '.findings is not a snapshot path'],
])('refuses malformed references %j', (references, problem) => {
  expect(() => readMutationSnapshot(branch, references, root)).toThrow('Invalid mutation references: ' + problem);
});

// References are built from stored evidence, and findings are stored by an
// earlier run: on read, fields no format lists are ignored.
it('reads references and findings that hold fields no format lists', () => {
  const references = keep();
  expect(readMutationSnapshot(branch, { ...references, extra: 'extra' }, root)).toEqual(parsed);
  const older = { ...document(), producer: 'stryker' };
  older.measurement.findings.survivors[0].weight = 1;
  const findings = publish('findings', JSON.stringify(older));
  expect(() => readMutationSnapshot(branch, { ...references, findings }, root)).toThrow('Mutation findings do not match the raw report');
  delete older.measurement.findings.survivors[0].weight;
  const matching = publish('findings', JSON.stringify(older));
  expect(readMutationSnapshot(branch, { ...references, findings: matching }, root)).toEqual(parsed);
});

it('refuses findings holding a field no format lists when writing them', () => {
  const findings = structuredClone(run.findings);
  findings.counts.extra = 1;
  expect(() => writeMutationSnapshot(branch, { ...run, findings }, root)).toThrow('mutation analysis.measurement.findings.counts.extra is an unknown field');
});

it('refuses references to another branch or the wrong snapshot kind', () => {
  const references = keep();
  expect(() => readMutationSnapshot('other', references, root)).toThrow('invalid raw mutation report reference');
  expect(() => readMutationSnapshot(branch, { ...references, raw: references.findings }, root)).toThrow('invalid raw mutation report reference');
  expect(() => readMutationSnapshot(branch, { ...references, findings: references.raw }, root)).toThrow('invalid mutation findings reference');
});

it.each([
  ['null', () => null, 'must be an object'],
  ['old shape', () => ({ version: 1, ...parsed }), '.name is missing'],
  ['missing text', d => { delete d.result.text; return d; }, '.result.text is missing'],
  ['empty report', d => { d.result.text = ' '; return d; }, '.result.text'],
  ['exit code', d => { d.result.exitCode = 0; return d; }, '.result.exitCode disagrees'],
  ['tool outcome', d => { d.measurement.toolOutcome = 'none'; return d; }, '.measurement.toolOutcome'],
  ['check outcome', d => { d.result.outcome = 'clean'; return d; }, '.result.outcome disagrees'],
  ['survivors', d => { d.measurement.findings.survivors = []; return d; },
    'mutation analysis.measurement.findings.counts disagrees with the recorded statuses or survivors'],
  ...['total', 'caught', 'unproven'].map(key => [key, d => { d.measurement.findings.counts[key]++; return d; }, '.findings.counts']),
  ['clean with a survivor', d => { Object.assign(d.result, { exitCode: 0, outcome: 'clean' }); d.measurement.toolOutcome = 'clean'; return d; }, '.toolOutcome disagrees with the findings'],
  ['survived without survivors', d => { d.measurement.findings = findingsOf(reportOf()); return d; }, '.toolOutcome disagrees with the findings'],
])('refuses an invalid findings document: %s', (_, change, problem) => {
  const references = { ...keep(), findings: publish('findings', JSON.stringify(change(document()))) };
  expect(() => readMutationSnapshot(branch, references, root)).toThrow(problem);
});

it('refuses an invalid document before publishing it', () => {
  expect(() => writeMutationSnapshot(branch, { ...run, status: 0 }, root)).toThrow('exitCode disagrees with the tool outcome');
});

it('refuses a standard report whose schema is invalid', () => {
  const references = { ...keep(), raw: publish('raw', '{}') };
  expect(() => readMutationSnapshot(branch, references, root)).toThrow('expected a mutation report');
});

it('refuses a valid findings document from a different raw report', () => {
  const other = document();
  other.measurement.findings.survivors[0].replacement = 'a < b';
  const references = { ...keep(), findings: publish('findings', JSON.stringify(other)) };
  expect(() => readMutationSnapshot(branch, references, root)).toThrow('Mutation findings do not match the raw report');
});

it.each([
  [0, 'clean', reportOf([mutant('Killed')])],
  [2, 'nothing', { ...reportOf([mutant('Pending')]), partial: true }],
])('round-trips status %i with outcome %s', (status, outcome, standardReport) => {
  const findings = findingsOf(standardReport);
  const references = writeMutationSnapshot(branch, { raw: JSON.stringify(standardReport), status, outcome, report: 'Measured', findings }, root);
  expect(readMutationSnapshot(branch, references, root)).toEqual({ status, outcome, report: 'Measured', findings });
  expect(JSON.parse(readFileSync(join(root, references.findings), 'utf8'))).toMatchObject({
    result: { exitCode: status, outcome: status === 0 ? 'clean' : 'findings', text: 'Measured' }, measurement: { toolOutcome: outcome, findings },
  });
});
