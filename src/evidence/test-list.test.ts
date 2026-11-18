import { describe, expect, it } from 'vitest';
import { changedLinesOf, countTests, testListOf, type Change } from './test-list.js';
import type { TestCase } from './test-run.js';

const testCase = (file: string, name: string, line?: number, endLine?: number): TestCase => ({
  file, name, status: 'passed', message: null, ids: [], scenarios: [], bare: [], inverted: false,
  ...(line === undefined ? {} : { line, endLine }),
});

describe('a test\'s identity in the list', () => {
  it('keeps full titles distinct by both name and file, including punctuation', () => {
    const cases = [testCase('a', 'b::c'), testCase('a::b', 'c'), testCase('b', 'b::c'), testCase('a', 'A')];
    const expected = [
      { file: 'a', titles: ['A', 'b::c'] }, { file: 'a::b', titles: ['c'] }, { file: 'b', titles: ['b::c'] },
    ];
    expect(testListOf({ cases, leftOut: [] }).tests).toEqual(expected);
    expect(testListOf({ cases: cases.reverse(), leftOut: [] }).tests).toEqual(expected);
    expect(countTests({ tests: expected, unlisted: [] }, { cases: cases.slice(1) }, new Map(), () => true))
      .toEqual({ added: 0, modified: 0, removed: 1 });
  });

  it('lists every reported test once, sorted, and the files the run left out', () => {
    const list = testListOf({
      cases: [testCase('b.test.ts', 'two'), testCase('a.test.ts', 'one'), testCase('a.test.ts', 'one')],
      leftOut: [{ file: 'z.test.ts', ids: [], scenarios: [], bare: [] }, { file: 'y.test.ts', ids: [], scenarios: [], bare: [] }],
    });
    expect(list.tests).toEqual([{ file: 'a.test.ts', titles: ['one'] }, { file: 'b.test.ts', titles: ['two'] }]);
    expect(list.unlisted).toEqual(['y.test.ts', 'z.test.ts']);
  });
});

describe('the lines a diff changed', () => {
  const diff = [
    'diff --git a/a.test.ts b/a.test.ts',
    '--- a/a.test.ts',
    '+++ b/a.test.ts',
    '@@ -3 +3 @@',
    '@@ -10,2 +10,0 @@',
    '@@ -20,0 +19,3 @@',
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    'diff --git a/gone.test.ts b/gone.test.ts',
    '--- a/gone.test.ts',
    '+++ /dev/null',
    '@@ -1,4 +0,0 @@',
  ].join('\n');

  it('reads a hunk of more than nine lines, and ignores a changed line that only looks like a hunk header', () => {
    const changes = changedLinesOf([
      '+++ b/a.test.ts',
      '@@ -20,0 +19,12 @@',
      "+  '@@ -3 +3 @@',",
    ].join('\n'), () => true);
    expect(changes.get('a.test.ts')).toEqual([{ from: 19, to: 30 }]);
  });

  it('reads nothing for a file the diff deletes, whatever is kept', () => {
    const changes = changedLinesOf(['--- a/gone.test.ts', '+++ /dev/null', '@@ -1,4 +0,0 @@'].join('\n'), () => true);
    expect([...changes.keys()]).toEqual([]);
  });

  // `touchedTargets` drops a hunk that only deleted lines. A deletion inside a
  // test still modifies it, so it is kept as the line it follows.
  it('keeps new lines as ranges and a deletion as the line it follows, for the files kept', () => {
    const changes = changedLinesOf(diff, (file) => file.endsWith('.test.ts'));
    expect([...changes.keys()]).toEqual(['a.test.ts']);
    expect(changes.get('a.test.ts')).toEqual([{ from: 3, to: 3 }, { after: 10 }, { from: 19, to: 21 }]);
  });
});

