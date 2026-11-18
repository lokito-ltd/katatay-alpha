import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisPath, triageAnalysis } from '../../tests/fixtures/workflow/events.mjs';
import { CUT, LINES, NO_EVENT } from './compact-report.mjs';
import { publishSnapshot } from './local-snapshot.mjs';
import { writeTriageSnapshot } from './triage-snapshot.mjs';
import { FOR_AGENT, FROZEN, NAMED, agentNotes, keepAll, namedLists, refusalSummary, triageReport } from './triage-summary.mjs';

const branch = 'topic';
const DIR = `.katatay/state/${branch}`;
const LINK = `Details: ${DIR}/0004__triaged.json`;
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'triage-report-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * A `triaged` event and its snapshot, as the triage command records them.
 * Surprises are named `file — title`; their failures carry a message over
 * two lines, which the report must leave out.
 */
function recorded({ surprises = [], over = [], neverRan = [], predictedNeverRan = [], invariants = [], predicted = { failed: 0, total: 10 },
  surpriseTotal = surprises.length + neverRan.length, ...payload } = {}) {
  const identities = { tests: [{ file: 'all.test.mjs', titles: ['t'] }], unlisted: [...neverRan, ...predictedNeverRan].sort() };
  const report = {
    predicted: { ...predicted, failures: [], names: [] },
    surprise: { failed: surprises.length + neverRan.length, total: surpriseTotal,
      failures: surprises.map(name => `${name} (expected 1\nto be 2)`), names: surprises },
    overPredicted: { count: over.length, total: predicted.failed + over.length, tests: over },
    notRun: { predicted: predictedNeverRan, unpredicted: neverRan },
    invariants,
  };
  const snapshot = writeTriageSnapshot(branch, identities, report, root);
  return { seq: 4, event: 'triaged', payload: { level: 'LOW', reasons: [], implemented: true, ...snapshot, ...payload } };
}
const report = (event, testOnly = false) => triageReport(event, { branch, dir: DIR, root, testOnly });
const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}/case-${i}.test.mjs — group > case ${i}`);

describe('the triage report', () => {
  // The one test of the whole layout. The others check what is in it.
  it('lays out the busiest triage: title, risk and counts, limitations, then each named list and the link', () => {
    const event = recorded({
      level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 12 against 23 predicted, 20% or more.'], implemented: false,
      predicted: { failed: 16, total: 3741 }, surpriseTotal: 20,
      surprises: names('tests/machine', 10), neverRan: ['tests/hooks/journey.test.mjs', 'src/workflow/phase.test.mjs'],
      over: names('src/workflow', 7),
      unchecked: ['not checked: compile (the adapter says "none")', 'not checked: inverted tests (no reporter)'],
    });
    expect(report(event)).toBe([
      "Triage of plan's missed predictions and test regressions, on a tree with no implementation in it.",
      "The counts below are the suite's, not this change's.",
      '',
      'Risk: HIGH',
      'Raised to HIGH by surprise failures: 12 against 23 predicted, 20% or more.',
      '3761 tests ran, 28 failed',
      'predicted 16/23 failed · 12 surprises (52%) · 7 over-predictions (30%)',
      '',
      'not checked: compile (the adapter says "none")',
      'not checked: inverted tests (no reporter)',
      '',
      'Surprises:',
      'tests/hooks/journey.test.mjs — never ran',
      'src/workflow/phase.test.mjs — never ran',
      'tests/machine/case-0.test.mjs — group > case 0',
      'tests/machine/case-1.test.mjs — group > case 1',
      'tests/machine/case-2.test.mjs — group > case 2',
      '[…] Output trimmed. All 12 surprises are in the details file.',
      '',
      'Over-predictions:',
      'src/workflow/case-0.test.mjs — group > case 0',
      'src/workflow/case-1.test.mjs — group > case 1',
      'src/workflow/case-2.test.mjs — group > case 2',
      'src/workflow/case-3.test.mjs — group > case 3',
      'src/workflow/case-4.test.mjs — group > case 4',
      '[…] Output trimmed. All 7 over-predictions are in the details file.',
      '',
      LINK,
    ].join('\n'));
  });

  it('gives a clean triage its title, risk, counts and link', () => {
    const text = report(recorded());
    expect(text.split('\n')[0]).toBe("Triage of plan's missed predictions and test regressions.");
    expect(text).toContain('Risk: LOW\n10 tests ran, 0 failed\npredicted 0/0 failed · 0 surprises (0%) · 0 over-predictions (0%)');
    expect(text).not.toContain('Surprises:');
    expect(text).not.toContain('Over-predictions:');
    expect(text.split('\n').at(-1)).toBe(LINK);
  });

  it(`names the first ${NAMED} of each list, and counts them all in the trim line`, () => {
    const text = report(recorded({ surprises: names('s', 9), over: names('o', 6) }));
    for (const name of names('s', NAMED)) expect(text).toContain(`\n${name}\n`);
    expect(text).not.toContain(names('s', 9)[NAMED]);
    expect(text).toContain('[…] Output trimmed. All 9 surprises are in the details file.');
    expect(text).not.toContain(names('o', 6)[NAMED]);
    expect(text).toContain('[…] Output trimmed. All 6 over-predictions are in the details file.');
  });

  it(`needs no trim line for exactly ${NAMED}`, () => {
    const text = report(recorded({ surprises: names('s', NAMED), over: names('o', NAMED) }));
    for (const name of [...names('s', NAMED), ...names('o', NAMED)]) expect(text).toContain(name);
    expect(text).not.toContain('Output trimmed');
  });

  it('lists the files that never ran first among the surprises, and the limit cannot push them out', () => {
    const text = report(recorded({ surprises: names('s', 8), neverRan: ['a.test.mjs', 'b.test.mjs'] }));
    expect(text).toContain('Surprises:\na.test.mjs — never ran\nb.test.mjs — never ran\ns/case-0.test.mjs');
    expect(text).toContain('All 10 surprises');
  });

  it('gives no block at all when every list is empty', () => {
    expect(namedLists({ surprises: [], overPredictions: [], invariants: [], predictedNotRun: [] })).toEqual([]);
  });

  it('gives one list exactly its own block', () => {
    expect(namedLists({ surprises: [], overPredictions: [], invariants: ['i.test.mjs — holds'], predictedNotRun: [] }, keepAll))
      .toEqual([{ lines: ['Failing invariants:', 'i.test.mjs — holds'] }]);
  });

  it('leaves out a list with nothing in it', () => {
    const text = report(recorded({ over: names('o', 1) }));
    expect(text).not.toContain('Surprises:');
    expect(text).toContain(`Over-predictions:\n${names('o', 1)[0]}\n\n${LINK}`);
  });

  it('names a test by file and title, without its failure message', () => {
    const text = report(recorded({ surprises: ['a.test.mjs — breaks'] }));
    expect(text).toContain('\na.test.mjs — breaks\n');
    expect(text).not.toContain('expected 1');
  });

  it('joins a name holding a line break into one row', () => {
    const text = report(recorded({ over: ['a.test.mjs — first line\n   second line'] }));
    expect(text).toContain('\na.test.mjs — first line second line\n');
  });

  it('says a test-only triage ran on the tree as the plan said, and that the counts are the suite\'s', () => {
    const text = report(recorded({ implemented: false }), true);
    expect(text).toMatch(/^Triage of plan's missed predictions and test regressions, on a tree with no implementation in it, as the plan said\.\nThe counts below are the suite's, not this change's\.\n/);
  });

  it.each([false, true])('uses the approval flag %s when a historical triage carries the opposite flag', testOnly => {
    const event = recorded({ implemented: false, testOnly: !testOnly });
    expect(report(event, testOnly).includes('as the plan said')).toBe(testOnly);
    expect(agentNotes(event.payload, testOnly).includes('the suite is green, so write the tests')).toBe(testOnly);
  });

  it('keeps the limitations that change what the counts mean', () => {
    const unchecked = ['not checked: compile (the adapter says "none" in .katatay/rulebook.json): a test that runs green while it would not compile counts as passing'];
    expect(report(recorded({ unchecked }))).toContain(`\n\n${unchecked[0]}\n\n`);
  });

  it('keeps the counts and says why the tests cannot be named when the snapshot cannot be read', () => {
    const event = recorded({ surprises: names('s', 2), over: names('o', 1) });
    rmSync(join(root, analysisPath(event.payload)));
    const text = report(event);
    expect(text).toContain('Risk: LOW\n12 tests ran, 2 failed');
    expect(text).toContain(`\nThe tests cannot be named: triage 4 ${analysisPath(event.payload)}: `);
    expect(text).not.toContain('s/case-0');
    expect(text.split('\n').at(-1)).toBe(LINK);
  });

  it('says the tests cannot be named from a snapshot written before it held their names', () => {
    const event = recorded({ surprises: names('s', 1) });
    const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
    delete data.details.surpriseNames;
    const triageFile = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
    const text = report({ ...event, payload: { ...event.payload, evidence: [triageAnalysis(triageFile)] } });
    expect(text).toContain(`The tests cannot be named: ${triageFile} holds no surprise names, because an earlier version wrote it.`);
  });

  it('names the failing invariants and the predicted files that never ran, after the surprises and over-predictions', () => {
    const text = report(recorded({
      level: 'HIGH', reasons: ['Raised to HIGH by failing invariants, named below.'], predicted: { failed: 2, total: 2 },
      surprises: ['s.test.mjs — breaks'], over: ['o.test.mjs — passes'],
      invariants: ['i.test.mjs — holds [INV0001]'], predictedNeverRan: ['p.test.mjs'],
    }));
    expect(text).toContain([
      'Surprises:', 's.test.mjs — breaks', '',
      'Over-predictions:', 'o.test.mjs — passes', '',
      'Failing invariants:', 'i.test.mjs — holds [INV0001]', '',
      'Predicted files that never ran:', 'p.test.mjs', '',
      LINK,
    ].join('\n'));
  });

  // A predicted failing invariant raises HIGH with no surprise, so no count
  // in the event says there is anything to name.
  it('reads the names for a HIGH level with nothing else counted', () => {
    const text = report(recorded({
      level: 'HIGH', reasons: ['Raised to HIGH by failing invariants, named below.'], predicted: { failed: 1, total: 1 },
      invariants: ['i.test.mjs — holds [INV0001]'],
    }));
    expect(text).toContain('\n\nFailing invariants:\ni.test.mjs — holds [INV0001]\n\n');
  });

  it('names the predicted files that never ran at LOW', () => {
    const text = report(recorded({ predicted: { failed: 1, total: 1 }, predictedNeverRan: ['p.test.mjs'] }));
    expect(text).toContain(`\n\nPredicted files that never ran:\np.test.mjs\n\n${LINK}`);
  });

  it(`names the first ${NAMED} failing invariants and predicted files that never ran, and counts them all`, () => {
    const files = Array.from({ length: 7 }, (_, i) => `p${i}.test.mjs`);
    const text = report(recorded({ level: 'HIGH', reasons: ['Raised to HIGH by failing invariants, named below.'],
      invariants: names('i', 6), predictedNeverRan: files }));
    expect(text).not.toContain(names('i', 6)[NAMED]);
    expect(text).toContain('[…] Output trimmed. All 6 failing invariants are in the details file.');
    expect(text).not.toContain(files[NAMED]);
    expect(text).toContain('[…] Output trimmed. All 7 files are in the details file.');
  });

  it('names the failing invariants from an older snapshot that kept them in its reasons', () => {
    const event = recorded({ level: 'HIGH', reasons: ['Raised to HIGH by failing invariants:'] });
    const data = JSON.parse(readFileSync(join(root, analysisPath(event.payload))));
    delete data.details.invariants;
    data.details.reasons = [{ text: 'Raised to HIGH by failing invariants:', items: ['i.test.mjs — holds [INV0001]'] }];
    const triageFile = publishSnapshot(branch, { folder: 'triage', extension: 'json' }, Buffer.from(JSON.stringify(data)), root);
    const text = report({ ...event, payload: { ...event.payload, evidence: [triageAnalysis(triageFile)] } });
    expect(text).toContain('\nFailing invariants:\ni.test.mjs — holds [INV0001]\n');
  });

  it('says nothing about names when nothing failed, even with the snapshot gone', () => {
    const event = recorded();
    rmSync(join(root, analysisPath(event.payload)));
    expect(report(event)).not.toContain('cannot be named');
  });
});

describe('the agent\'s notes after the report', () => {
  const counts = (over = {}) => ({ predicted: { failed: 0 }, surprise: { failed: 0 },
    overPredicted: { count: 0 }, notRun: { predicted: 0, unpredicted: 0 }, ...over });
  const steps = notes => notes.split('\n');

  it('opens with the line saying they are for the agent, and ends with the freeze', () => {
    const notes = steps(agentNotes(counts(), false));
    expect(notes[0]).toBe(FOR_AGENT);
    expect(notes.at(-1)).toBe(FROZEN);
    expect(notes[1]).toBe('Next: nothing failed. Write the tests this change needs.');
  });

  it('gives every step the counts call for, in order', () => {
    const notes = steps(agentNotes(counts({ predicted: { failed: 1 }, surprise: { failed: 1 }, overPredicted: { count: 1 }, notRun: { predicted: 1, unpredicted: 0 } }), false));
    expect(notes.slice(1, -1).map(step => /^(?:Next: |Then )[^:]*/.exec(step)[0])).toEqual([
      'Next: start with the surprises', 'Then check each over-predicted test', 'Then fix the predicted failures', 'Then get the predicted files that never ran running',
    ]);
  });

  it('starts with the surprises when the only surprise is a file that never ran', () => {
    expect(agentNotes(counts({ notRun: { predicted: 0, unpredicted: 1 } }), false)).toContain('\nNext: start with the surprises');
  });

  it('tells a test-only change to write its tests', () => {
    expect(agentNotes(counts(), true)).toContain('\nNext: the suite is green, so write the tests this change is for.');
  });
});

describe('a triage refusal', () => {
  const refused = { seq: 5, event: 'triage_refused' };

  it('says why, what it is about, and what to do, then links its event', () => {
    expect(refusalSummary({ why: 'Tests are frozen.', list: ['These differ:', '  a.test.ts'], next: 'Unwind them.', event: refused, dir: DIR })).toBe([
      'Triage refused.', '', 'Tests are frozen.', '', 'These differ:', '  a.test.ts', '', 'Unwind them.', '', `Details: ${DIR}/0005__triage_refused.json`,
    ].join('\n'));
  });

  it('says no event was recorded when the refusal recorded none', () => {
    const text = refusalSummary({ why: 'No plan has been approved on this branch.' });
    expect(text).toBe(`Triage refused.\n\nNo plan has been approved on this branch.\n\n${NO_EVENT}`);
  });

  it('cuts a long list to fit the line ceiling, and keeps the next step and the link', () => {
    const list = Array.from({ length: 300 }, (_, i) => `  modules/file-${i}.ts:${i} something does not compile here`);
    const text = refusalSummary({ why: 'The implementation does not compile.', list, next: ['Finish the implementation.', 'Then run this again.'], event: refused, dir: DIR });
    expect(text.split('\n')).toHaveLength(LINES);
    expect(text).toContain('  modules/file-0.ts:0');
    expect(text).not.toContain('modules/file-299.ts');
    expect(text).toContain(`${CUT}\n\nFinish the implementation.\nThen run this again.\n\nDetails: ${DIR}/0005__triage_refused.json`);
  });
});
