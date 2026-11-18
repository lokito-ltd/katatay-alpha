import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedPredictions } from './approved-predictions.mjs';
import { approvedPlans, publishSnapshot, readSnapshot } from './local-snapshot.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'approved-predictions-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function grantFor(text, branch = 'feat/x') {
  const bytes = Buffer.from(text);
  return { seq: 7, payload: {
    proposal: createHash('sha256').update(bytes).digest('hex'),
    planSnapshot: publishSnapshot(branch, approvedPlans, bytes, root),
  } };
}

it('reads normalized predictions from approved bytes', () => {
  const grant = grantFor('# Work\n\n```workflow\npredicted-failures: ["./a.test.ts::first", AC0001.2]\n```');
  grant.payload.planSnapshotFile = grantFor('An ignored extra field').payload.planSnapshot;
  expect(approvedPredictions('feat/x', grant, root)).toEqual(['a.test.ts::first', 'AC0001.2']);
});

it('rejects valid snapshot bytes when the approval hash identifies a different plan', () => {
  const grant = grantFor('Approved plan');
  grant.payload.planSnapshot = grantFor('Another plan').payload.planSnapshot;
  expect(() => approvedPredictions('feat/x', grant, root)).toThrow(
    `approval 7 ${grant.payload.planSnapshot}: snapshot differs from the approved plan hash. Restore the exact approved snapshot`);
});

it('rejects an invalid declaration even when the bytes match both hashes', () => {
  const grant = grantFor('# Work\n\n```workflow\nmistyped: true\ntest-only: 3\n```');
  expect(() => approvedPredictions('feat/x', grant, root)).toThrow(
    'its `workflow` block holds `mistyped`, which is not a key a plan may hold. `test-only` must be true or false, and is 3');
});

it.each([
  [approvedPlans, 'plans', 'md', 'approved plan'],
  [{ folder: 'triage', extension: 'json', label: 'triage' }, 'triage', 'json', 'triage'],
])('publishes both same-millisecond snapshots in %s and requires the correct file extension', (kind, folder, ext, label) => {
  const time = new Date('2026-11-03T12:00:00.000Z');
  const inputs = [Buffer.from('one\r\n'), Buffer.from('two\n')];
  const refs = inputs.map(bytes => publishSnapshot('feat/x', kind, bytes, root, time));
  for (const [i, ref] of refs.entries()) {
    const digest = createHash('sha256').update(inputs[i]).digest('base64url');
    expect(ref).toBe(`.katatay/local/feat_x/${folder}/20261103T120000.000Z_${digest}.${ext}`);
    expect(readSnapshot('feat/x', kind, ref, root)).toEqual(inputs[i]);
    const other = ref.slice(0, -ext.length) + (ext === 'md' ? 'json' : 'md');
    copyFileSync(join(root, ref), join(root, other));
    expect(() => readSnapshot('feat/x', kind, other, root)).toThrow(`invalid ${label} reference`);
  }
});
