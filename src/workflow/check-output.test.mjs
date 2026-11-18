import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { configuredCoverage, coverageCheck, runCoverageCheck, touchedCoverage } from './coverage.mjs';
import { checkIdentity, checkedOutput, inRoot, invalidateOutput, saveCheckOutput } from './check-output.mjs';
import { runCheck } from './checks.mjs';
import { readChecks } from './rulebook.mjs';
import { runTestCommand } from '../evidence/test-run.ts';
import { buildReport } from '../evidence/report.ts';
import { LCOV, root, write, git, configure, run, saved, verifyRun, kept } from '../../tests/support/workflow/check-output.mjs';

vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

describe('saved coverage analysis', () => {
  it('saves interpreted figures and touched lines, keeping stderr out of LCOV', () => {
    const output = 'reports/custom/analysis.json';
    configure({ output });
    expect(run()).toMatchObject({ outcome: 'clean', code: 0 });
    const data = JSON.parse(readFileSync(join(root, output), 'utf8'));
    expect(data).toEqual({ version: 1, name: 'coverage',
      result: { outcome: 'clean', exitCode: 0, text: expect.stringContaining('diagnostic'), reason: 'every folder is at or above its minimum' },
      measurement: { folders: [{ folder: 'modules/', files: 1, lines: { covered: 1, total: 2, measured: 500, minimum: 0 },
        branches: { covered: 0, total: 0, measured: 1000, minimum: 0 } }], failures: [],
        touched: { covered: 1, total: 2, uncovered: [{ file: 'modules/a.mjs', lines: [2] }] } } });
    expect(JSON.stringify(data)).not.toContain('SF:');
    expect(JSON.stringify(data)).not.toContain('DA:');
  });

  it('reuses analysis after the source report and the working output are removed, without running the command', () => {
    const result = verifyRun();
    expect(result.outcome).toBe('clean');
    rmSync(join(root, 'reports/source.info'));
    rmSync(join(root, 'reports/checks/coverage.json'));
    write('reports/emit.cjs', "throw new Error('must not run');\n");
    const analysis = kept(result.snapshots);
    expect(analysis.touched.uncovered).toEqual([{ file: 'modules/a.mjs', lines: [2] }]);
    expect(touchedCoverage(result, analysis).join('\n')).toContain('modules/a.mjs: 1 line (2)');
    expect(readFileSync(join(root, 'reports/runs'), 'utf8')).toBe('run\n');
  });

  it('keeps the raw report and the same analysis bytes as the working output', () => {
    const result = verifyRun();
    expect(readFileSync(join(root, result.snapshots.raw), 'utf8')).toBe(LCOV);
    expect(readFileSync(join(root, result.snapshots.analysis), 'utf8')).toBe(readFileSync(join(root, 'reports/checks/coverage.json'), 'utf8'));
    expect(result.snapshots.raw).toMatch(/^\.katatay\/local\/feature\/coverage\/.*\.lcov$/);
    expect(result.snapshots.analysis).toMatch(/^\.katatay\/local\/feature\/coverage\/.*\.json$/);
  });

  it('keeps the analysis a verification made after the working output is rewritten', () => {
    const result = verifyRun();
    write('reports/source.info', 'SF:modules/a.mjs\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record\n');
    expect(run().outcome).toBe('clean');
    expect(saved().measurement.touched.uncovered).toEqual([]);
    expect(kept(result.snapshots).touched.uncovered).toEqual([{ file: 'modules/a.mjs', lines: [2] }]);
  });

  it('publishes no snapshot when run by hand', () => {
    expect(run()).not.toHaveProperty('snapshots');
    expect(existsSync(join(root, '.katatay/local'))).toBe(false);
  });

  it('refuses to build a report when the rulebook omits the checks section', () => {
    writeConfig(root, { fields: { checks: undefined } });
    expect(() => inRoot(root, () => buildReport())).toThrow('has no "checks" object');
  });

  it('refuses to build a report when testQuality omits its coverage choice', () => {
    writeConfig(root, { fields: { checks: { testQuality: { mutation: 'none' } } } });
    expect(() => inRoot(root, () => buildReport())).toThrow('no "checks.testQuality.coverage" entry');
  });

  it('passes the baseline to the coverage command', () => {
    const baseline = git('rev-parse', 'origin/main');
    configure({ command: 'echo {baseline} > reports/received-baseline; node reports/emit.cjs' });
    expect(run().outcome).toBe('clean');
    expect(readFileSync(join(root, 'reports/received-baseline'), 'utf8')).toBe(`${baseline}\n`);
  });

  it('refuses a command needing a baseline when none exists, without keeping old analysis', () => {
    expect(run().outcome).toBe('clean');
    configure({ command: 'node reports/emit.cjs {baseline}' });
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(run()).toMatchObject({ outcome: 'broken', reason: expect.stringContaining('no baseline is available for the command') });
    expect(existsSync(join(root, 'reports/checks/coverage.json'))).toBe(false);
    expect(readFileSync(join(root, 'reports/runs'), 'utf8')).toBe('run\n');
  });

  it('returns a refusal from the standalone check when coverage configuration is invalid', () => {
    const path = join(root, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.testQuality.coverage.runs = 'oncePerPlan';
    writeFileSync(path, JSON.stringify(config));
    expect(coverageCheck(root)).toEqual({ ok: false, lines: [expect.stringContaining('must run always and block on failure')] });
    expect(existsSync(join(root, 'reports/runs'))).toBe(false);
  });

  it.each(['code', 'tests', 'baseline'])('reads the original measurement with its producing baseline after %s changes', (what) => {
    const { snapshots, baseline } = verifyRun();
    if (what === 'code') write('modules/a.mjs', 'export const a = false;\n');
    if (what === 'tests') write('modules/a.test.mjs', 'changed tests\n');
    if (what === 'baseline') { git('add', '-A'); git('commit', '--quiet', '-m', 'next baseline'); markTarget(root); }
    expect(kept(snapshots, baseline).touched.uncovered).toEqual([{ file: 'modules/a.mjs', lines: [2] }]);
  });

  // The verification is the binding. A rulebook change sends the phase back
  // to verify, which makes a new analysis; the kept one stays readable.
  it('keeps analysis readable after a rulebook change, which does not move the tree', () => {
    const { snapshots } = verifyRun();
    configure({ minimum: { 'modules/': { lines: 1, branches: 0 } } });
    expect(kept(snapshots).touched.covered).toBe(1);
  });

  it('keeps analysis valid while the change file is written', () => {
    const { snapshots } = verifyRun();
    write('requirements/changes/20261102T000000.000Z__example.md', '# Recorded change\n');
    expect(kept(snapshots).touched.covered).toBe(1);
  });

  it('keeps below-minimum findings and refuses them as successful evidence', () => {
    configure({ minimum: { 'modules/': { lines: 100, branches: 0 } } });
    const result = verifyRun();
    expect(result.outcome).toBe('findings');
    expect(saved().measurement.failures[0]).toContain('below the minimum');
    expect(() => kept(result.snapshots)).toThrow('not successful');
  });

  it('publishes no snapshot when the analysis could not be made', () => {
    write('reports/source.info', 'all green');
    const result = verifyRun();
    expect(result.outcome).toBe('broken');
    expect(result).not.toHaveProperty('snapshots');
    expect(existsSync(join(root, '.katatay/local'))).toBe(false);
  });

  it('publishes no snapshot when the command changes the tree during the check', () => {
    write('reports/emit.cjs', "require('fs').writeFileSync('modules/a.mjs', 'changed'); process.stdout.write(require('fs').readFileSync('reports/source.info'));\n");
    let published = false;
    const result = runCoverageCheck(configuredCoverage(root), root, { publish: () => { published = true; return {}; } });
    expect(result).toMatchObject({ outcome: 'broken', reason: expect.stringContaining('changed during the check') });
    expect(published).toBe(false);
  });

  it('reports a publish failure as a broken check', () => {
    const check = configuredCoverage(root);
    const result = runCoverageCheck(check, root, { publish: () => { throw new Error('disk full'); } });
    expect(result).toMatchObject({ outcome: 'broken', reason: 'coverage could not be saved: disk full' });
  });

  it('invalidates saved analysis before a failing test command', () => {
    const path = join(root, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.testQuality = { lint: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json' }, ...config.checks.testQuality };
    config.tests.run.command = 'exit 1';
    writeFileSync(path, JSON.stringify(config));
    write('reports/lint.json', 'earlier lint findings');
    expect(run().outcome).toBe('clean');
    runTestCommand({ root, shown: false });
    expect(existsSync(join(root, 'reports/checks/coverage.json'))).toBe(false);
    expect(readFileSync(join(root, 'reports/lint.json'), 'utf8')).toBe('earlier lint findings');
  });

  it('leaves ordinary check output alone when tests run without a coverage check', () => {
    writeConfig(root, { adapter: { run: { command: 'exit 1', reportPaths: ['reports/junit/*.xml'], tagComment: '^\\s*//' } },
      fields: { checks: { testQuality: { mutation: 'none', coverage: 'none', lint: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json' } } } } });
    write('reports/lint.json', 'earlier lint findings');
    runTestCommand({ root, shown: false });
    expect(readFileSync(join(root, 'reports/lint.json'), 'utf8')).toBe('earlier lint findings');
  });
});

describe('check output destinations', () => {
  it.each(['/absolute.json', 'reports/../outside.json', './reports/result.json', 'reports/*.json', '.katatay/result.json'])('rejects invalid output path %s even when called directly', (path) => {
    expect(() => checkedOutput(path, root)).toThrow('one repository-relative output file');
  });

  it('refuses tracked or unignored files without deleting them', () => {
    write('source.json', 'source');
    expect(() => checkedOutput('source.json', root)).toThrow('ignored');
    write('reports/tracked.json', 'tracked'); git('add', '-f', 'reports/tracked.json');
    expect(() => invalidateOutput({ output: 'reports/tracked.json' }, root)).toThrow('tracks');
    expect(readFileSync(join(root, 'reports/tracked.json'), 'utf8')).toBe('tracked');
  });

  it('refuses symlink components and non-file destinations', () => {
    symlinkSync(join(root, 'modules'), join(root, 'reports/link'));
    expect(() => checkedOutput('reports/link/a.mjs', root)).toThrow('symbolic link');
    symlinkSync(join(root, 'modules/a.mjs'), join(root, 'reports/file'));
    expect(() => checkedOutput('reports/file', root)).toThrow('symbolic link');
    expect(() => checkedOutput('reports', root)).toThrow('not a file');
  });

  it('saves an ordinary check result in the shared envelope', () => {
    writeConfig(root, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: { command: 'echo findings; exit 1',
      exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json', runs: 'oncePerPlan' } } } } });
    const check = readChecks(root).codeQuality[0];
    expect(runCheck(check, { root }).outcome).toBe('findings');
    expect(readFileSync(join(root, check.output))).toEqual(Buffer.from(
      '{"version":1,"name":"lint","result":{"outcome":"findings","exitCode":1,"text":"findings","reason":"findings (exit 1)"}}\n'));
  });

  it('preserves the previous output and linked file when the temporary name is already in use', () => {
    const check = { name: 'lint', output: 'reports/lint.json' };
    const id = 'c0ffee00-0000-4000-8000-000000000000';
    write(check.output, 'previous result');
    write('reports/sentinel', 'another file');
    linkSync(join(root, 'reports/sentinel'), join(root, check.output + '.' + id + '.tmp'));
    const identity = checkIdentity(root);
    randomUUID.mockReturnValueOnce(id);
    expect(() => saveCheckOutput(check, { outcome: 'clean', code: 0, text: '', reason: 'passed' }, identity, root))
      .toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(join(root, 'reports/sentinel'), 'utf8')).toBe('another file');
    expect(readFileSync(join(root, check.output), 'utf8')).toBe('previous result');
  });

  it('refuses, and runs no command, when ordinary check output is unsafe', () => {
    writeConfig(root, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: { command: 'echo ran > reports/ran',
      exitCodes: { 0: 'clean', 1: 'findings' }, output: 'source.json' } } } } });
    write('source.json', 'source');
    expect(() => runCheck(readChecks(root).codeQuality[0], { root })).toThrow('output must be ignored');
    expect(readFileSync(join(root, 'source.json'), 'utf8')).toBe('source');
    expect(existsSync(join(root, 'reports/ran'))).toBe(false);
  });

  it('refuses, and publishes no ordinary check result, if the command changes the tree', () => {
    writeConfig(root, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: { command: 'echo changed > modules/a.mjs',
      exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json' } } } } });
    write('reports/lint.json', 'old success');
    expect(() => runCheck(readChecks(root).codeQuality[0], { root })).toThrow('changed during the check');
    expect(existsSync(join(root, 'reports/lint.json'))).toBe(false);
  });

  it('rejects a result captured against a different identity', () => {
    const check = configuredCoverage(root);
    const identity = checkIdentity(root);
    write('modules/new.mjs', 'changed');
    expect(() => saveCheckOutput(check, { outcome: 'clean', code: 0, text: '', reason: 'clean' }, identity, root)).toThrow('changed during the check');
  });

  it.each(['missing identity', 'baseline', 'rulebook'])('refuses to publish with a stale or missing identity: %s', field => {
    const check = configuredCoverage(root);
    const identity = field === 'missing identity' ? null : { ...checkIdentity(root), [field]: '0'.repeat(field === 'baseline' ? 40 : 64) };
    expect(() => saveCheckOutput(check, { outcome: 'clean' }, identity, root)).toThrow(check.name + ': the tree, baseline or rulebook changed during the check');
    expect(existsSync(join(root, check.output))).toBe(false);
  });
});

describe('repository scope', () => {
  it.each([false, true])('restores the caller directory after a callback (throws: %s)', (throws) => {
    const cwd = process.cwd();
    const failure = new Error('callback failed');
    const read = () => {
      expect(process.cwd()).toBe(root);
      if (throws) throw failure;
      return 'read in fixture';
    };
    try {
      if (throws) expect(() => inRoot(root, read)).toThrow(failure);
      else expect(inRoot(root, read)).toBe('read in fixture');
      expect(process.cwd()).toBe(cwd);
    } finally { process.chdir(cwd); }
  });
});
