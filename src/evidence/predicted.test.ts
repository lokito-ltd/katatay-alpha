import { describe, expect, it } from 'vitest';
import { applyPrediction, names, type Predictable } from './predicted.js';
import { parsePrediction } from '../workflow/plan.mjs';
import { TEST_RUN } from './test-run.js';

const test = (file: string, title: string, failed = true, scenarios: string[] = []): Predictable =>
  ({ file, title, failed, scenarios });

const wholeFile = (file: string, scenarios: string[] = []): Predictable =>
  ({ file, title: '(the whole file)', failed: true, scenarios, wholeFile: true });

/** An entry as the approval reads it. These cases all hold good entries. */
const entry = (text: string) => {
  const read = parsePrediction(text);
  if ('problem' in read) throw new Error(read.problem);
  return read;
};

describe('reading an entry', () => {
  it('splits a test at the first ::, so a name may hold more', () => {
    expect(entry('a.test.ts::refuses x')).toEqual({ kind: 'test', file: 'a.test.ts', name: 'refuses x', text: 'a.test.ts::refuses x' });
    expect(entry('src/lib.rs::tests::adds')).toMatchObject({ file: 'src/lib.rs', name: 'tests::adds' });
  });

  it('reads a scenario id, and a path with its leading ./ dropped', () => {
    expect(entry('AC0004.1')).toEqual({ kind: 'scenario', id: 'AC0004.1', text: 'AC0004.1' });
    expect(entry('./tools/a.test.ts')).toEqual({ kind: 'file', file: 'tools/a.test.ts', text: 'tools/a.test.ts' });
  });
});

describe('which tests an entry names', () => {
  it('names every test tagged with a scenario, and no other', () => {
    expect(names(entry('AC0004.1'), test('a.test.ts', 'x', true, ['AC0004.1']))).toBe(true);
    expect(names(entry('AC0004.1'), test('a.test.ts', 'x', true, ['AC0004.2']))).toBe(false);
  });

  it('names every test in a file, and none in another', () => {
    expect(names(entry('a.test.ts'), test('a.test.ts', 'x'))).toBe(true);
    expect(names(entry('a.test.ts'), test('b.test.ts', 'x'))).toBe(false);
  });

  // As a scenario's text is compared: by words, with group names allowed to
  // fall away, and never the leading words of the title itself.
  it('names one test by its name, with its group names in front or without them', () => {
    const one = test('a.test.ts', 'the adapter > refuses a missing key');
    expect(names(entry('a.test.ts::refuses a missing key'), one)).toBe(true);
    expect(names(entry('a.test.ts::the adapter > refuses a missing key'), one)).toBe(true);
    expect(names(entry('a.test.ts::Refuses a missing key.'), one)).toBe(true);
    expect(names(entry('a.test.ts::a missing key'), one)).toBe(false);
    expect(names(entry('b.test.ts::refuses a missing key'), one)).toBe(false);
  });

  // Any of its tests could be the one the plan meant, and none ran to say
  // otherwise.
  it('names a whole-file failure by its file, by a test in it, and by a scenario its text holds', () => {
    const file = wholeFile('a.test.ts', ['AC0004.1']);
    expect(names(entry('a.test.ts'), file)).toBe(true);
    expect(names(entry('a.test.ts::anything at all'), file)).toBe(true);
    expect(names(entry('AC0004.1'), file)).toBe(true);
    expect(names(entry('b.test.ts::anything at all'), file)).toBe(false);
  });

  it('never names a run that failed outside any test', () => {
    const outside = test(TEST_RUN, 'the test command failed outside any test');
    expect(names(entry(TEST_RUN), outside)).toBe(false);
  });
});

describe('a prediction, applied to a run', () => {
  it('counts every named test once, however many entries name it', () => {
    const run = [test('a.test.ts', 'x', true, ['AC0001.1']), test('a.test.ts', 'y', true)];
    const prediction = applyPrediction(['a.test.ts', 'AC0001.1'], run);
    expect(prediction.count).toBe(2);
    expect(run.map(prediction.isPredicted)).toEqual([true, true]);
    expect(prediction.overPredicted).toEqual([]);
  });

  it('names each predicted test that passed, then each entry that named no test', () => {
    const run = [test('a.test.ts', 'x', true), test('a.test.ts', 'y', false), test('b.test.ts', 'z', true)];
    const prediction = applyPrediction(['a.test.ts', 'tpyo.test.ts'], run);
    expect(prediction.overPredicted).toEqual(['a.test.ts — y', 'tpyo.test.ts — matched no test']);
    expect(prediction.count).toBe(3);
    expect(prediction.isPredicted(run[2]!)).toBe(false);
  });

  // The approval checks every entry, so one it could not read was not written
  // by it. Said, rather than dropped.
  it('counts an entry it cannot read as matching no test', () => {
    expect(applyPrediction(['AC0004'], [test('a.test.ts', 'x')]).overPredicted).toEqual(['AC0004 — matched no test']);
  });

  it('predicts nothing from an empty list', () => {
    const prediction = applyPrediction([], [test('a.test.ts', 'x')]);
    expect([prediction.count, prediction.overPredicted]).toEqual([0, []]);
  });
});
