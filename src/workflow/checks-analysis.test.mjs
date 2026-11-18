import { verified } from '../../tests/fixtures/workflow/events.mjs';
import { expect, it } from 'vitest';
import { analysisRequest, analysisSummary, CLEAN, evidenceSection, lostAnalysisSummary, summaryOf, validateAnalysis } from './checks-analysis.mjs';
import { LINES } from './compact-report.mjs';
import { SUMMARY_LIMIT } from './event-format.mjs';
import { analysisRequired } from './rulebook.mjs';

const clean = { coverage: { status: 'complete', uncovered: [] }, mutation: { status: 'complete', survivors: [] }, checks: [] };
const report = {
  coverage: { status: 'complete', uncovered: [{ file: 'orders.ts', line: 4 }] },
  mutation: { status: 'partial', treeFingerprint: 'earlier', survivors: ['m1', 'm2'].map(id => ({ file: 'orders.ts', line: 4, id })) },
  checks: [{ name: 'lint', status: 'findings' }, { name: 'scan', status: 'deferred' }, { name: 'build', status: 'clean' }],
};
const entries = [
  'Coverage orders.ts:4\nScenario: Refund an order on day 30.\nAssert: A refund is issued.',
  'Mutants orders.ts:4\nVariant m1\nScenario: Request a day-30 refund.\nAssert: Accept it.\nVariant m2\nNo observable effect: Inputs are whole days.',
  'Check lint\nFinding: Two unused imports.\nAction: Remove both and rerun lint.',
  'Limit mutation [partial]\nImpact: Only completed mutants count.',
  'Limit mutation [reused]\nImpact: Results describe the earlier tree.',
  'Limit scan [deferred]\nImpact: Security has not been checked.',
];
const summary = 'Summary: Add a day-30 refund test and remove two unused imports.';
const valid = [summary, ...entries].join('\n\n');
it('requires each measured group, variant and limitation and gives the agent their headings', () => {
  expect(() => validateAnalysis(report, valid)).not.toThrow();
  const request = analysisRequest(12, report);
  for (const entry of entries) expect(request).toContain(entry.split('\n')[0]);
  expect(request).toContain('Variant m1\nVariant m2');
  expect(request).toContain('workflow checks-analysis 12');
  for (const entry of entries) {
    expect(() => validateAnalysis(report, valid.replace(entry, ''))).toThrow('missing ' + entry.split('\n')[0]);
  }
});
it.each([
  [() => valid.replace('orders.ts:4', 'orders.ts:7'), 'unexpected Coverage'],
  [() => valid + '\n' + entries[0], 'duplicate Coverage'],
  [() => 'Comment\n' + valid, 'missing Summary'],
  [() => entries.join('\n\n'), 'missing Summary'],
  [() => valid.replace(summary, 'Summary:  '), 'missing Summary'],
  [() => valid.replace(summary, summary + '\nSee .katatay/local/x/coverage/a.json.'), 'Summary names evidence paths'],
  [() => valid.replace('Variant m1', 'Variant m7'), 'unexpected or duplicate Variant m7'],
  [() => valid.replace('Variant m1', 'Variant m2'), 'unexpected or duplicate Variant m2'],
  [() => valid.replace(/Variant m2\nNo observable effect:[^\n]+/, ''), 'missing Mutants orders.ts:4, Variant m2'],
  [() => valid.replace('Variant m1\n', ''), 'expected Variant heading'],
  [() => valid.replace('Assert: Accept it.', 'Assert:  '), 'needs Scenario and Assert'],
  [() => valid.replace('Assert: A refund is issued.', 'Scenario: Duplicate.'), 'needs Scenario and Assert'],
  [() => valid.replace('Finding:', 'Other:'), 'needs Finding and Action'],
  [() => valid.replace('Impact: Security has not been checked.', 'Impact'), 'needs Impact'],
])('rejects malformed analysis %#', (change, problem) => {
  expect(() => validateAnalysis(report, change())).toThrow(problem);
});
it('accepts a single clean sentence only when all measurements are complete and clean', () => {
  expect(() => validateAnalysis(clean, CLEAN + '\n')).not.toThrow();
  expect(analysisRequest(9, clean)).toContain(CLEAN);
  expect(() => validateAnalysis(clean, ' ')).toThrow('expected');
  expect(() => validateAnalysis(report, CLEAN)).toThrow();
});
it('defaults on, accepts only booleans, and honors explicit false', () => {
  for (const value of [undefined, true, false]) expect(analysisRequired({ checks: { requireAnalysis: value } })).toBe(value ?? true);
  for (const value of [null, 'false', 0]) expect(() => analysisRequired({ checks: { requireAnalysis: value } })).toThrow('must be true or false');
});

it('instructs the writer how to turn each kind of evidence into an improvement', () => {
  const task = analysisRequest(12, report);
  for (const instruction of [
    'verification 12', 'payload.results and the snapshots its results name', 'tests and code quality improvements',
    'setup and action', 'observable result', 'No observable effect: with the reason',
    'the code change and how to confirm it', 'why no change is warranted', 'what remains unknown',
    'full verification report and warnings in the main chat', 'the summary the command prints, exactly as printed',
    'Do not paste the full analysis',
  ]) expect(task).toContain(instruction);
});

