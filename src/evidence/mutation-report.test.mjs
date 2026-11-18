import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findingsOf, readMutationReport, STATUSES } from './mutation-report.mjs';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';

describe('standard mutation reports', () => {
  it('counts unproved mutants separately from a confirmed survivor on a fresh load', async () => {
    vi.resetModules();
    const reader = await import('./mutation-report.mjs');
    const report = reportOf([mutant('Survived'), mutant('Survived', { id: 'unfinished', testsCompleted: 0 }),
      mutant('Pending', { id: 'pending' }), mutant('NoCoverage', { id: 'unreached' })]);
    const { counts } = reader.findingsOf(report);
    expect(counts.survived).toBe(1);
    expect(reader.unprovedCount(counts)).toBe(3);
  });

  it('counts every status and preserves each survivor, including its complete replacement', () => {
    const mutants = STATUSES.map((status, i) => mutant(status, { id: String(i) }));
    mutants.push(mutant('Survived', { id: 'zero', testsCompleted: 0 }));
    const replacement = 'a long replacement\n'.repeat(20);
    mutants.push(mutant('Survived', { file: 'a.ts', id: '0', replacement, testsCompleted: undefined, killedBy: ['test-1'] }));
    const report = reportOf(mutants);
    report.testFiles = { 'a.test.ts': { tests: [{ id: 'test-1', name: 'a test' }] } };
    const findings = findingsOf(report);
    expect(findings.counts).toEqual({
      total: 10, caught: 2, survived: 2, unproven: 1,
      statuses: { Killed: 1, Survived: 3, NoCoverage: 1, CompileError: 1, RuntimeError: 1, Timeout: 1, Ignored: 1, Pending: 1 },
    });
    expect(findings.survivors).toEqual([
      { file: 'a.ts', id: '0', location: mutants[0].location, mutator: 'EqualityOperator', sourceLine: 'a === b', replacement },
      { file: 'modules/a.ts', id: '1', location: mutants[0].location, mutator: 'EqualityOperator', sourceLine: 'a === b', replacement: 'a !== b' },
    ]);
  });

  it('preserves an explicit partial run even when its only reported mutant was killed', () => {
    const report = reportOf([mutant('Killed')]);
    expect(findingsOf(report)).not.toHaveProperty('partial');
    expect(findingsOf({ ...report, partial: true })).toMatchObject({ partial: true, counts: { caught: 1 } });
  });

  it('orders survivors by file, line, column and id, without merging them', () => {
    const at = (id, line, column) => mutant('Survived', { id, replacement: undefined,
      location: { start: { line, column }, end: { line, column: column + 1 } } });
    const findings = findingsOf(reportOf([at('z', 2, 1), at('b', 1, 2), at('a', 1, 2), at('x', 1, 1)]));
    expect(findings.survivors.map((s) => s.id)).toEqual(['x', 'a', 'b', 'z']);
    expect(findings.survivors[0]).not.toHaveProperty('replacement');
  });

  it.each(['1', '1.0', '1.0.0', '2', '2.1', '2.0.1', '2.12'])('accepts version %s and an empty report', (schemaVersion) => {
    expect(findingsOf({ ...reportOf(), schemaVersion }).counts.total).toBe(0);
  });

  it.each([null, [], {}, { ...reportOf(), schemaVersion: 1 }, { ...reportOf(), schemaVersion: '3.0' },
    { ...reportOf(), schemaVersion: '1.00' }, { ...reportOf(), schemaVersion: 'prefix1.0' }, { ...reportOf(), files: [] }])('refuses an unsupported report shape %#', (report) => {
    expect(() => findingsOf(report)).toThrow(/expected a mutation report/);
  });

  it.each([null, {}, { high: -1, low: 0 }, { high: 101, low: 0 }, { high: 90, low: 101 },
    { high: 90, low: -1 }, { high: 90.5, low: 60 }])('refuses invalid thresholds %#', (thresholds) => {
    expect(() => findingsOf({ ...reportOf(), thresholds })).toThrow(/thresholds/);
  });

  it.each(['/outside.ts', '../outside.ts', './a.ts', 'a/../b.ts', 'a//b.ts', 'C:/a.ts', 'a\\b.ts', ''])('refuses source path %s', (file) => {
    expect(() => findingsOf(reportOf([mutant('Survived', { file })]))).toThrow(/invalid file/);
  });

  it.each([null, { language: 1, source: '', mutants: [] }, { language: 'ts', source: 1, mutants: [] },
    { language: 'ts', source: '', mutants: {} }])('refuses malformed file result %#', (result) => {
    expect(() => findingsOf({ ...reportOf(), files: { 'a.ts': result } })).toThrow(/invalid file/);
  });

  it.each([null, { id: 1 }, { mutatorName: null }, { status: 'NewStatus' }, { replacement: 1 },
    { testsCompleted: -1 }, { testsCompleted: 0.5 }])('refuses malformed mutants %#', (over) => {
    const report = reportOf([mutant('Survived', over ?? {})]);
    if (over === null) report.files['modules/a.ts'].mutants = [null];
    expect(() => findingsOf(report)).toThrow(/invalid or duplicate mutant/);
  });

  it('refuses duplicate ids within a file but accepts the same id in another file', () => {
    expect(() => findingsOf(reportOf([mutant('Killed'), mutant('Survived')]))).toThrow(/duplicate/);
    expect(findingsOf(reportOf([mutant('Killed'), mutant('Survived', { file: 'b.ts' })]))).toMatchObject({ counts: { total: 2 } });
  });

  it('accepts threshold endpoints, insertions, multiline locations and colons within a relative path', () => {
    const report = reportOf([
      mutant('Survived', { file: 'src/x:y.ts', location: { start: { line: 1, column: 3 }, end: { line: 1, column: 3 } } }),
      mutant('Survived', { id: '2', location: { start: { line: 1, column: 7 }, end: { line: 2, column: 2 } } }),
    ]);
    report.thresholds = { high: 100, low: 100 };
    expect(findingsOf(report).counts.survived).toBe(2);
  });

  it.each([null, {}, { start: { line: 0, column: 1 }, end: { line: 1, column: 2 } },
    { start: { line: 1, column: 0 }, end: { line: 1, column: 2 } },
    { start: { line: 1, column: 1 }, end: { line: 1, column: 0 } },
    { start: { line: 2, column: 1 }, end: { line: 1, column: 2 } },
    { start: { line: 1, column: 3 }, end: { line: 1, column: 2 } }])('refuses invalid locations %#', (location) => {
    expect(() => findingsOf(reportOf([mutant('Survived', { location })]))).toThrow(/invalid location/);
  });
});

