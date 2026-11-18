import { describe, expect, it, vi } from 'vitest';
import { allFailures, assess, render, renderLines, totalFailures, type RiskInput, type RiskReport, type TestOutcome } from './risk.js';

const outcome = (file: string, failed: boolean, ...ids: string[]): TestOutcome =>
  ({ file, title: ids.join(' '), ids, failed });

/** n tests in one file, the first `failing` of them red. */
const many = (file: string, count: number, failing: number, ...ids: string[]): TestOutcome[] =>
  Array.from({ length: count }, (_, i) => ({ ...outcome(file, i < failing, ...ids), title: `test ${i}` }));

/** What raised the level. Nothing at LOW. */
const causes = (report: RiskReport) => report.reasons;

/** The outcome of a test file the report left out. */
const whole = (file: string): TestOutcome =>
  ({ file, title: '(the whole file)', ids: [], failed: true, wholeFile: true, didNotRun: true, reason: 'left out' });

const run = (over: Partial<RiskInput>) =>
  assess({
    predictions: [],
    tests: [],
    ...over,
  });

describe('risk: bucketing', () => {
  it('puts a failure the plan predicted among the predicted, and one it did not among the surprises', () => {
    const report = run({
      predictions: ['a.test.ts'],
      tests: [outcome('a.test.ts', true, 'AC0001'), outcome('far.test.ts', true)],
    });
    expect(report.predicted).toEqual({ failed: 1, total: 1, failures: ['a.test.ts — AC0001'], names: ['a.test.ts — AC0001'] });
    expect(report.surprise).toEqual({ failed: 1, total: 1, failures: ['far.test.ts — '], names: ['far.test.ts — '] });
  });

  // A contract change shows up as tests that no longer compile. The operator
  // should see that, and not only that a test went red.
  it('names the reason beside a failure that is not a runtime one', () => {
    const report = run({ tests: [{ ...outcome('a.test.ts', true), title: 'x', reason: 'does not compile' }] });
    expect(report.surprise.failures).toEqual(['a.test.ts — x (does not compile)']);
  });

  // A failure message can run to many lines. The triage report lists the
  // names, so they hold the file and the title and nothing else.
  it('names each failing test by file and title alone, without its failure message', () => {
    const report = run({ predictions: ['a.test.ts'], tests: [
      { ...outcome('a.test.ts', true), title: 'p', reason: 'expected 1\nto be 2' },
      { ...outcome('b.test.ts', true), title: 's', reason: 'boom' },
    ] });
    expect(report.predicted.names).toEqual(['a.test.ts — p']);
    expect(report.surprise.names).toEqual(['b.test.ts — s']);
    expect(report.surprise.failures).toEqual(['b.test.ts — s (boom)']);
  });

  it('counts a predicted test that passed as over-predicted, out of every test predicted', () => {
    const report = run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 4, 3) });
    expect(report.overPredicted).toEqual({ count: 1, total: 4, tests: ['a.test.ts — test 3'] });
  });
});

