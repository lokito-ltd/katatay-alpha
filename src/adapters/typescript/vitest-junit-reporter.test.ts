import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JUnitReporter, { attribute, caseOf, included, junitXml, scanTests } from './vitest-junit-reporter.js';
import { readJUnit } from '../../evidence/junit.js';

/** What the reporter reads of a Vitest test case, made up. */
const vitestCase = (over: { fullName?: string; line?: number; fails?: boolean; state?: string; message?: string } = {}) => ({
  fullName: over.fullName ?? 'area > does it',
  location: over.line === undefined ? undefined : { line: over.line, column: 1 },
  options: { fails: over.fails } as never,
  result: () => ({ state: over.state ?? 'passed', errors: over.message ? [{ message: over.message }] : [] }) as never,
});

describe('a module in the report', () => {
  it('is written when it passed, or was skipped, or failed in a test', () => {
    expect(included('passed', false)).toBe(true);
    expect(included('skipped', false)).toBe(true);
    expect(included('failed', true)).toBe(true);
  });

  // A file that did not load, or whose hook threw, failed outside every test.
  // Left out, the referee fails the whole file with every tag in it.
  it('is left out when it failed with no failed test, or never ran', () => {
    expect(included('failed', false)).toBe(false);
    expect(included('queued', false)).toBe(false);
    expect(included('pending', false)).toBe(false);
  });
});

describe('a test case in the report', () => {
  const spans = [{ line: 3, endLine: 7 }, { line: 9, endLine: 9 }];

  it('carries the full name, the file and the lines its test spans', () => {
    expect(caseOf(vitestCase({ line: 3 }), 'a.test.ts', spans)).toEqual({
      name: 'area > does it', file: 'a.test.ts', status: 'passed', line: 3, endLine: 7, inverted: false,
    });
  });

  it('gives no lines when the start does not match a test the syntax shows', () => {
    expect(caseOf(vitestCase({ line: 4 }), 'a.test.ts', spans)).not.toHaveProperty('line');
    expect(caseOf(vitestCase(), 'a.test.ts', spans)).not.toHaveProperty('endLine');
  });

  it('says a test under .fails is inverted', () => {
    expect(caseOf(vitestCase({ fails: true }), 'a.test.ts', []).inverted).toBe(true);
  });

  // A test that never ran must never read as one that passed.
  it('writes a test that did not run as skipped, and a failure with its first message', () => {
    expect(caseOf(vitestCase({ state: 'skipped' }), 'a.test.ts', []).status).toBe('skipped');
    expect(caseOf(vitestCase({ state: 'pending' }), 'a.test.ts', []).status).toBe('skipped');
    expect(caseOf(vitestCase({ state: 'failed', message: 'boom' }), 'a.test.ts', [])).toMatchObject({ status: 'failed', message: 'boom' });
  });
});

describe('the report written', () => {
  it('escapes what XML gives a meaning, and drops what XML forbids', () => {
    expect(attribute(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
    expect(attribute('line\none\ttab\r\u0007bell')).toBe('line&#10;one&#9;tab&#13;bell');
  });

  // The referee reads what the reporter writes, so the two are tested together.
  it('reads back through the referee\'s reader as it was written', () => {
    const xml = junitXml([
      {
        file: 'a.test.ts',
        included: true,
        cases: [
          { name: 'area > keeps <it> & "that" [AC0001.1]', file: 'a.test.ts', status: 'passed', line: 3, endLine: 7, inverted: false },
          { name: 'fails', file: 'a.test.ts', status: 'failed', message: 'expected 1\nto be 2', inverted: true },
          { name: 'skipped', file: 'a.test.ts', status: 'skipped', inverted: false },
        ],
      },
      { file: 'broken.test.ts', included: false, cases: [{ name: 'never', file: 'broken.test.ts', status: 'passed', inverted: false }] },
    ]);
    expect(readJUnit(xml, 'run.xml')).toEqual([
      {
        name: 'area > keeps <it> & "that" [AC0001.1]', classname: 'a.test.ts', file: 'a.test.ts', status: 'passed', message: null,
        properties: { line: ['3'], endLine: ['7'], inverted: ['false'] },
      },
      { name: 'fails', classname: 'a.test.ts', file: 'a.test.ts', status: 'failed', message: 'expected 1\nto be 2', properties: { inverted: ['true'] } },
      { name: 'skipped', classname: 'a.test.ts', file: 'a.test.ts', status: 'skipped', message: null, properties: { inverted: ['false'] } },
    ]);
  });

  it('is a report with no test cases when nothing was included', () => {
    expect(readJUnit(junitXml([]), 'run.xml')).toEqual([]);
  });
});

/**
 * The reporter as Vitest drives it: told the root, then handed the modules at
 * the end of the run. The modules are made up, so this runs in process.
 */
describe('the reporter at the end of a run', () => {
  let root: string;
  let saved: string | undefined;

  const module = (file: string, state: string, tests: ReturnType<typeof vitestCase>[]) => ({
    moduleId: join(root, file),
    state: () => state,
    children: { *allTests() { yield* tests; } },
  });
  const end = (modules: ReturnType<typeof module>[]) => {
    const reporter = new JUnitReporter();
    reporter.onInit({ config: { root } } as never);
    reporter.onTestRunEnd(modules as never);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'junit-end-')));
    saved = process.env.JUNIT_REPORT;
    process.env.JUNIT_REPORT = join(root, 'reports/junit/run.xml');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.JUNIT_REPORT;
    else process.env.JUNIT_REPORT = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('writes each included module\'s tests to the file JUNIT_REPORT names, its folder made', () => {
    writeFileSync(join(root, 'a.test.ts'), "it('does it', () => {\n  x();\n});\n");
    end([
      module('a.test.ts', 'passed', [vitestCase({ fullName: 'does it', line: 1 })]),
      module('b.test.ts', 'failed', [vitestCase({ fullName: 'never' })]),
    ]);
    expect(readJUnit(readFileSync(join(root, 'reports/junit/run.xml'), 'utf8'), 'run.xml')).toEqual([{
      name: 'does it', classname: 'a.test.ts', file: 'a.test.ts', status: 'passed', message: null,
      properties: { line: ['1'], endLine: ['3'], inverted: ['false'] },
    }]);
  });

  // A file that cannot be read gives no line ranges, and its tests are still
  // reported.
  it('reports the tests of a file it cannot read, without lines', () => {
    end([module('gone.test.ts', 'passed', [vitestCase({ fullName: 'still here', line: 1 })])]);
    const [c] = readJUnit(readFileSync(join(root, 'reports/junit/run.xml'), 'utf8'), 'run.xml');
    expect(c).toMatchObject({ name: 'still here', file: 'gone.test.ts', properties: { inverted: ['false'] } });
    expect(c!.properties).not.toHaveProperty('line');
  });

  // A run whose report went nowhere would read as every file left out.
  it('throws when JUNIT_REPORT names no file, and writes nothing', () => {
    delete process.env.JUNIT_REPORT;
    expect(() => end([])).toThrow('vitest-junit-reporter: JUNIT_REPORT names no file to write the report to');
    expect(existsSync(join(root, 'reports'))).toBe(false);
  });
});