it('accepts indented CRLF text and colons in field values, including a justified no-change action', () => {
  const formatted = valid.replace('Remove both and rerun lint.', 'Keep both imports: removing either disables registration.')
    .replace('Assert: Accept it.', 'Assert:Accept it.').split('\n').map(line => '  ' + line).join('\r\n');
  expect(() => validateAnalysis(report, formatted)).not.toThrow();
});

it.each([
  ['Check lint\nFinding: Two unused imports.', 'Check lint', 'Check lint needs Finding and Action'],
  ['Action: Remove both and rerun lint.', 'Action: \t', 'Check lint needs Finding and Action'],
  ['Assert: A refund is issued.', 'Assert: The Check lint action has no effect on refunds.', null],
])('checks the fields inside their own section (%#)', (before, after, error) => {
  const validate = () => validateAnalysis(report, valid.replace(before, after));
  if (error) expect(validate).toThrow(error);
  else expect(validate).not.toThrow();
});

it('requires a named coverage limitation even when no uncovered lines could be measured', () => {
  const missing = { ...clean, coverage: { status: 'unavailable', uncovered: [] } };
  expect(() => validateAnalysis(missing, '')).toThrow('missing Summary');
  expect(() => validateAnalysis(missing, 'Summary: Coverage was not measured.')).toThrow('missing Limit coverage [unavailable]');
  expect(() => validateAnalysis(missing, 'Summary: Coverage was not measured.\nLimit coverage [unavailable]\nImpact: No touched lines were measured.')).not.toThrow();
});

it('asks for a summary without evidence paths only when there are entries', () => {
  const task = analysisRequest(12, report);
  for (const instruction of ['Begin with a line starting `Summary:`', 'without evidence paths', `first ${SUMMARY_LIMIT} characters`,
    'lists the evidence at the end of the saved analysis']) expect(task).toContain(instruction);
  expect(task.indexOf('Summary:')).toBeLessThan(task.indexOf('Then use these entry headings'));
  // Each instruction is its own paragraph.
  expect(task).toContain('Recommend specific tests and code quality improvements based on these reports.\n\nFor each Coverage entry');
  expect(task).toContain('at the end of the saved analysis.\n\nThen use these entry headings');
  expect(analysisRequest(9, clean)).not.toContain('Summary:');
});

it('keeps the clean sentence as its own summary, and a multi-line summary up to the first heading', () => {
  expect(summaryOf(CLEAN + '\n')).toBe(CLEAN);
  expect(summaryOf('\n  Summary: Two tests.\n  One import.\n\nCheck lint\nFinding: x\nAction: y')).toBe('Two tests.\nOne import.');
  expect(summaryOf('Check lint\nFinding: x')).toBeNull();
  expect(summaryOf('Summary:\nCheck lint')).toBeNull();
});

it('reads a summary with no space after the colon, and only from the start of the line', () => {
  expect(summaryOf('Summary:Two tests.\nCheck lint')).toBe('Two tests.');
  const prefixed = 'Note: Summary: two tests.\n\n' + entries.join('\n\n');
  expect(summaryOf(prefixed)).toBeNull();
  expect(() => validateAnalysis(report, prefixed)).toThrow('missing Summary');
});

it('cuts a long summary to the limit in code points, ending in an ellipsis', () => {
  const astral = '𝄞'.repeat(SUMMARY_LIMIT + 1);
  const cut = summaryOf(`Summary: ${astral}\nCheck lint`);
  expect([...cut]).toHaveLength(SUMMARY_LIMIT);
  expect(cut).toBe('𝄞'.repeat(SUMMARY_LIMIT - 1) + '…');
  const exact = 'a'.repeat(SUMMARY_LIMIT);
  expect(summaryOf(`Summary: ${exact}`)).toBe(exact);
});

it('lists every evidence item the results name, in receipt order, or says there is none', () => {
  const item = (title, snapshot) => ({ role: 'raw', title, snapshot });
  const receipt = { payload: { results: [{ name: 'lint', evidence: [item('lint output', 'a.txt')] }, { name: 'scan', evidence: [] }, { name: 'tests', evidence: [item('JUnit XML', 'b.xml'), item('test analysis', 'c.json')] }] } };
  expect(evidenceSection(receipt)).toBe('\n\nEvidence\n- lint, lint output: a.txt\n- tests, JUnit XML: b.xml\n- tests, test analysis: c.json\n');
  expect(evidenceSection({ payload: verified() })).toBe('\n\nEvidence\nNone.\n');
});

const LINK = '.katatay/state/feat_x/0008__checks_analysis.json';
/** The summary rows, without the blank line and link that follow them. */