describe('tests added, modified and removed', () => {
  const list = (...cases: TestCase[]) => testListOf({ cases, leftOut: [] });
  const changed = (entries: Record<string, Change[]> = {}) => new Map(Object.entries(entries));
  const nothingAtBaseline = () => false;

  it('counts a test in the run and not in the list as added, and one in the list and not in the run as removed', () => {
    const before = list(testCase('a.test.ts', 'kept', 1, 3), testCase('a.test.ts', 'gone', 5, 7));
    const after = { cases: [testCase('a.test.ts', 'kept', 1, 3), testCase('a.test.ts', 'new', 5, 7), testCase('b.test.ts', 'new', 1, 2)] };
    expect(countTests(before, after, changed(), nothingAtBaseline)).toEqual({ added: 2, modified: 0, removed: 1 });
  });

  it('counts a test as modified when a line it spans changed, and not when the change is outside it', () => {
    const before = list(testCase('a.test.ts', 'one', 1, 3), testCase('a.test.ts', 'two', 5, 7), testCase('a.test.ts', 'three', 9, 11));
    const after = { cases: [testCase('a.test.ts', 'one', 1, 3), testCase('a.test.ts', 'two', 5, 7), testCase('a.test.ts', 'three', 9, 11)] };
    expect(countTests(before, after, changed({ 'a.test.ts': [{ from: 2, to: 2 }, { from: 8, to: 8 }] }), nothingAtBaseline))
      .toEqual({ added: 0, modified: 1, removed: 0 });
    // A range that reaches into a test from either side modifies it.
    expect(countTests(before, after, changed({ 'a.test.ts': [{ from: 4, to: 5 }, { from: 11, to: 14 }] }), nothingAtBaseline))
      .toEqual({ added: 0, modified: 2, removed: 0 });
  });

  it('counts a deletion inside a test as modifying it, and one just before or after it as not', () => {
    const before = list(testCase('a.test.ts', 'one', 5, 7));
    const after = { cases: [testCase('a.test.ts', 'one', 5, 7)] };
    const count = (after_: number) => countTests(before, after, changed({ 'a.test.ts': [{ after: after_ }] }), nothingAtBaseline).modified;
    expect([count(4), count(5), count(6), count(7)]).toEqual([0, 1, 1, 0]);
  });

  it('counts a test the reporter gave no lines for as unmodified', () => {
    const before = list(testCase('a.test.ts', 'one'));
    expect(countTests(before, { cases: [testCase('a.test.ts', 'one')] }, changed({ 'a.test.ts': [{ from: 1, to: 99 }] }), nothingAtBaseline))
      .toEqual({ added: 0, modified: 0, removed: 0 });
  });

  it('counts a renamed test as one removed and one added', () => {
    expect(countTests(list(testCase('a.test.ts', 'old name', 1, 3)), { cases: [testCase('a.test.ts', 'new name', 1, 3)] }, changed(), nothingAtBaseline))
      .toEqual({ added: 1, modified: 0, removed: 1 });
  });

  // The triage's run left the file out, so its tests are not in the list.
  // They are new only if the file is.
  it('counts a test in a file the triage could not list as added only when the file is new', () => {
    const before = { tests: [], unlisted: ['old.test.ts', 'new.test.ts'] };
    const after = { cases: [testCase('old.test.ts', 'one', 1, 3), testCase('old.test.ts', 'two', 5, 7), testCase('new.test.ts', 'one', 1, 3)] };
    const existed = (file: string) => file === 'old.test.ts';
    expect(countTests(before, after, changed({ 'old.test.ts': [{ from: 6, to: 6 }] }), existed))
      .toEqual({ added: 1, modified: 1, removed: 0 });
  });

  it('counts a test reported twice once', () => {
    const after = { cases: [testCase('a.test.ts', 'one', 1, 3), testCase('a.test.ts', 'one', 1, 3)] };
    expect(countTests(list(), after, changed(), nothingAtBaseline)).toEqual({ added: 1, modified: 0, removed: 0 });
  });
});