describe('risk: HIGH', () => {
  it('is HIGH when an invariant test is red, however small the share', () => {
    const report = run({
      predictions: ['a.test.ts'],
      tests: [outcome('a.test.ts', true, 'INV0001')],
    });
    expect(report.level).toBe('HIGH');
    expect(causes(report)[0]!.text).toBe('Raised to HIGH by failing invariants, named below.');
  });

  // Only an INV id makes a failure an invariant. An AC id, predicted or not,
  // raises nothing on that account.
  it('names no invariant for a failing test tagged with an acceptance criterion', () => {
    const report = run({
      predictions: ['a.test.ts'],
      tests: [outcome('a.test.ts', true, 'AC0001.1')],
    });
    expect(report.invariants).toEqual([]);
    expect(causes(report).map(reason => reason.text)).not.toContain('Raised to HIGH by failing invariants, named below.');
    expect(report.level).toBe('LOW');
  });

  // A file that never loaded hides every test in it, surprises included.
  it('is HIGH when a test file the plan did not predict never ran, and names it once', () => {
    const report = run({ tests: [whole('a.test.ts'), ...many('b.test.ts', 100, 0)] });
    expect(report.level).toBe('HIGH');
    expect(report.notRun).toEqual({ predicted: [], unpredicted: ['a.test.ts'] });
    expect(report.surprise).toEqual({ failed: 1, total: 101, failures: [], names: [] });
    expect(causes(report)).toContainEqual({
      text: 'Raised to HIGH by test files the plan did not predict that never ran, named below among the surprises: nothing in them was classified.',
    });
  });

  it('names a file that never ran once, however many outcomes stand for it', () => {
    expect(run({ tests: [whole('a.test.ts'), whole('a.test.ts')] }).notRun.unpredicted).toEqual(['a.test.ts']);
  });

  // The plan saw it coming, which the operator decided on 2026-11-01 is
  // enough. It is still counted and named.
  it('raises nothing for a test file the plan predicted that never ran, and names it once', () => {
    const report = run({ predictions: ['a.test.ts'], tests: [whole('a.test.ts'), ...many('b.test.ts', 100, 0)] });
    expect(report.level).toBe('LOW');
    expect(report.overPredicted.count).toBe(0);
    expect(report.notRun).toEqual({ predicted: ['a.test.ts'], unpredicted: [] });
    expect(report.predicted).toEqual({ failed: 1, total: 1, failures: [], names: [] });
  });

  // 20 predicted, 4 surprises: the plan missed a fifth of what it should have
  // seen. Measured against the plan, not the suite, so a growing suite does
  // not make a missed effect cheaper.
  it('is HIGH at 20% surprises of the predicted tests, and not below', () => {
    const predicted = many('a.test.ts', 20, 20);
    const at = run({ predictions: ['a.test.ts'], tests: [...predicted, ...many('far.test.ts', 1000, 4)] });
    expect(at.level).toBe('HIGH');
    expect(causes(at)[0]!.text).toBe('Raised to HIGH by surprise failures: 4 against 20 predicted, 20% or more.');
    expect(run({ predictions: ['a.test.ts'], tests: [...predicted, ...many('far.test.ts', 1000, 3)] }).level).toBe('MEDIUM');
  });

  it('is HIGH at 20% over-predictions of the predicted tests, and not below', () => {
    const at = run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 20, 16) });
    expect(at.level).toBe('HIGH');
    expect(causes(at)[0]!.text).toBe('Raised to HIGH by over-predictions: 4 of 20 predicted failures passed, 20% or more.');
    expect(run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 20, 17) }).level).toBe('MEDIUM');
  });

  it('is HIGH for any surprise when the plan predicted nothing', () => {
    expect(run({ tests: [outcome('far.test.ts', true), ...many('b.test.ts', 1000, 0)] }).level).toBe('HIGH');
  });

  // Padding: a plan that lists every test file to hide its surprises.
  it('is HIGH for a plan that lists tests that never fail', () => {
    const report = run({
      predictions: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      tests: [...many('a.test.ts', 5, 5), ...many('b.test.ts', 5, 0), ...many('c.test.ts', 5, 0)],
    });
    expect(report.level).toBe('HIGH');
    expect(report.overPredicted.count).toBe(10);
  });
});

describe('risk: MEDIUM', () => {
  it('is MEDIUM for one surprise below a fifth of the predicted tests', () => {
    const report = run({ predictions: ['a.test.ts'], tests: [...many('a.test.ts', 10, 10), outcome('far.test.ts', true)] });
    expect(report.level).toBe('MEDIUM');
    expect(causes(report)).toEqual([{ text: 'Raised to MEDIUM by a surprise failure.' }]);
  });

  it('is MEDIUM for one over-prediction below a fifth of the predicted tests', () => {
    const report = run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 10, 9) });
    expect(report.level).toBe('MEDIUM');
    expect(causes(report)).toEqual([{ text: 'Raised to MEDIUM by an over-prediction: a test the plan said would fail passed.' }]);
  });

  // A misspelt path predicts nothing, which would otherwise pass in silence.
  it('counts an entry that matches no test as an over-prediction', () => {
    const report = run({ predictions: ['a.test.ts', 'tpyo.test.ts'], tests: many('a.test.ts', 10, 10) });
    expect(report.overPredicted.tests).toEqual(['tpyo.test.ts — matched no test']);
    expect(report.overPredicted.total).toBe(11);
    expect(report.level).toBe('MEDIUM');
  });
});

