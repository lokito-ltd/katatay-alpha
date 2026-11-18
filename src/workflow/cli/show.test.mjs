import { expect, it, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analysisPath } from '../../../tests/fixtures/workflow/events.mjs';
import { ctx, approvedChange, events, machineFixture, planFile } from '../../../tests/support/machine/harness.mjs';
import { append } from '../chain.mjs';
import { writeTriageSnapshot } from '../triage-snapshot.mjs';
import { current } from '../state.mjs';
import { readBaseline } from '../phase.mjs';
import { approval, treeNow, inFixture } from '../../../tests/support/workflow/deciding.mjs';

machineFixture({ approved: true });

// Import in the test process so mutation reaches the CLI and its assertions.
// Each call starts the module afresh, as a later state-show invocation would.
async function showLines() {
  const cwd = process.cwd();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(code => { throw Error('CLI exit ' + code); });
  try {
    vi.stubEnv('HOME', ctx.home);
    process.chdir(ctx.repo);
    vi.resetModules();
    await expect(import('./show.mjs')).rejects.toThrow('CLI exit 0');
    return output.mock.calls.flat();
  } finally {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}

it('shows a commit approval baseline and a move without provenance', async () => {
  approvedChange();
  const original = inFixture(current).grant;
  const baseline = readBaseline(original.payload.baseline);
  const moved = append(ctx.logbook, 'baseline_moved', { from: baseline, to: baseline }, 'feat/x');
  const lines = await showLines();
  expect(lines).toContain(`baseline   ${baseline.slice(0, 12)} on origin/main — pinned ${baseline.slice(0, 12)}`);
  expect(lines).toContain(`           moved ${baseline.slice(0, 12)} → ${baseline.slice(0, 12)}, ${moved.ts}`);
  expect(lines.join('\n')).not.toMatch(/from the (?:server|last fetch)/);
});

it.each([
  ['current event', true],
  ['missing snapshot', false],
])('shows the recorded triage summary for a %s', async (_, available) => {
  approvedChange();
  const { planSnapshot } = inFixture(current).grant.payload;
  const identities = { tests: [{ file: 'suite', titles: ['broke', 'passed'] }], unlisted: [] };
  const measured = { predicted: { failed: 0, total: 1 }, surprise: { failed: 1, total: 1, failures: ['suite — broke'], names: ['suite — broke'] },
    overPredicted: { count: 1, total: 1, tests: ['suite — passed'] }, notRun: { predicted: [], unpredicted: [] } };
  const snapshot = writeTriageSnapshot('feat/x', identities, measured, ctx.repo);
  const reasons = ['Raised to HIGH by surprise failures: 1 against 1 predicted, 20% or more.'];
  const entry = append(ctx.logbook, 'triaged', { treeFingerprint: treeNow(), implementationFingerprint: inFixture(current).implementationFingerprint, level: 'HIGH', reasons, implemented: true, ...snapshot }, 'feat/x');
  if (!available) unlinkSync(join(ctx.repo, analysisPath(snapshot)));

  const output = await showLines();
  expect(output).toContain(`approved plan: ${planSnapshot} — read the approved plan from this snapshot.`);
  const lines = output.join('\n');
  expect(lines).toContain(`triage     recorded ${entry.ts}. Its counts are the suite's as it stood then.\n`
    + "           Triage of plan's missed predictions and test regressions.\n\n"
    + '           Risk: HIGH\n           Raised to HIGH by surprise failures: 1 against 1 predicted, 20% or more.\n'
    + '           2 tests ran, 1 failed\n');
  expect(lines).toContain(`           Details: .katatay/state/feat_x/${entry.seq.toString().padStart(4, '0')}__triaged.json`);
  if (available) {
    expect(lines).toContain('suite — broke');
    expect(lines).toContain('suite — passed');
  } else {
    expect(lines).toContain('           The tests cannot be named: triage ' + entry.seq + ' ' + analysisPath(snapshot));
    // Said once, in the report, and not again under it.
    expect(lines).not.toContain('The triage snapshot cannot be read');
    expect(lines).toContain('Restore the exact snapshot');
    expect(lines).not.toContain('suite — broke');
  }
});

// The report reads the snapshot only to name tests. Recording still needs it,
// so state show says when it is gone whatever the report named.
it('says a lost triage snapshot cannot be read when the report has nothing to name', async () => {
  approvedChange();
  const identities = { tests: [{ file: 'suite', titles: ['passed'] }], unlisted: [] };
  const measured = { predicted: { failed: 0, total: 0 }, surprise: { failed: 0, total: 1, failures: [] },
    overPredicted: { count: 0, total: 0, tests: [] }, notRun: { predicted: [], unpredicted: [] } };
  const snapshot = writeTriageSnapshot('feat/x', identities, measured, ctx.repo);
  const entry = append(ctx.logbook, 'triaged', { treeFingerprint: treeNow(), implementationFingerprint: inFixture(current).implementationFingerprint, level: 'LOW', reasons: [], implemented: true, ...snapshot }, 'feat/x');
  unlinkSync(join(ctx.repo, analysisPath(snapshot)));

  const lines = (await showLines()).join('\n');
  expect(lines).toContain('           Risk: LOW\n           1 test ran, 0 failed\n');
  expect(lines).toContain('           The triage snapshot cannot be read: triage ' + entry.seq + ' ' + analysisPath(snapshot));
  expect(lines).not.toContain('cannot be named');
});

it.each(['missing', 'corrupt'])('reports a %s approved snapshot and recognizes restoration without changing approval', async damage => {
  approvedChange();
  const { grant } = inFixture(current);
  const reference = grant.payload.planSnapshot;
  const path = join(ctx.repo, reference);
  const approvedBytes = readFileSync(path);
  const history = events().map(name => [name, readFileSync(join(ctx.logbook, name))]);
  if (damage === 'missing') unlinkSync(path);
  else writeFileSync(path, '# Unapproved replacement');

  const lines = await showLines();
  expect(lines).toContain('phase      implementing');
  const planLines = lines.filter(line => line.startsWith('approved plan:'));
  expect(planLines).toHaveLength(1);
  expect(planLines[0]).toContain(`approved plan: ${reference} — unavailable locally (`);
  expect(planLines[0]).toContain(damage === 'missing' ? 'ENOENT' : 'SHA-256 digest mismatch');
  expect(planLines[0]).toContain('Restore the exact approved snapshot at the recorded path and retry.');
  expect(lines.join('\n')).not.toContain('read the approved plan from this snapshot');
  if (damage === 'missing') expect(existsSync(path)).toBe(false);
  else expect(readFileSync(path, 'utf8')).toBe('# Unapproved replacement');

  writeFileSync(path, approvedBytes);
  const restored = await showLines();
  expect(restored).toContain(`approved plan: ${reference} — read the approved plan from this snapshot.`);
  expect(restored.join('\n')).not.toContain('unavailable locally');
  expect(restored).toContain('phase      implementing');
  expect(inFixture(current).grant).toEqual(grant);
  expect(events().map(name => [name, readFileSync(join(ctx.logbook, name))])).toEqual(history);
});

it('shows no approved plan after reset even while the old snapshot remains readable', async () => {
  approvedChange();
  const { planSnapshot } = inFixture(current).grant.payload;
  const path = join(ctx.repo, planSnapshot);
  const bytes = readFileSync(path);
  append(ctx.logbook, 'reset', { note: null }, 'feat/x');

  const lines = await showLines();
  expect(lines).toContain('phase      open');
  expect(lines.some(line => line.startsWith('approved plan:'))).toBe(false);
  expect(lines.join('\n')).not.toContain(planSnapshot);
  expect(lines.join('\n')).not.toContain('permitted  operator approved');
  expect(readFileSync(path)).toEqual(bytes);
});

it('follows a revision and never falls back to its readable predecessor or input file', async () => {
  approvedChange();
  const oldReference = inFixture(current).grant.payload.planSnapshot;
  const oldBytes = readFileSync(join(ctx.repo, oldReference));
  const text = '# Revised plan\n\nUse the new scope.';
  const inputFile = planFile('revision.md');
  expect(approval(text, inputFile).recorded).toBe(true);
  const { planSnapshot: reference } = inFixture(current).grant.payload;
  expect(reference).not.toBe(oldReference);
  expect(readFileSync(join(ctx.repo, reference), 'utf8')).toBe(text);
  const available = await showLines();
  expect(available).toContain(`approved plan: ${reference} — read the approved plan from this snapshot.`);
  expect(available.join('\n')).not.toContain(oldReference);

  unlinkSync(join(ctx.repo, reference));
  const unavailable = await showLines();
  expect(unavailable).toContain('phase      implementing');
  expect(unavailable.join('\n')).toContain(`approved plan: ${reference} — unavailable locally`);
  expect(unavailable.join('\n')).not.toContain(oldReference);
  expect(unavailable.join('\n')).not.toContain(inputFile);
  expect(unavailable.join('\n')).not.toContain('read the approved plan from this snapshot');
  expect(readFileSync(join(ctx.repo, oldReference))).toEqual(oldBytes);
  expect(readFileSync(inputFile, 'utf8')).toBe(text);
  expect(existsSync(join(ctx.repo, reference))).toBe(false);
});
