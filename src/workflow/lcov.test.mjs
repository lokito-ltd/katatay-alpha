import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError } from './adapter.mjs';
import { parseLcov } from './lcov.mjs';

const ROOT = '/repo';
const parse = (lines, root = ROOT) => parseLcov(`${lines.join('\n')}\n`, root, 'lcov.info');
const refusal = (lines, root = ROOT) => {
  try {
    parse(lines, root);
  } catch (error) {
    return error;
  }
  throw new Error('expected the report to be refused');
};
/** One block for `a.ts`, with the given records between `SF` and `end_of_record`. */
const block = (...records) => ['SF:a.ts', ...records, 'end_of_record'];

describe('reading an lcov report', () => {
  it('counts the lines that can run, and which of them ran', () => {
    const { files } = parse(block('DA:1,3', 'DA:2,0', 'DA:4,1', 'DA:7,0'));
    expect(files).toEqual([{
      file: 'a.ts',
      lines: { covered: 2, total: 4 },
      branches: { covered: 0, total: 0 },
      uncoveredLines: [2, 7],
      coveredLines: [1, 4],
    }]);
  });

  // `-` means the code holding the branch never ran, which is not taken.
  it('counts each way a branch can go, taken when its count is above 0', () => {
    const { files } = parse(block('DA:1,1', 'BRDA:1,0,0,2', 'BRDA:1,0,1,0', 'BRDA:3,1,0,-', 'BRDA:3,1,1,1'));
    expect(files[0].branches).toEqual({ covered: 2, total: 4 });
  });

  // The rule Istanbul's own summary uses, so the figures match it.
  it('counts a line once, at the highest count any record gives it', () => {
    const { files } = parse(block('DA:5,0', 'DA:5,2', 'DA:5,0'));
    expect(files[0]).toMatchObject({ lines: { covered: 1, total: 1 }, coveredLines: [5], uncoveredLines: [] });
  });

  it('sorts the lines, whatever order the report gives them in', () => {
    const { files } = parse(block('DA:9,0', 'DA:3,1', 'DA:1,0', 'DA:2,1'));
    expect(files[0].uncoveredLines).toEqual([1, 9]);
    expect(files[0].coveredLines).toEqual([2, 3]);
  });

  it('reads a checksum after a line\'s count as nothing more', () => {
    expect(parse(block('DA:1,1,abc123')).files[0].coveredLines).toEqual([1]);
  });

  it('leaves alone the records it has no use for, such as test names and functions', () => {
    const { files } = parse(['TN:unit', 'VER:2.0', ...block('FN:1,main', 'FNDA:1,main', 'FNF:1', 'FNH:1', 'DA:1,1')]);
    expect(files[0].lines).toEqual({ covered: 1, total: 1 });
  });

  it('takes the block\'s totals when they agree with its records', () => {
    const { files } = parse(block('DA:1,1', 'DA:2,0', 'LF:2', 'LH:1', 'BRDA:1,0,0,1', 'BRDA:1,0,1,-', 'BRF:2', 'BRH:1'));
    expect(files[0]).toMatchObject({ lines: { covered: 1, total: 2 }, branches: { covered: 1, total: 2 } });
  });

  it('reads \\r\\n as a line end, and space around a record as nothing', () => {
    const { files } = parseLcov('SF:a.ts\r\n  DA:1,1  \r\n\r\nend_of_record\r\n', ROOT);
    expect(files[0].coveredLines).toEqual([1]);
  });

  it('gives one entry per file, sorted by path', () => {
    const { files } = parse(['b.ts', 'c.ts', 'a.ts', 'd/e.ts', 'b2.ts'].flatMap((file) => [`SF:${file}`, 'DA:1,1', 'end_of_record']));
    expect(files.map(({ file }) => file)).toEqual(['a.ts', 'b.ts', 'b2.ts', 'c.ts', 'd/e.ts']);
  });

  // A branch is known by its line, its block and its branch together, so
  // two branches whose numbers run together are still two.
  it('keeps apart branches whose numbers would run together', () => {
    expect(parse(block('BRDA:1,11,0,1', 'BRDA:11,1,0,0')).files[0].branches).toEqual({ covered: 1, total: 2 });
  });

  // What joining two runs' reports gives, such as `cat unit.info e2e.info`.
  it('merges a file named in two blocks, at the highest count per line and per branch', () => {
    const { files } = parse([
      ...block('DA:1,0', 'DA:2,1', 'BRDA:1,0,0,0', 'BRDA:1,0,1,1', 'LF:2', 'LH:1'),
      ...block('DA:1,4', 'DA:3,0', 'BRDA:1,0,0,2', 'BRDA:1,0,1,-', 'LF:2', 'LH:1'),
    ]);
    expect(files).toEqual([{
      file: 'a.ts',
      lines: { covered: 2, total: 3 },
      branches: { covered: 2, total: 2 },
      uncoveredLines: [3],
      coveredLines: [1, 2],
    }]);
  });
});

