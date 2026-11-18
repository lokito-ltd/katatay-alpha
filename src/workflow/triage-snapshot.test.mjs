import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisPath, triageAnalysis } from '../../tests/fixtures/workflow/events.mjs';
import { publishSnapshot } from './local-snapshot.mjs';
import { triageEvidence, writeTriageSnapshot } from './triage-snapshot.mjs';

let root, event;
const branch = 'topic';
const identities = { tests: [{ file: 'a', titles: ['passed', 'surprise'] }], unlisted: ['a-omitted', 'z-omitted'] };
const report = {
  predicted: { failed: 1, total: 2, failures: [] },
  surprise: { failed: 2, total: 2, failures: ['a — surprise (failure)'], names: ['a — surprise'] },
  overPredicted: { count: 2, total: 3, tests: ['a — passed', 'typo — matched no test'] },
  notRun: { predicted: ['z-omitted'], unpredicted: ['a-omitted'] },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'triage-details-'));
  event = { seq: 2, payload: writeTriageSnapshot(branch, identities, report, root) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('recovers both sections and every classification in order from the selected file', () => {
  expect(event.payload).toEqual({ evidence: [triageAnalysis(expect.stringContaining('/topic/triage/'))], testCount: 2,
    predicted: { failed: 1, total: 2 }, surprise: { failed: 2, total: 2 }, overPredicted: { count: 2, total: 3 },
    notRun: { predicted: 1, unpredicted: 1 } });
  expect(triageEvidence(branch, event, root)).toEqual({ identities, payload: { ...event.payload, invariants: [],
    surprise: report.surprise, overPredicted: report.overPredicted, notRun: report.notRun } });
});

it.each([0, 1, 2])('reads the analysis by role at position %i, regardless of display titles', position => {
  const analysis = { ...event.payload.evidence[0], title: 'Renamed analysis' };
  const evidence = ['a.xml', 'b.xml'].map(snapshot => ({ role: 'raw', title: 'Triage analysis', snapshot }));
  evidence.splice(position, 0, analysis);
  expect(triageEvidence(branch, { ...event, payload: { ...event.payload, evidence } }, root).identities).toEqual(identities);
});

it('keeps two runs with identical counts separate even when the selected file is lost', () => {
  const newerIdentities = { ...identities, tests: [{ file: 'b', titles: ['different', 'passed'] }] };
  const newerReport = { ...report, surprise: { ...report.surprise, failures: ['b — different failure'] } };
  const newer = { seq: 3, payload: writeTriageSnapshot(branch, newerIdentities, newerReport, root) };

  const { evidence: [{ snapshot: firstFile }], ...firstCounts } = event.payload;
  const { evidence: [{ snapshot: secondFile }], ...secondCounts } = newer.payload;
  expect(secondCounts).toEqual(firstCounts);
  expect(secondFile).not.toBe(firstFile);
  expect(triageEvidence(branch, event, root)).toMatchObject({
    identities, payload: { surprise: { failures: report.surprise.failures } },
  });
  rmSync(join(root, firstFile));
  expect(triageEvidence(branch, event, root)).toEqual({
    payload: event.payload, problem: expect.stringContaining(firstFile),
  });
  expect(triageEvidence(branch, newer, root)).toMatchObject({
    identities: newerIdentities, payload: { surprise: { failures: newerReport.surprise.failures } },
  });
});

it('rejects the digest-qualified reference from another branch', () => {
  const read = triageEvidence('peer', event, root);
  expect(read).toEqual({ payload: event.payload, problem: expect.stringContaining('triage 2 ' + analysisPath(event.payload) + ': invalid triage reference') });
});

it.each([
  ['version', data => { data.version = 2; }, 'triage.version has unsupported schema version 2'],
  ['null version', data => { data.version = null; }, 'triage.version has unsupported schema version null'],
  ['string version', data => { data.version = '1'; }, 'triage.version has unsupported schema version "1"'],
  ['missing version', data => { delete data.version; }, 'triage.version has unsupported schema version missing'],
  ['null identities', data => { data.identities = null; }, 'invalid triage snapshot identities or version'],
  ['duplicate title', data => { data.identities.tests[0].titles = ['passed', 'passed']; }, 'invalid triage snapshot identities or version'],
  ['empty test file', data => { data.identities.tests[0].file = ''; }, 'invalid triage snapshot identities or version'],
  ['empty title list', data => { data.identities.tests[0].titles = []; }, 'invalid triage snapshot identities or version'],
  ['null test group', data => { data.identities.tests = [null]; }, 'invalid triage snapshot identities or version'],
  ['duplicate group', data => { data.identities.tests.push(data.identities.tests[0]); }, 'invalid triage snapshot identities or version'],
  ['unsorted omitted files', data => { data.identities.unlisted.reverse(); }, 'invalid triage snapshot identities or version'],
  ['numeric description', data => { data.details.surprises[0] = 17; }, 'invalid triage snapshot details'],
  ['unsorted titles', data => { data.identities.tests[0].titles.reverse(); }, 'invalid triage snapshot identities or version'],
  ['absent details', data => { delete data.details; }, 'invalid triage snapshot details'],
  ['absent omitted-file lists', data => { delete data.details.notRun; }, 'invalid triage snapshot details'],
  ['blank description', data => { data.details.surprises[0] = ' '; }, 'invalid triage snapshot details'],
  ['surprise names', data => { data.details.surpriseNames = 'a — surprise'; }, 'invalid triage snapshot surprise names'],
  ['blank surprise name', data => { data.details.surpriseNames = [' ']; }, 'invalid triage snapshot surprise names'],
  ['surprise name count', data => { data.details.surpriseNames.push('a — another'); }, 'invalid triage snapshot surprise names'],
  ['omitted file added', data => { data.identities.unlisted.push('zz-omitted'); }, 'omitted files disagree'],
  ['identity count', data => { data.identities.tests[0].titles.pop(); }, 'event counts disagree'],
  ['omitted file count', data => { data.identities.unlisted.pop(); }, 'omitted files disagree'],
  ['surprise count', data => { data.details.surprises.pop(); data.details.surpriseNames.pop(); }, 'event counts disagree'],
  ['over-prediction count', data => { data.details.overPredictions.pop(); }, 'event counts disagree'],
  ['predicted omitted count', data => { data.details.notRun.predicted.pop(); }, 'event counts disagree'],
  ['unpredicted omitted count', data => {
    data.details.notRun.unpredicted = []; data.details.surprises.push('extra'); data.details.surpriseNames.push('extra');
  }, 'event counts disagree'],
  ['omitted file identity', data => { data.details.notRun.predicted[0] = 'other'; }, 'omitted files disagree'],
])('retains only the summary when the snapshot has a valid digest but invalid %s', (_label, damage, reason) => {
  const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
  damage(data);
  const ref = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
  const payload = { ...event.payload, evidence: [triageAnalysis(ref)] };
  expect(triageEvidence(branch, { ...event, payload }, root)).toEqual({ payload,
    problem: expect.stringContaining('triage 2 ' + ref + ': ' + reason) });
});

it('names the newline-terminated snapshot by the digest of its published bytes', () => {
  const bytes = readFileSync(join(root, analysisPath(event.payload)));
  expect(JSON.parse(bytes).version).toBe(1);
  expect(bytes.at(-1)).toBe(10);
  const digest = createHash('sha256').update(bytes).digest('base64url');
  expect(analysisPath(event.payload)).toMatch(/^\.katatay\/local\/topic\/triage\/\d{8}T\d{6}\.\d{3}Z_/);
  expect(analysisPath(event.payload).endsWith('_' + digest + '.json')).toBe(true);
});

it.each(['null document', 'invalid UTF-8'])('refuses a correctly hashed %s without exposing either section', damage => {
  let bytes = Buffer.from('null');
  let reason = 'triage.version has unsupported schema version missing';
  if (damage === 'invalid UTF-8') {
    bytes = readFileSync(join(root, analysisPath(event.payload)));
    const offset = bytes.indexOf('a — surprise (failure)');
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = 0xff;
    reason = 'encoded data was not valid';
  }
  const triageFile = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, bytes, root);
  const payload = { ...event.payload, evidence: [triageAnalysis(triageFile)] };
  const result = triageEvidence(branch, { ...event, payload }, root);
  expect(result).toEqual({ payload, problem: expect.stringContaining('triage 2 ' + triageFile) });
  expect(result.problem).toContain(reason);
});