describe('risk: LOW', () => {
  it('is LOW when every predicted test failed and nothing else did', () => {
    const report = run({
      predictions: ['AC0001.1'],
      tests: [...many('a.test.ts', 5, 5).map((t) => ({ ...t, scenarios: ['AC0001.1'] })), ...many('b.test.ts', 100, 0)],
    });
    expect(report.level).toBe('LOW');
    expect(report.predicted.failed).toBe(5);
  });

  it('is LOW on a wholly green suite with nothing predicted', () => {
    expect(run({ tests: many('a.test.ts', 10, 0) }).level).toBe('LOW');
  });

  it('does not divide by zero on an empty suite', () => {
    expect(run({}).level).toBe('LOW');
  });
});

describe('reasons', () => {
  it('names the failing invariant tests', () => {
    const report = run({
      predictions: ['a.test.ts'],
      tests: [
        { file: 'a.test.ts', title: 'holds [INV0001]', ids: ['INV0001'], failed: true },
        { file: 'a.test.ts', title: 'also holds [INV0002]', ids: ['INV0002'], failed: false },
        { file: 'b.test.ts', title: 'breaks', ids: [], failed: true },
      ],
    });
    expect(report.invariants).toEqual(['a.test.ts — holds [INV0001]']);
    expect(causes(report)[0]).toEqual({ text: 'Raised to HIGH by failing invariants, named below.' });
  });

  it('names no invariant when none failed', () => {
    expect(run({ tests: [outcome('a.test.ts', false, 'INV0001')] }).invariants).toEqual([]);
  });

  // Two signals only: missed predictions and test regressions. With neither
  // there is nothing to say why, and the count line says the rest.
  it('gives no reason at LOW', () => {
    expect(run({ predictions: ['a.test.ts'], tests: [...many('a.test.ts', 2, 2), ...many('o.test.ts', 698, 0)] }).reasons).toEqual([]);
  });

  it('starts every cause with the level it raises the report to', () => {
    const reports = [
      run({ tests: [outcome('a.test.ts', true, 'INV0001')] }),
      run({ tests: [whole('a.test.ts')] }),
      run({ tests: [outcome('o.test.ts', true)] }),
      run({ predictions: ['a.test.ts'], tests: [...many('a.test.ts', 10, 10), outcome('o.test.ts', true)] }),
      run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 10, 9) }),
      run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 10, 1) }),
    ];
    for (const report of reports) {
      expect(causes(report).length).toBeGreaterThan(0);
      for (const cause of causes(report)) expect(cause.text.startsWith(`Raised to ${report.level} by `)).toBe(true);
    }
  });
});

/**
 * The triage refuses a test-only change on a red suite, and this is what it
 * asks. A caller summing the buckets by hand would go on summing two after a
 * third existed.
 */
describe('failures across the whole report', () => {
  const spread = () => run({
    predictions: ['p.test.ts'],
    tests: [
      outcome('p.test.ts', true, 'AC0001'),
      outcome('o.test.ts', true),
      outcome('o.test.ts', false),
    ],
  });

  it('counts one failure per failing test, whichever bucket it landed in', () => {
    expect(totalFailures(spread())).toBe(2);
  });

  it('is zero on a green suite that ran tests', () => {
    const report = run({ tests: [outcome('a.test.ts', false)] });
    expect(totalFailures(report)).toBe(0);
    expect(allFailures(report)).toEqual([]);
  });

  it('names every failure, so a refusal can say which tests it means', () => {
    expect(allFailures(spread())).toEqual(['p.test.ts — AC0001', 'o.test.ts — ']);
  });

  it('names a file that never ran, which no bucket names', () => {
    const report = run({ tests: [whole('a.test.ts')] });
    expect(totalFailures(report)).toBe(1);
    expect(allFailures(report)).toEqual(['a.test.ts — never ran: it failed to load, or the run never reached it']);
  });
});

describe('what the report could not look at', () => {
  it('is said as given, and nothing when there is nothing', () => {
    const unchecked = ['not checked: compile'];
    expect(run({ unchecked }).unchecked).toEqual(unchecked);
    expect(run({}).unchecked).toEqual([]);
  });
});

