import { verified as receiptPayload } from '../../tests/fixtures/workflow/events.mjs';
/**
 * What `workflow report` prints, in process: the summary kept with this
 * tree's `record` decision, or a preview. The logbook state is mocked, and
 * kept reports live in a temporary folder.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { current } from '../workflow/state.mjs';
import { writeChangeReport } from '../workflow/change-summary.mjs';
import { standaloneSummary, type ReportData } from './report.js';

vi.mock('../workflow/state.mjs', () => ({ current: vi.fn() }));

const built: ReportData = { notChecked: [], incomplete: [], size: { code: { added: 4, deleted: 1 }, tests: { added: 1, modified: 0, removed: 0 } } };
const kept = ['prediction: exact · risk: LOW', 'kept summary line'];
const approved = { event: 'plan_approved', payload: {} };
const verified = { seq: 2, event: 'verified', payload: receiptPayload({ treeFingerprint: 't1' }) };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'report-standalone-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const logbook = (...decisions: object[]) => vi.mocked(current).mockReturnValue(
  { branch: 'topic', dir: '.katatay/state/topic', ...verified.payload, live: [approved, verified, ...decisions] } as never);
const decision = (event: 'declared' | 'record_held', seq = 3) => {
  const changeReportSnapshot = writeChangeReport('topic', { treeFingerprint: 't1', decision: event, lines: ['Change report'], summary: kept,
    gaps: { uncoveredLines: 0, uncaughtMutants: 0 } }, root);
  return { seq, event, payload: { treeFingerprint: 't1', note: null, changeReportSnapshot,
    gaps: { uncoveredLines: 0, uncaughtMutants: 0 }, ...(event === 'declared' ? { summary: kept } : {}) } };
};

it('shows a preview, linking no event, when no decision exists for the tree', () => {
  logbook();
  const text = standaloneSummary({ ...built, incomplete: [] }, root);
  expect(text).toBe(['Change report preview. No `record` decision exists for this tree.', '',
    'prediction: ? · risk: ?', 'test files: 1 added, 0 modified, 0 removed', 'code +4 −1 lines', '',
    'No logbook event was recorded.'].join('\n'));
});

it.each([
  ['declared', 'Change declared on this tree.'],
  ['record_held', 'Change held on this tree.'],
] as const)('shows the summary kept with a %s decision, linked to its event', (event, opening) => {
  logbook(decision(event));
  expect(standaloneSummary({ ...built, incomplete: [] }, root)).toBe([
    `${opening} This is the report recorded with that decision.`, '', ...kept, '',
    `Details: .katatay/state/topic/0003__${event}.json`].join('\n'));
});

it('says a kept report that no longer reads, and shows a preview instead', () => {
  const held = decision('record_held');
  writeFileSync(join(root, held.payload.changeReportSnapshot), '{}');
  logbook(held);
  const text = standaloneSummary({ ...built, incomplete: [] }, root);
  expect(text).toMatch(/^Change report preview\. /);
  expect(text).toContain(`\n\nCould not be read:\n- recorded change report: record_held 3 ${held.payload.changeReportSnapshot}: SHA-256 digest mismatch\n\n`);
  expect(text).toMatch(/\nNo logbook event was recorded\.$/);
});
