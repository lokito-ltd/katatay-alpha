import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutant, reportOf } from '../../tests/fixtures/workflow/mutation-report.mjs';
import { findingsOf } from './mutation-report.mjs';
import { survivorReport } from './mutation-display.mjs';

function at(id, file, line, column, replacement) {
  return mutant('Survived', { id, file, replacement, mutatorName: 'Condition', source: '  a || b\r\nc\r\n',
    location: { start: { line, column }, end: { line, column: column + 1 } } });
}

it('groups the same change across columns only within its original file and start line', () => {
  const findings = findingsOf(reportOf([
    at('1', 'a.ts', 1, 3, 'false'), at('2', 'a.ts', 1, 8, 'false'), at('3', 'a.ts', 1, 3, 'true'),
    at('4', 'a.ts', 2, 1, 'false'), at('5', 'b.ts', 1, 3, 'false'),
    { ...at('6', 'a.ts', 1, 8, 'false'), mutatorName: 'Boolean' },
  ]));
  const original = 'Partial run\n  Survived:\n  - a.ts:1 Condition → false\n  - a.ts:1 Diagnostic → workers timed out';
  expect(survivorReport(original, findings.survivors).split('\n')).toEqual([
    'Partial run', '  - a.ts:1 Diagnostic → workers timed out', '', 'Survivors by line:',
    'a.ts:1', '    a || b', '    Condition → false  ×2', '    Condition → true', '    Boolean → false',
    'a.ts:2', '  c', '    Condition → false', 'b.ts:1', '    a || b', '    Condition → false',
  ]);
  expect(findings.survivors.map(s => s.id)).toEqual(['1', '3', '2', '6', '4', '5']);
  expect(findings.counts.survived).toBe(6);
});

it('distinguishes complete multiline replacements, empty replacements and omitted replacements', () => {
  const changes = ['same prefix\nx', 'same prefix\ny', '', undefined];
  const { survivors } = findingsOf(reportOf(changes.map((replacement, i) => at(String(i), 'a.ts', 1, i + 1, replacement))));
  expect(survivorReport('run', survivors).split('\n').slice(-6)).toEqual([
    '    Condition → same prefix', '      x', '    Condition → same prefix', '      y', '    Condition → ', '    Condition',
  ]);
});

describe('flat survivor lists in saved reports', () => {
  const row = '- a.ts:1 Condition → false';
  const heading = 'Survivors in the report:';

  it.each([
    ['1 mutant, 0 caught, 1 survived', 1],
    ['24 mutants, 12 caught, 12 survived', 12],
  ])('groups the old list once and preserves the summary "%s"', (summary, count) => {
    const { survivors } = findingsOf(reportOf(Array.from({ length: count }, (_, i) => at(String(i), 'a.ts', 1, 3, 'false'))));
    const saved = ['Run finished.', heading, ...Array(count).fill(row), summary].join('\n');
    expect(survivorReport(saved, survivors).split('\n')).toEqual([
      'Run finished.', summary, '', 'Survivors by line:', 'a.ts:1', '    a || b',
      count === 1 ? '    Condition → false' : '    Condition → false  ×12',
    ]);
  });

  it.each([
    ['Tool diagnostic: ' + heading, '1 mutant, 0 caught, 1 survived'],
    [heading, '1 mutant, 0 caught, 1 survived after the worker restarted'],
  ])('preserves tool text that resembles a referee list: %s / %s', (first, last) => {
    const { survivors } = findingsOf(reportOf([at('1', 'a.ts', 1, 3, 'false')]));
    const diagnostic = [first, row, last].join('\n');
    expect(survivorReport(diagnostic, survivors)).toContain(diagnostic + '\n\nSurvivors by line:');
  });
});

describe('the saved source line', () => {
  let root;
  const { survivors } = findingsOf(reportOf([at('1', 'a.ts', 1, 3, 'false')]));
  const display = () => survivorReport('run', survivors, root);
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mutation-display-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('recognises the exact line anywhere in the file, including after a move or test-only edit', () => {
    writeFileSync(join(root, 'a.ts'), 'intro\n  a || b\n');
    writeFileSync(join(root, 'a.test.ts'), 'new test');
    expect(display()).toContain('a.ts:1\n    a || b');
    writeFileSync(join(root, 'a.ts'), 'a || b\n  a || b && c\n');
    expect(display()).toContain('a.ts:1 (changed since the run)\n    a || b');
  });

  it('distinguishes a deleted file from a path it cannot compare', () => {
    expect(display()).toContain('a.ts:1 (changed since the run)');
    mkdirSync(join(root, 'a.ts'));
    expect(display()).toContain('a.ts:1 (comparison unavailable)');
    rmSync(join(root, 'a.ts'), { recursive: true });
    symlinkSync(import.meta.filename, join(root, 'a.ts'));
    expect(display()).toContain('a.ts:1 (comparison unavailable)');
  });

  it('reports an unavailable comparison when a symlink loop prevents reading the file', () => {
    symlinkSync('a.ts', join(root, 'a.ts'));
    expect(display()).toContain('a.ts:1 (comparison unavailable)\n    a || b');
  });

  it('marks the source as changed when its parent directory has been replaced by a file', () => {
    writeFileSync(join(root, 'src'), 'no longer a directory');
    const { survivors: nested } = findingsOf(reportOf([at('1', 'src/a.ts', 1, 3, 'false')]));
    expect(survivorReport('run', nested, root)).toContain('src/a.ts:1 (changed since the run)\n    a || b');
  });

  it('groups older records and out-of-range locations without guessing their source text', () => {
    const { sourceLine, ...older } = survivors[0];
    const beyond = findingsOf(reportOf([at('2', 'b.ts', 3, 1, undefined)])).survivors[0];
    expect(beyond).not.toHaveProperty('sourceLine');
    const saved = 'partial\nSurvivors in the report:\n- a.ts:1 Condition → false\n- b.ts:3 Condition\ninconclusive: 2 mutants, 0 caught, 2 survived';
    expect(survivorReport(saved, [older, beyond], root)).toBe(
      'partial\ninconclusive: 2 mutants, 0 caught, 2 survived\n\nSurvivors by line:\na.ts:1\n    Condition → false\nb.ts:3\n    Condition');
  });

  it('keeps a tool heading and diagnostic when there are no flat survivor rows after it', () => {
    expect(survivorReport('Diagnostic\nSurvived:\n  worker stopped', survivors))
      .toContain('Diagnostic\nSurvived:\n  worker stopped\n\nSurvivors by line:');
  });
});