/** The report as `req risk` prints it: the triage's layout, with no event
 *  link and no notes for the agent. */
describe('the report, printed', () => {
  const TITLE = "Triage of plan's missed predictions and test regressions.";

  // The whole printout, blank lines included, for a report with every part.
  it('prints every part in order, each set off by a blank line', () => {
    const report = run({
      predictions: ['a.test.ts', 'p.test.ts'],
      tests: [...many('a.test.ts', 4, 3), outcome('far.test.ts', true), outcome('i.test.ts', true, 'INV0001'),
        whole('p.test.ts'), whole('u.test.ts')],
      unchecked: ['not checked: compile'],
    });
    expect(renderLines(report)).toEqual([
      TITLE,
      '',
      'Risk: HIGH',
      'Raised to HIGH by failing invariants, named below.',
      'Raised to HIGH by test files the plan did not predict that never ran, named below among the surprises: nothing in them was classified.',
      'Raised to HIGH by surprise failures: 3 against 5 predicted, 20% or more.',
      'Raised to HIGH by over-predictions: 1 of 5 predicted failures passed, 20% or more.',
      '8 tests ran, 7 failed',
      'predicted 4/5 failed · 3 surprises (60%) · 1 over-prediction (20%)',
      '',
      'not checked: compile',
      '',
      'Surprises:',
      'u.test.ts — never ran',
      'far.test.ts — ',
      'i.test.ts — INV0001',
      '',
      'Over-predictions:',
      'a.test.ts — test 3',
      '',
      'Failing invariants:',
      'i.test.ts — INV0001',
      '',
      'Predicted files that never ran:',
      'p.test.ts',
    ]);
  });

  it('prints only the title, the level and the counts when the plan missed nothing', () => {
    expect(renderLines(run({ tests: many('a.test.ts', 2, 0) }))).toEqual([
      TITLE, '', 'Risk: LOW', '2 tests ran, 0 failed', 'predicted 0/0 failed · 0 surprises (0%) · 0 over-predictions (0%)',
    ]);
  });

  // There is no event to hold the rest, so nothing is cut.
  it('names every test, however many there are', () => {
    const lines = renderLines(run({ tests: many('far.test.ts', 12, 12) }));
    for (let i = 0; i < 12; i++) expect(lines).toContain(`far.test.ts — test ${i}`);
    expect(lines.join('\n')).not.toContain('Output trimmed');
  });

  it('prints no event link and no notes for the agent', () => {
    const text = renderLines(run({ tests: [outcome('far.test.ts', true)] })).join('\n');
    expect(text).not.toContain('Details:');
    expect(text).not.toContain('No logbook event');
    expect(text).not.toContain('For the agent');
  });

  // The plan named them already. Listing 55 of them, each with its assertion
  // message, buried the surprises.
  it('counts the predicted failures and does not name them', () => {
    const text = renderLines(run({ predictions: ['a.test.ts'], tests: many('a.test.ts', 3, 3) })).join('\n');
    expect(text).not.toContain('a.test.ts — test 0');
    expect(text).toContain('predicted 3/3 failed');
  });

  it('names each file that never ran once, in the list for whether the plan predicted it', () => {
    const lines = renderLines(run({ predictions: ['p.test.ts'], tests: [whole('p.test.ts'), whole('u.test.ts')] }));
    expect(lines.slice(lines.indexOf('Surprises:'), lines.indexOf('Surprises:') + 2)).toEqual(['Surprises:', 'u.test.ts — never ran']);
    expect(lines.slice(-2)).toEqual(['Predicted files that never ran:', 'p.test.ts']);
    expect(lines.filter((line) => line.includes('p.test.ts'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('u.test.ts'))).toHaveLength(1);
  });

  it('gives no share of a prediction that is empty, rather than dividing by zero', () => {
    expect(renderLines(run({ tests: [outcome('far.test.ts', true)] }))).toContain(
      'predicted 0/0 failed · 1 surprise (0%) · 0 over-predictions (0%)',
    );
  });

  it('prints the same lines it gives', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = run({ tests: [outcome('far.test.ts', true)] });
      render(report);
      expect(log.mock.calls.map(([text]) => String(text))).toEqual([renderLines(report).join('\n')]);
    } finally {
      log.mockRestore();
    }
  });
});