describe('a mutation report on disk', () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const file = (text) => {
    const root = mkdtempSync(join(tmpdir(), 'mutation-report-'));
    roots.push(root);
    const path = join(root, 'report.json');
    if (text !== undefined) writeFileSync(path, text);
    return path;
  };

  it('refuses missing files and invalid JSON', () => {
    expect(() => readMutationReport(file(), 'clean')).toThrow(/ENOENT/);
    expect(() => readMutationReport(file('{'), 'clean')).toThrow();
  });

  it('checks the exit against survivors, while keeping findings from an inconclusive run', () => {
    const survived = file(JSON.stringify(reportOf([mutant('Survived')])));
    expect(() => readMutationReport(survived, 'clean')).toThrow(/contradicts/);
    expect(readMutationReport(survived, 'survived').counts.survived).toBe(1);
    expect(readMutationReport(survived, 'nothing').counts.survived).toBe(1);
    const clean = file(JSON.stringify(reportOf([mutant('Killed')])));
    expect(readMutationReport(clean, 'clean').counts.caught).toBe(1);
    expect(() => readMutationReport(clean, 'survived')).toThrow(/contradicts/);
    const unproven = file(JSON.stringify(reportOf([mutant('Survived', { testsCompleted: 0 })])));
    expect(() => readMutationReport(unproven, 'clean')).toThrow(/contradicts/);
  });
});
