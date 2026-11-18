import { describe, expect, it } from 'vitest';
import type { TestOutcome } from './risk.js';
import type { TestRun } from './test-run.js';
import { splitErrors, withCompileFailures } from './typecheck.js';

/**
 * The outcomes the run gives for this file, each with the lines the reporter says
 * its test spans:
 *
 *     1  import { gone } from './somewhere';
 *     2  describe('things', () => {
 *     3    it('first', () => {
 *     4      broken().id;
 *     5    });
 *     6    it('second', () => {
 *     7      fine();
 *     8    });
 *     9    describe.each([1, 2])('case %s', () => {
 *    10      it('each', () => {
 *    11        broken().id;
 *    12      });
 *    13    });
 *    14  });
 */
const outcome = (title: string, line: number | undefined, endLine: number | undefined, extra: Partial<TestOutcome> = {}): TestOutcome => ({
  file: 'a.test.ts', title, ids: [], failed: false, ...(line === undefined ? {} : { line, endLine }), ...extra,
});

/** The run the outcomes came from. Only a file with no outcomes reads it, for
 *  the tags its tests carry. */
const RUN: TestRun = { cases: [], leftOut: [], exit: 0 };

describe('splitErrors', () => {
  // The triage refuses on `elsewhere` and classifies `inTests`. The freeze
  // decides what may not be edited yet, and this must agree with it: an error
  // in a frozen file sent to `elsewhere` would make the triage refuse over a
  // file nobody may fix until it has run.
  it('classifies errors in the machine harness and other frozen support as test results', () => {
    const at = (file: string) => ({ file, line: 1, message: 'TS0000: x' });
    const { inTests, elsewhere } = splitErrors([
      at('tests/acceptance/start_project.test.ts'),
      at('modules/projects/store.test.ts'),
      at('src/workflow/chain.test.mjs'),
      at('modules/projects/store.ts'),
      at('tests/support/app-server.ts'),
      at('tests/acceptance/support.ts'),
      at('tests/support/machine/harness.mjs'),
    ]);

    expect(inTests.map((e) => e.file)).toEqual([
      'tests/acceptance/start_project.test.ts', 'modules/projects/store.test.ts', 'src/workflow/chain.test.mjs',
      'tests/support/app-server.ts', 'tests/acceptance/support.ts', 'tests/support/machine/harness.mjs',
    ]);
    expect(elsewhere.map((e) => e.file)).toEqual(['modules/projects/store.ts']);
  });
});

describe('withCompileFailures', () => {
  const error = (line: number, file = 'a.test.ts') => ({ file, line, message: 'TS2339: x' });
  const tests = [
    outcome('things > first', 3, 5),
    outcome('things > second', 6, 8),
    outcome('things > case 1 > each', 10, 12),
    outcome('things > case 2 > each', 10, 12),
  ];
  const failedTitles = (result: TestOutcome[]) => result.filter((t) => t.failed).map((t) => t.title);

  it('fails only the test the error sits inside, and says why', () => {
    const result = withCompileFailures(tests, [error(4)], RUN);

    expect(failedTitles(result)).toEqual(['things > first']);
    expect(result[0]!.reason).toBe('does not compile');
  });

  it('fails every run of a block that runs once per case', () => {
    expect(failedTitles(withCompileFailures(tests, [error(11)], RUN))).toEqual([
      'things > case 1 > each', 'things > case 2 > each',
    ]);
  });

  it('fails the whole file for an error outside any test, such as a broken import', () => {
    expect(failedTitles(withCompileFailures(tests, [error(1)], RUN))).toHaveLength(4);
  });

  it('records one failure for a file with no outcomes, with the ids and scenarios its tests carry in the run', () => {
    const run: TestRun = {
      ...RUN,
      cases: [{ file: 'b.test.ts', name: 'x [AC0002.1]', status: 'passed', message: null, ids: ['AC0002'], scenarios: ['AC0002.1'], bare: [], inverted: false }],
      leftOut: [{ file: 'b.test.ts', ids: ['AC0003'], scenarios: ['AC0003.1'], bare: [] }],
    };
    const result = withCompileFailures([], [error(1, 'b.test.ts')], run);

    expect(result).toEqual([
      {
        file: 'b.test.ts', title: '(the whole file)', ids: ['AC0002', 'AC0003'], scenarios: ['AC0002.1', 'AC0003.1'],
        failed: true, reason: 'does not compile', wholeFile: true,
      },
    ]);
  });

  it('leaves tests alone when nothing in their file fails to compile', () => {
    expect(withCompileFailures(tests, [], RUN)).toEqual(tests);
  });

  it('keeps a runtime failure a failure, without a compile reason', () => {
    const runtime = [outcome('things > first', 3, 5, { failed: true }), outcome('things > second', 6, 8)];
    const result = withCompileFailures(runtime, [error(7)], RUN);

    expect(result.map((t) => [t.failed, t.reason])).toEqual([[true, undefined], [true, 'does not compile']]);
  });

  // A run with no line ranges, because no reporter gave them, still fails the
  // test: all of the file's, which errs toward failing too many rather than
  // too few.
  it('fails every test in the file when the run gives no line ranges', () => {
    const bare = tests.map(({ line, endLine, ...rest }) => rest);
    expect(failedTitles(withCompileFailures(bare, [error(4)], RUN))).toHaveLength(4);
  });

  // The edges of a test's lines count as inside it: the call's first line and
  // its closing line.
  it('fails the test when the error sits on its first or its last line', () => {
    expect(failedTitles(withCompileFailures(tests, [error(3)], RUN))).toEqual(['things > first']);
    expect(failedTitles(withCompileFailures(tests, [error(5)], RUN))).toEqual(['things > first']);
  });

  // Only this file's tests are places this file's error can sit.
  it('looks only at the tests of the file the error is in', () => {
    const elsewhere = { ...outcome('another', 4, 4), file: 'b.test.ts' };
    expect(failedTitles(withCompileFailures([...tests, elsewhere], [error(4)], RUN))).toEqual(['things > first']);
  });

  // When tests sit inside tests, the error belongs to the one closest around
  // it, whichever the run names first.
  it('fails the innermost test around the error', () => {
    const outcomes = [outcome('outer', 1, 10), outcome('inner', 3, 5)];
    expect(failedTitles(withCompileFailures(outcomes, [error(4)], RUN))).toEqual(['inner']);
    expect(failedTitles(withCompileFailures([...outcomes].reverse(), [error(4)], RUN))).toEqual(['inner']);
  });
});