describe('the paths an lcov report names', () => {
  it('takes a path from the root as it is, without a leading ./', () => {
    expect(parse(['SF:./src/a.ts', 'DA:1,1', 'end_of_record']).files[0].file).toBe('src/a.ts');
  });

  it('makes an absolute path under the root relative to it', () => {
    expect(parse(['SF:/repo/src/a.ts', 'DA:1,1', 'end_of_record']).files[0].file).toBe('src/a.ts');
  });

  // On macOS the temporary folder is reached through a symlink, so a tool
  // may write the real path where the referee was given the linked one.
  it('makes an absolute path under the root\'s real path relative to it', () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'lcov-real-')));
    const linked = join(tmpdir(), `lcov-link-${process.pid}`);
    try {
      symlinkSync(real, linked);
      expect(parse([`SF:${real}/src/a.ts`, 'DA:1,1', 'end_of_record'], linked).files[0].file).toBe('src/a.ts');
    } finally {
      rmSync(linked, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  // The coverage check names files from the root. One outside it cannot be
  // named that way, and guessing would put its lines in some folder's figure.
  it('refuses a path outside the root', () => {
    for (const path of ['/elsewhere/a.ts', '../a.ts', '/repo', '..', '.']) {
      expect(refusal([`SF:${path}`, 'DA:1,1', 'end_of_record']).message, path).toMatch(/the report names .*, which is not under \/repo$/);
    }
  });
});

describe('an lcov report the referee refuses', () => {
  it('refuses as an AdapterError, naming the report and the line', () => {
    const error = refusal(['DA:1,1']);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toBe('lcov.info, line 1: DA: before any SF:');
  });

  // Read as an empty figure, a report that names no file would pass every
  // touched line, which is what no report at all must never do.
  it('refuses a report that names no file', () => {
    expect(refusal([]).message).toBe('lcov.info: it names no file (no SF: record), so it measured nothing');
    expect(refusal(['TN:unit']).message).toMatch(/names no file/);
  });

  it('refuses a line that is not a record, quoting at most 80 characters of it', () => {
    expect(refusal(['all covered']).message).toBe('lcov.info, line 1: "all covered" is not an lcov record, which is a tag, a colon and a value');
    expect(refusal([':1,1']).message).toMatch(/is not an lcov record/);
    expect(refusal(['x'.repeat(200)]).message).toBe(`lcov.info, line 1: "${'x'.repeat(80)}" is not an lcov record, which is a tag, a colon and a value`);
  });

  it('refuses a block that is opened twice, closed without opening, or left open', () => {
    expect(refusal(['SF:a.ts', 'SF:b.ts']).message).toBe('lcov.info, line 2: SF: for a new file before the end_of_record of a.ts');
    expect(refusal(['end_of_record']).message).toBe('lcov.info, line 1: end_of_record with no SF: before it');
    expect(refusal(['SF:a.ts', 'DA:1,1']).message).toBe('lcov.info: the block for a.ts has no end_of_record');
    expect(refusal(['SF:', 'end_of_record']).message).toBe('lcov.info, line 1: SF: with no path');
  });

  it('refuses a line record that is not a line from 1 and a count from 0', () => {
    for (const value of ['0,1', '-1,1', '1.5,1', 'x,1', '1', '1,', '1,-1', '1,2.5', '1,x', '']) {
      expect(refusal(block(`DA:${value}`)).message, value).toMatch(/^lcov\.info, line 2: DA: must be a line number from 1 and a count from 0/);
    }
  });

  it('refuses a branch record that is not a line, a block, a branch and a count or -', () => {
    for (const value of ['1,0,0', '1,0,0,1,1', '0,0,0,1', 'x,0,0,1', '1,,0,1', '1,0,,1', '1,0,0,x', '1,0,0,-1', '1,0,0,']) {
      expect(refusal(block(`BRDA:${value}`)).message, value).toMatch(/^lcov\.info, line 2: BRDA: must be a line number, a block, a branch/);
    }
  });

  it('refuses a total that is not a whole number', () => {
    for (const tag of ['LF', 'LH', 'BRF', 'BRH']) {
      expect(refusal(block('DA:1,1', `${tag}:x`)).message, tag).toBe(`lcov.info, line 3: ${tag}: must be a whole number, and is "x"`);
    }
  });

  // The writer is wrong in one of them, and the referee cannot tell which.
  it('refuses totals that disagree with the block\'s own records', () => {
    expect(refusal(block('DA:1,1', 'DA:2,0', 'LF:3')).message).toBe('lcov.info, line 5: a.ts says LF:3, and its records count 2');
    expect(refusal(block('DA:1,1', 'DA:2,0', 'LH:2')).message).toBe('lcov.info, line 5: a.ts says LH:2, and its records count 1');
    expect(refusal(block('BRDA:1,0,0,1', 'BRF:2')).message).toBe('lcov.info, line 4: a.ts says BRF:2, and its records count 1');
    expect(refusal(block('BRDA:1,0,0,-', 'BRH:1')).message).toBe('lcov.info, line 4: a.ts says BRH:1, and its records count 0');
  });

  it('calls the report what the caller names it, and "the coverage report" otherwise', () => {
    expect(() => parseLcov('DA:1,1\n', ROOT)).toThrow('the coverage report, line 1: DA: before any SF:');
  });
});