/**
 * The lines each test spans, read from the syntax, for the reporter's `line`
 * and `endLine`. The referee finds which test a compile error sits in from
 * them. These used to be the tests of `tests.ts`, which moved into the
 * reporter so the reporter is one file.
 */
const spans = (source: string) => scanTests('some.test.ts', source);

describe('the lines a test spans', () => {
  it('gives an it() and a test() call the lines from its start to its end', () => {
    expect(spans([
      "it('one', () => {",
      '  expect(1).toBe(1);',
      '});',
      "test('two', () => {});",
    ].join('\n'))).toEqual([{ line: 1, endLine: 3 }, { line: 4, endLine: 4 }]);
  });

  // Vitest gives a test's location as the line its call starts on, and the
  // reporter matches the two by that line.
  it('starts a test under it.each where it.each starts, and lists it once', () => {
    expect(spans([
      'it.each([1, 2])(',
      "  'case %i',",
      '  () => {},',
      ');',
    ].join('\n'))).toEqual([{ line: 1, endLine: 4 }]);
  });

  it('reads through modifiers such as .skip, .fails and .skipIf()', () => {
    expect(spans([
      "it.skip('a', () => {});",
      "it.fails('b', () => {});",
      "test.skipIf(true)('c', () => {});",
    ].join('\n')).map((s) => s.line)).toEqual([1, 2, 3]);
  });

  // A compile error outside every test fails the whole file, so a group is
  // never a place one sits.
  it('lists the tests inside a describe, and not the describe', () => {
    expect(spans([
      "describe('area', () => {",
      "  it('inner', () => {});",
      '});',
    ].join('\n'))).toEqual([{ line: 2, endLine: 2 }]);
  });

  // Moved from the tests of `tsc.ts`, which retired when the referee began
  // reading the compiler's own output: these are the line ranges
  // `withCompileFailures` reads.
  it('gives the line range of every it/test call, nested ones and those under describe.each included', () => {
    expect(spans([
      "import { gone } from './somewhere';",
      "describe('things', () => {",
      "  it('first', () => {",
      '    broken().id;',
      '  });',
      "  it('second', () => {",
      '    fine();',
      '  });',
      "  describe.each([1, 2])('case %s', () => {",
      "    it('each', () => {",
      '      broken().id;',
      '    });',
      '  });',
      '});',
    ].join('\n')).map((t) => [t.line, t.endLine])).toEqual([[3, 5], [6, 8], [10, 12]]);
  });

  it('lists a test inside a test too, so the innermost can be found', () => {
    expect(spans([
      "it('outer', () => {",
      "  it('inner', () => {});",
      '});',
    ].join('\n'))).toEqual([{ line: 1, endLine: 3 }, { line: 2, endLine: 2 }]);
  });

  // A template literal whose text is an it() call is fixture data, not a test.
  it('ignores an it() call that is only text inside a string', () => {
    expect(spans("writeFileSync('example.test.ts', `it('does the thing', () => {});`);")).toEqual([]);
  });

  // Only a call whose leftmost name is `it` or `test` is a test.
  it('ignores a call whose callee starts with no plain name, or a method called it', () => {
    expect(spans("make()('x', () => {});\nthis.it('x', () => {});\n(fn)('x');")).toEqual([]);
  });

  it('ignores a call to anything else', () => {
    expect(spans("expect(1).toBe(1);\ndescribe('area', () => {});\nwrite('it');")).toEqual([]);
  });
});

describe('the reporter as Vitest starts it', () => {
  // The compiler comes from the project Vitest runs in, so the run says which.
  it('names the TypeScript it reads the tests with', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      new JUnitReporter().onInit({ config: { root: process.cwd() } } as never);
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/^vitest-junit-reporter: TypeScript 6\.\d+\.\d+ from typescript-api\n$/));
    } finally {
      write.mockRestore();
    }
  });
});
