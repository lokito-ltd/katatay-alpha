import { verified as receiptPayload } from '../../tests/fixtures/workflow/events.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINES } from './compact-report.mjs';
import { changeReports, publishSnapshot } from './local-snapshot.mjs';
import { changeReportEvidence, changeSummary, declaredReason, outcomeTitle, PREVIEW, recordedDecision, writeChangeReport } from './change-summary.mjs';

const busiest = [
  'prediction: 3 surprises, 1 over-prediction · protected files: 2 · risk: MEDIUM',
  'AC scenarios: 2 added, 1 reworded, 0 retired (1 without acceptance evidence)',
  'tests: 52 added, 46 modified, 23 removed',
  'change coverage 98% (155 of 158 lines) · mutants: 553 caught, 29 survived (earlier tree)',
  'follow-ups +1 −0 · code +424 −136 lines',
  '1 setup warning',
];
const link = '.katatay/state/topic/0015__declared.json';

describe('the change summary', () => {
  // The one test of the whole layout. The others check what it says.
  it('lays out the outcome, the headline counts and the link', () => {
    const title = outcomeTitle({ decision: 'declared', reason: 'accepted' });
    expect(changeSummary({ title, summary: busiest, link })).toBe([
      'Change declared. You typed `record` again on the same tree, so you accept the gaps it shows.',
      '',
      ...busiest,
      '',
      `Details: ${link}`,
    ].join('\n'));
  });

  it.each([
    [{ decision: 'declared', reason: 'clean' }, 'Change declared. The report found no gaps.'],
    [{ decision: 'declared', reason: 'acted' }, 'Change declared. Tests changed since the verification before, so the gaps do not hold it.'],
    [{ decision: 'record_held', gaps: { uncoveredLines: 1 } },
      'Change held: 1 touched line no test runs.\nNo test changed since the verification before. Type `record` again to declare it as it stands.'],
    [{ decision: 'record_held', gaps: { uncaughtMutants: 1 } }, 'Change held: 1 mutant no test caught.\n'],
    [{ decision: 'record_held', gaps: { uncoveredLines: 3, uncaughtMutants: 7 } }, 'Change held: 3 touched lines no test runs, and 7 mutants no test caught.\n'],
    [{ decision: 'incomplete', count: 1 }, 'Change not declared: 1 section of the change report could not be read.'],
    [{ decision: 'incomplete', count: 2 }, 'Change not declared: 2 sections of the change report could not be read.'],
    [{ decision: 'failed', why: 'it exited with 1' }, 'Change not declared. The change report could not be built: it exited with 1'],
    [{ decision: 'preview' }, PREVIEW],
    [{ decision: 'recorded', event: 'declared' }, 'Change declared on this tree. This is the report recorded with that decision.'],
    [{ decision: 'recorded', event: 'record_held' }, 'Change held on this tree. This is the report recorded with that decision.'],
  ])('opens %j with its outcome', (outcome, expected) => {
    expect(outcomeTitle(outcome).startsWith(expected)).toBe(true);
  });

  it('says a report that could not be built with nothing between the outcome and the missing link', () => {
    const title = outcomeTitle({ decision: 'failed', why: 'it exited with 1' });
    expect(changeSummary({ title, link: null }))
      .toBe('Change not declared. The change report could not be built: it exited with 1\n\nNo logbook event was recorded.');
  });

  it('refuses an outcome it does not know', () => {
    expect(() => outcomeTitle({ decision: 'maybe' })).toThrow('unknown change summary outcome maybe');
  });

  it('gives the reason a change was declared, in the order the decision reads it', () => {
    expect(declaredReason({ gaps: { uncoveredLines: 2, uncaughtMutants: 1 }, held: true })).toBe('accepted');
    expect(declaredReason({ gaps: { uncoveredLines: 2 }, held: false })).toBe('acted');
    expect(declaredReason({ gaps: { uncoveredLines: 0, uncaughtMutants: 1 }, held: false })).toBe('acted');
    expect(declaredReason({ gaps: {}, held: false })).toBe('clean');
  });

  // Each unreadable section stops the declaration, so each is named with its
  // reason, whole, and no event links them.
  it('lists every unreadable section with its reason, whole, and links no event', () => {
    const reason = `coverage: ${'a long reason that runs on '.repeat(6)}and ends here.`;
    const problems = [reason, ...Array.from({ length: 10 }, (_, i) => `section ${i}: missing`)];
    const text = changeSummary({ title: outcomeTitle({ decision: 'incomplete', count: problems.length }), summary: busiest, problems, link: null });
    expect(text).toContain(`\n\nCould not be read:\n- ${reason}\n`);
    expect(text).toContain('- section 9: missing\n\nNo logbook event was recorded.');
    expect(text).not.toContain('Details:');
  });

  it('keeps a large change whole and within the ceiling', () => {
    const notChecked = `not checked: ${Array.from({ length: 40 }, (_, i) => `check-${i}`).join(', ')} · 3 setup warnings`;
    const summary = [...busiest.slice(0, 5), 'tests: 12000 added, 4500 modified, 900 removed', notChecked];
    const text = changeSummary({ title: outcomeTitle({ decision: 'declared', reason: 'clean' }), summary, link });
    expect(text.split('\n').length).toBeLessThanOrEqual(LINES);
    expect(text).toContain(`\n${notChecked}\n`);
  });
});