it('labels the compact summary as the agent\'s assessment and counts what it recommends', () => {
  validateAnalysis(report, valid);
  expect(analysisSummary({ text: valid, seq: 12, link: LINK })).toBe([
    'Agent\'s assessment for verification 12 checks results.',
    '',
    'Add a day-30 refund test and remove two unused imports.',
    '',
    'Tests suggested: 1 for uncovered lines, 1 for surviving mutants.',
    'Mutants with no observable effect: 1.',
    'Check findings answered: 1 (lint).',
    'Limitations: 3 (mutation [partial], mutation [reused], scan [deferred]).',
    '',
    `Full analysis: ${LINK}`,
  ].join('\n'));
});

it('leaves out counts of zero, and gives a clean analysis its sentence alone', () => {
  const onlyLint = 'Summary: Remove the import.\nCheck lint\nFinding: Unused.\nAction: Remove it.';
  const text = analysisSummary({ text: onlyLint, seq: 3, link: LINK });
  expect(text).toContain('Check findings answered: 1 (lint).');
  for (const absent of ['Tests suggested', 'no observable effect', 'Limitations']) expect(text).not.toContain(absent);
  expect(analysisSummary({ text: `  ${CLEAN}\n`, seq: 3, link: LINK }))
    .toBe(`Agent's assessment for verification 3 checks results.\n\n${CLEAN}\n\nFull analysis: ${LINK}`);
});

it('keeps a long analysis within the line ceiling, cutting the agent\'s text first', () => {
  const long = valid.replace('Summary: ', 'Summary: ' + 'A refund line.\n'.repeat(150));
  const cut = analysisSummary({ text: long, seq: 12, link: LINK });
  expect(cut.split('\n')).toHaveLength(LINES);
  expect(cut).toContain('… The rest is in the event.');
  expect(cut).toContain('Check findings answered: 1 (lint).');
  expect(cut.endsWith(`\n\nFull analysis: ${LINK}`)).toBe(true);
});

// A list of names is one line, and lines are never wrapped, so it fits and
// keeps its names however many there are.
it('keeps every name of a long list on its one line', () => {
  const names = Array.from({ length: 200 }, (_, i) => `Limit check${i} [deferred]\nImpact: Not run.`);
  const crowded = analysisSummary({ text: [summary, ...names].join('\n\n'), seq: 12, link: LINK });
  expect(crowded.split('\n').length).toBeLessThanOrEqual(LINES);
  expect(crowded).toMatch(/\nLimitations: 200 \(check0 \[deferred\], [^\n]*check199 \[deferred\]\)\.\n/);
});

it('builds the summary from the event alone when the full analysis is lost, naming the file and why', () => {
  const text = lostAnalysisSummary({ summary: 'Add a refund test.', seq: 5, link: LINK, evidence: '.katatay/local/x/a.txt', why: 'ENOENT.' });
  expect(text).toBe([
    'Agent\'s assessment for verification 5 checks results.',
    '',
    'The full analysis cannot be read from .katatay/local/x/a.txt: ENOENT.',
    '',
    'Add a refund test.',
    '',
    `Full analysis: ${LINK}`,
  ].join('\n'));
});

it('counts indented CRLF analyses the same, and mutant scenarios apart from coverage ones', () => {
  const two = [summary,
    'Coverage orders.ts:4\nScenario: Refund on day 30.\nAssert: A refund is issued.',
    'Mutants orders.ts:4\nVariant m1\nScenario: Day 30.\nAssert: Accepted.\nVariant m2\nScenario: Day 31.\nAssert: Refused.',
  ].join('\n\n');
  const expected = 'Tests suggested: 1 for uncovered lines, 2 for surviving mutants.';
  expect(analysisSummary({ text: two, seq: 1, link: LINK })).toContain(expected);
  const indented = two.split('\n').map(line => `  ${line}`).join('\r\n');
  expect(analysisSummary({ text: indented, seq: 1, link: LINK })).toContain(expected);
});

it('counts no mutant from a summary line that reads like an entry field', () => {
  const text = 'Summary: Nothing to fix.\nNo observable effect: none expected.\nScenario: none.\n\n'
    + 'Check lint\nFinding: One import.\nAction: Remove it.';
  const shown = analysisSummary({ text, seq: 1, link: LINK });
  expect(shown).not.toContain('Mutants with no observable effect');
  expect(shown).not.toContain('Tests suggested');
  expect(shown).toContain('Check findings answered: 1 (lint).');
});

it('still counts an analysis that has no Summary line', () => {
  expect(analysisSummary({ text: 'Check lint\nFinding: One import.\nAction: Remove it.', seq: 1, link: LINK })).toBe(
    `Agent's assessment for verification 1 checks results.\n\nCheck findings answered: 1 (lint).\n\nFull analysis: ${LINK}`);
});

it('drops only a final full stop from the reason a lost analysis cannot be read', () => {
  const text = lostAnalysisSummary({ summary: 'S.', seq: 1, link: LINK, evidence: 'e.txt', why: "ENOENT, lstat '/tmp/.katatay/a.txt'." });
  expect(text).toContain("cannot be read from e.txt: ENOENT, lstat '/tmp/.katatay/a.txt'.\n");
});
