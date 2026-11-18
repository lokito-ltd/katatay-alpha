import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { inRoot } from '../../../src/workflow/check-output.mjs';
import { buildReport, gapsOf } from '../../../src/evidence/report.ts';
import { root, write, git, configure, run, saved, verifyRun, kept, BRANCH } from '../../support/workflow/check-output.mjs';
import { writeCoverageSnapshot } from '../../../src/workflow/coverage-snapshot.mjs';

describe('saved coverage analysis', () => {
  // The fixture has no logbook, so no verification: the change report must
  // not fall back to the working output file that a run left behind.
  it('reports coverage as missing evidence without a verification, whatever the working output holds', () => {
    expect(run().outcome).toBe('clean');
    const report = inRoot(root, () => buildReport());
    expect(report.coverage).toBeUndefined();
    expect(report.incomplete).toContainEqual({ section: 'coverage', reason: expect.stringContaining('no verification for the current tree') });
    expect(gapsOf(report)).not.toHaveProperty('uncoveredLines');
  });

  it('keeps no touched-line evidence when the analysis had no baseline', () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    const result = verifyRun();
    expect(result.outcome).toBe('clean');
    expect(kept(result.snapshots, null).touched).toBeNull();
  });

  it.each(['', 'all green', 'SF:modules/a.mjs\nDA:1,0\nLH:1\nend_of_record\n'])('rejects invalid LCOV %j without retaining an older success', (text) => {
    expect(verifyRun().outcome).toBe('clean');
    write('reports/source.info', text);
    const result = verifyRun();
    expect(result.outcome).toBe('broken');
    expect(result).not.toHaveProperty('snapshots');
    expect(saved().result.outcome).toBe('broken');
    expect(saved()).not.toHaveProperty('measurement');
  });

  it.each(['exit 7', 'kill -TERM $$', 'missing-coverage-command'])('rejects failed command %s and replaces previous success', (command) => {
    expect(verifyRun().outcome).toBe('clean');
    configure({ command });
    const result = verifyRun();
    expect(result.outcome).toBe('broken');
    expect(result).not.toHaveProperty('snapshots');
    expect(saved().result.outcome).toBe('broken');
  });

  it('stops coverage at the configured time limit', () => {
    configure({ command: 'sleep 3', timeLimitSeconds: 1 });
    expect(run()).toMatchObject({ outcome: 'broken', reason: expect.stringContaining('stopped') });
  });

  it('does not publish success if the command changes the working tree', () => {
    expect(run().outcome).toBe('clean');
    write('reports/emit.cjs', "require('fs').writeFileSync('modules/a.mjs', 'changed'); process.stdout.write(require('fs').readFileSync('reports/source.info'));\n");
    expect(run()).toMatchObject({ outcome: 'broken', reason: expect.stringContaining('changed during the check') });
    expect(existsSync(join(root, 'reports/checks/coverage.json'))).toBe(false);
  });

  it('reports absent, unreadable, malformed and inconsistent kept evidence', () => {
    const { snapshots } = verifyRun();
    expect(kept(snapshots).touched.covered).toBe(1);
    expect(() => kept(undefined)).toThrow('No coverage snapshots were recorded');
    expect(() => kept({ raw: snapshots.raw })).toThrow('Invalid coverage references: .analysis');
    const original = JSON.parse(readFileSync(join(root, snapshots.analysis), 'utf8'));
    const republish = (text) => writeCoverageSnapshot(BRANCH, { raw: 'raw', analysis: text }, root);
    for (const alter of [
      (v) => { v.result.exitCode = 'SIGTERM'; }, (v) => { v.name = 'other'; }, (v) => { delete v.measurement; },
      (v) => { v.result = {}; },
    ]) {
      const data = structuredClone(original); alter(data);
      expect(() => kept(republish(JSON.stringify(data)))).toThrow('invalid shape');
    }
    for (const alter of [
      (v) => { v.measurement.touched.total = 99; }, (v) => { v.measurement.touched.uncovered[0].lines = [2, 2]; },
      (v) => { v.measurement.folders[0].lines.measured = 1000; },
      (v) => { v.measurement.failures = ['a failure']; }, (v) => { v.measurement.folders = []; },
    ]) {
      const data = structuredClone(original); alter(data);
      expect(() => kept(republish(JSON.stringify(data)))).toThrow('invalid coverage figures');
    }
    expect(() => kept(republish('{'))).toThrow('not JSON');
    rmSync(join(root, snapshots.raw));
    expect(() => kept(snapshots)).toThrow('raw coverage');
  });
});