it('keeps the failing invariant tests, and validates them', () => {
  const invariants = ['a — surprise [INV0001]'];
  const payload = writeTriageSnapshot(branch, identities, { ...report, invariants }, root);
  const data = JSON.parse(readFileSync(join(root, analysisPath(payload))));
  expect(data.details.invariants).toEqual(invariants);
  // The event holds the reason sentences, so the snapshot does not repeat them.
  expect(data.details).not.toHaveProperty('reasons');
  expect(triageEvidence(branch, { seq: 2, payload }, root).payload.invariants).toEqual(invariants);

  // Each a list the validator must refuse by name, not by crashing on it.
  for (const damage of [[''], ['   '], [5], [null], 'a — surprise']) {
    const bad = { ...data, details: { ...data.details, invariants: damage } };
    const ref = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(bad)), root);
    expect(triageEvidence(branch, { seq: 2, payload: { ...payload, evidence: [triageAnalysis(ref)] } }, root).problem).toContain('invalid triage snapshot invariants');
  }
});

it('reads the invariant tests from the reasons of a snapshot written before they had their own list, and validates them', () => {
  const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
  delete data.details.invariants;
  data.details.reasons = [{ text: 'Raised to HIGH by failing invariants:', items: ['a — surprise [INV0001]'] }, { text: 'Raised to HIGH by surprise failures.' }];
  const ref = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
  const read = triageEvidence(branch, { ...event, payload: { ...event.payload, evidence: [triageAnalysis(ref)] } }, root);
  expect(read).not.toHaveProperty('problem');
  expect(read.payload.invariants).toEqual(['a — surprise [INV0001]']);

  for (const damage of [[{ text: '' }], [{ text: '   ' }], [{ text: 5 }], [null], [{ text: 'x', items: [''] }], 'reasons']) {
    const bad = { ...data, details: { ...data.details, reasons: damage } };
    const badRef = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(bad)), root);
    expect(triageEvidence(branch, { ...event, payload: { ...event.payload, evidence: [triageAnalysis(badRef)] } }, root).problem).toContain('invalid triage snapshot reasons');
  }
});

it('stores the surprise names without their messages, and still reads a snapshot without them', () => {
  const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
  expect(data.details.surpriseNames).toEqual(['a — surprise']);
  expect(data.details.surprises).toEqual(['a — surprise (failure)']);
  delete data.details.surpriseNames;
  const ref = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
  const read = triageEvidence(branch, { ...event, payload: { ...event.payload, evidence: [triageAnalysis(ref)] } }, root);
  expect(read).not.toHaveProperty('problem');
  expect(read.payload.surprise).not.toHaveProperty('names');
});

it('still reads a snapshot written before the invariants or the reasons were kept, and names none', () => {
  const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
  delete data.details.invariants;
  delete data.details.reasons;
  const ref = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
  const read = triageEvidence(branch, { ...event, payload: { ...event.payload, evidence: [triageAnalysis(ref)] } }, root);
  expect(read).not.toHaveProperty('problem');
  expect(read.payload.invariants).toEqual([]);
});