describe('the kept change report', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'change-report-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const report = { treeFingerprint: 't1', decision: 'declared', lines: ['Change report', '  risk LOW'], summary: ['risk LOW'], gaps: { uncoveredLines: 0, uncaughtMutants: 0 } };
  const keep = (data = report) => writeChangeReport('topic', data, root);
  const event = (changeReportSnapshot, changes = {}) => ({ seq: 9, event: 'declared',
    payload: { treeFingerprint: 't1', note: null, gaps: report.gaps, summary: report.summary, changeReportSnapshot }, ...changes });

  it('reads back what was kept for the event that names it', () => {
    const changeReportSnapshot = keep();
    expect(changeReportSnapshot).toMatch(/^\.katatay\/local\/topic\/change-report\/\d{8}T\d{6}\.\d{3}Z_[\w-]{43}\.json$/);
    expect(changeReportEvidence('topic', event(changeReportSnapshot), root)).toEqual({ version: 1, ...report });
  });

  it('keeps the report as indented JSON ending with a newline', () => {
    const bytes = readFileSync(join(root, keep({ ...report, version: 99 })), 'utf8');
    expect(bytes).toBe(`${JSON.stringify({ version: 1, ...report }, null, 2)}\n`);
  });

  it.each([
    ['tree', { treeFingerprint: 't2' }, 'its tree disagrees with the event'],
    ['decision', { decision: 'record_held' }, 'its decision disagrees with the event'],
    ['summary', { summary: ['risk HIGH'] }, 'its summary disagrees with the declaration'],
    ['summary prefix', { summary: [] }, 'its summary disagrees with the declaration'],
    ['lines', { lines: 'Change report' }, 'invalid change report snapshot'],
    ['lines types', { lines: ['Change report', 2] }, 'invalid change report snapshot'],
    ['summary types', { summary: [null] }, 'invalid change report snapshot'],
    ['version', { version: 2 }, 'change report.version has unsupported schema version 2'],
    ['null version', { version: null }, 'change report.version has unsupported schema version null'],
    ['string version', { version: '1' }, 'change report.version has unsupported schema version "1"'],
    ['missing version', { version: undefined }, 'change report.version has unsupported schema version missing'],
  ])('refuses a report whose %s disagrees with its event, naming the event and file', (_, change, problem) => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...report, ...change }));
    const changeReportSnapshot = publishSnapshot('topic', changeReports, bytes, root);
    expect(() => changeReportEvidence('topic', event(changeReportSnapshot), root)).toThrow(`declared 9 ${changeReportSnapshot}: ${problem}`);
  });

  it('refuses a summary that differs in a later line, or is a prefix of the event\'s', () => {
    const two = ['risk LOW', 'tests: 1 added'];
    const changeReportSnapshot = keep({ ...report, summary: two });
    const declared = (summary) => event(changeReportSnapshot, { payload: { ...event(changeReportSnapshot).payload, summary } });
    expect(() => changeReportEvidence('topic', declared(['risk LOW', 'tests: 2 added']), root)).toThrow('its summary disagrees with the declaration');
    expect(() => changeReportEvidence('topic', declared([...two, 'follow-ups +1 −0']), root)).toThrow('its summary disagrees with the declaration');
  });

  it.each([
    ['null', Buffer.from('null\n'), 'change report.version has unsupported schema version missing'],
    ['invalid UTF-8', Buffer.concat([Buffer.from('{"version":1,"tree":"t1","decision":"declared","lines":["'), Buffer.from([0xff]),
      Buffer.from('"],"summary":["risk LOW"]}')]), 'The encoded data was not valid for encoding utf-8'],
  ])('refuses a kept report that is %s, naming the event and file', (_, bytes, problem) => {
    const changeReportSnapshot = publishSnapshot('topic', changeReports, bytes, root);
    expect(() => changeReportEvidence('topic', event(changeReportSnapshot), root)).toThrow(`declared 9 ${changeReportSnapshot}: ${problem}`);
  });

  it('checks a hold\'s tree and decision, which keeps no summary of its own', () => {
    const changeReportSnapshot = keep({ ...report, decision: 'record_held' });
    const held = { seq: 4, event: 'record_held', payload: { treeFingerprint: 't1', note: null, gaps: report.gaps, changeReportSnapshot } };
    expect(changeReportEvidence('topic', held, root).decision).toBe('record_held');
  });

  it('says a report edited or removed since it was kept cannot be read', () => {
    const changeReportSnapshot = keep();
    writeFileSync(join(root, changeReportSnapshot), '{}');
    expect(() => changeReportEvidence('topic', event(changeReportSnapshot), root)).toThrow(`declared 9 ${changeReportSnapshot}: SHA-256 digest mismatch`);
    rmSync(join(root, changeReportSnapshot));
    expect(() => changeReportEvidence('topic', event(changeReportSnapshot), root)).toThrow('ENOENT');
  });
});

describe('the decision recorded for a tree', () => {
  const approved = { event: 'plan_approved', payload: {} };
  const verified = (treeFingerprint) => ({ event: 'verified', payload: receiptPayload({ treeFingerprint }) });
  const decided = (event, treeFingerprint, changeReportSnapshot = 'r.json') => ({ event, payload: { treeFingerprint, changeReportSnapshot } });

  it('is the declaration after the tree\'s receipt, or else its hold', () => {
    const held = decided('record_held', 't1');
    const declared = decided('declared', 't1');
    expect(recordedDecision([approved, verified('t1'), held], verified('t1').payload)).toBe(held);
    expect(recordedDecision([approved, verified('t1'), held, declared], verified('t1').payload)).toBe(declared);
  });

  it('is none for another tree or a decision before the receipt', () => {
    expect(recordedDecision([approved, verified('t1'), decided('declared', 't1')], verified('t2').payload)).toBeNull();
    expect(recordedDecision([approved, decided('declared', 't1'), verified('t1')], verified('t1').payload)).toBeNull();
  });
});
