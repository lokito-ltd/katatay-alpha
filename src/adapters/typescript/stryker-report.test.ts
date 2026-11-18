import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_REPORT, reportFileOf, writePartialReport } from './stryker-report.js';
import { respond, strykerOptions } from './stryker.js';
import { PROGRESS } from './mutate-plugins.mjs';
import { findingsOf } from '../../evidence/mutation-report.mjs';

describe('the Stryker report path', () => {
  it('defaults to the native JSON report path and accepts a custom path', () => {
    expect(reportFileOf([])).toBe('reports/mutation/mutation.json');
    expect(reportFileOf(['--vitest-config', 'vitest.ts', '--report-file', 'out/custom.json'])).toBe('out/custom.json');
    expect(reportFileOf(['--report-file', 'out/x:y.json'])).toBe('out/x:y.json');
    expect(strykerOptions([], 'plugins', 'vitest.ts', 'out/custom.json')).toMatchObject({
      reporters: ['progress-file', 'json'], jsonReporter: { fileName: 'out/custom.json' },
    });
  });

  it.each([[], [''], ['--verbose'], ['/outside.json'], ['../outside.json'], ['a/../b.json'],
    ['a\\b.json'], ['C:/a.json'], ['a//b.json'], ['./a.json'], ['a/*.json']].map((args) => ({ args })))('refuses invalid report arguments %#', ({ args }) => {
    expect(() => reportFileOf(['--report-file', ...args])).toThrow(/needs a path/);
  });
});

describe('reports from interrupted Stryker runs', () => {
  let root: string;
  const read = () => JSON.parse(readFileSync(join(root, DEFAULT_REPORT), 'utf8'));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const result = (fileName: string, id: string, status = 'Survived') => ({
    fileName, id, status, mutatorName: 'BooleanLiteral', replacement: 'false', testsCompleted: 1,
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } }, killedBy: ['test-1'],
  });
  const journal = (results: unknown[]) => write(PROGRESS, [{ planned: 10 }, ...results.map((r) => ({ result: r }))].map((r) => JSON.stringify(r)).join('\n'));
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stryker-report-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('publishes completed results with their ids, full locations and source', () => {
    write('a.ts', 'true');
    write('b.js', 'true');
    journal([result(join(root, 'a.ts'), '1'), result(join(root, 'a.ts'), '2', 'Killed'), result(join(root, 'b.js'), '3')]);
    writePartialReport(root, DEFAULT_REPORT, false);
    const report = read();
    expect(report).toMatchObject({ schemaVersion: '1.0', thresholds: { high: 80, low: 60 }, files: {
      'a.ts': { language: 'typescript', source: 'true', mutants: [
        { id: '1', killedBy: ['test-1'], location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } }, { id: '2' },
      ] },
      'b.js': { language: 'javascript', source: 'true' },
    } });
    expect(report.files['a.ts'].mutants[0]).not.toHaveProperty('fileName');
    expect(findingsOf(report).counts).toMatchObject({ total: 3, caught: 1, survived: 2 });
    expect(readdirSync(dirname(join(root, DEFAULT_REPORT)))).toEqual(['mutation.json']);
  });

  it('writes an empty report before any result arrives, and for a no-tests result', () => {
    writePartialReport(root, DEFAULT_REPORT, false);
    expect(findingsOf(read()).counts.total).toBe(0);
    write(PROGRESS, 'an irrelevant old journal');
    writePartialReport(root, DEFAULT_REPORT, true);
    expect(read().files).toEqual({});
  });

  it.each(['ts', 'tsx', 'mts', 'cts'])('keeps a nested .%s file and identifies its language', (extension) => {
    const file = `src/feature.${extension}`;
    write(file, 'true');
    journal([result(join(root, file), '1')]);
    writePartialReport(root, DEFAULT_REPORT, false);
    expect(read().files[file]).toMatchObject({ language: 'typescript', source: 'true' });
  });

  it('refuses a journal result outside the repository', () => {
    journal([result(join(root, '../outside.ts'), '1')]);
    expect(() => writePartialReport(root, DEFAULT_REPORT, false)).toThrow(/outside the repository/);
  });

  it('refuses the repository directory as a mutant source before reading it', () => {
    journal([result(root, '1')]);
    expect(() => writePartialReport(root, DEFAULT_REPORT, false)).toThrow(`mutate: result is outside the repository: ${root}`);
  });

  it('leaves no temporary file when publishing fails', () => {
    mkdirSync(join(root, DEFAULT_REPORT), { recursive: true });
    expect(() => writePartialReport(root, DEFAULT_REPORT, true)).toThrow();
    expect(readdirSync(dirname(join(root, DEFAULT_REPORT)))).toEqual(['mutation.json']);
  });

  const runResponse = (run: Parameters<typeof respond>[0]['run']) => {
    const written: string[] = [];
    const errors: string[] = [];
    return respond({ input: JSON.stringify({ targets: [], budget: 0.01 }), cwd: root, reportFile: DEFAULT_REPORT, run,
      write: (text) => { written.push(text); }, fail: (text) => { errors.push(text); }, warn: () => {} })
      .then((code) => ({ code, written, errors }));
  };

  it('waits for stopped workers before publishing a partial report and exits 1 for its survivor', async () => {
    write('a.ts', 'true');
    const answer = await runResponse(() => ({ done: new Promise(() => {}), stop: async () => {
      expect(existsSync(join(root, DEFAULT_REPORT))).toBe(false);
      journal([result(join(root, 'a.ts'), '1')]);
    } }));
    expect(answer).toMatchObject({ code: 1, errors: [] });
    expect(findingsOf(read())).toMatchObject({ partial: true, counts: { survived: 1 } });
  });

  it('writes a valid empty report for no tests and exits 2', async () => {
    const answer = await runResponse(() => ({ done: Promise.reject(new Error('No tests were executed.')), stop: async () => {} }));
    expect(answer).toMatchObject({ code: 2, errors: [] });
    expect(findingsOf(read()).counts.total).toBe(0);
  });

  it('clears stale reports before a run starts and keeps the native report when it completes', async () => {
    write(DEFAULT_REPORT, 'stale');
    const native = JSON.stringify({ schemaVersion: '1.0', thresholds: { high: 80, low: 60 }, files: {}, framework: { name: 'StrykerJS' } });
    const answer = await runResponse(() => {
      expect(existsSync(join(root, DEFAULT_REPORT))).toBe(false);
      write(DEFAULT_REPORT, native);
      return { done: Promise.resolve([]), stop: async () => {} };
    });
    expect(answer.errors).toEqual([]);
    expect(readFileSync(join(root, DEFAULT_REPORT), 'utf8')).toBe(native);
  });

  it('exits 3 and explains a report-writing failure', async () => {
    write('reports', 'a file blocks the report directory');
    const answer = await runResponse(() => ({ done: Promise.reject(new Error('No tests were executed.')), stop: async () => {} }));
    expect(answer).toMatchObject({ code: 3, written: [] });
    expect(answer.errors).toHaveLength(1);
  });
});
