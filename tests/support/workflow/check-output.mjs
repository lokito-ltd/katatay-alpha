import { afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repositoryRulebook, writeConfig } from '../../fixtures/workflow/adapter.mjs';
import { markTarget } from '../../fixtures/workflow/target.mjs';
import { configuredCoverage, runCoverageCheck } from '../../../src/workflow/coverage.mjs';
import { readCoverageSnapshot, writeCoverageSnapshot } from '../../../src/workflow/coverage-snapshot.mjs';
import { checkIdentity } from '../../../src/workflow/check-output.mjs';

export const LCOV = 'SF:modules/a.mjs\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n';
export let root;
export const write = (file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
export const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export const configure = (over = {}) => {
  writeConfig(root, { adapter: { run: { command: 'true', reportPaths: ['reports/junit/*.xml'], tagComment: '^\\s*//' } },
    fields: { checks: { testQuality: { mutation: 'none', coverage: { ...repositoryRulebook().checks.testQuality.coverage, command: 'node reports/emit.cjs',
      minimum: { 'modules/': { lines: 0, branches: 0 } }, ...over } } } } });
  return configuredCoverage(root);
};
export const run = () => runCoverageCheck(configuredCoverage(root), root);
/** The fixture's branch, where verify keeps its snapshots. */
export const BRANCH = 'feature';
/** The coverage check as verify runs it, keeping its snapshots. */
export const verifyRun = () => runCoverageCheck(configuredCoverage(root), root,
  { publish: (raw, analysis) => writeCoverageSnapshot(BRANCH, { raw, analysis }, root) });
export const kept = (snapshots, baseline = checkIdentity(root).baseline) => readCoverageSnapshot(BRANCH, snapshots, baseline, root);
export const saved = () => JSON.parse(readFileSync(join(root, 'reports/checks/coverage.json'), 'utf8'));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'check-analysis-')));
  git('init', '--quiet', '--initial-branch', 'feature');
  git('remote', 'add', 'origin', join(root, '.no-such-remote'));
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('.gitignore', 'reports/\ncoverage/\n');
  configure();
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  markTarget(root);
  write('modules/a.mjs', 'export const a = true;\nexport const b = false;\n');
  write('reports/source.info', LCOV);
  write('reports/emit.cjs', "const fs = require('fs'); fs.appendFileSync('reports/runs', 'run\\n'); process.stdout.write(fs.readFileSync('reports/source.info')); console.error('diagnostic');\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
