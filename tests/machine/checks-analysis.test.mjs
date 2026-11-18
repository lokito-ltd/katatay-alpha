import { readBaseline } from '../../src/workflow/phase.mjs';
import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, events, approvedChange, approvePlan, cli, git, publish, FIXTURE_SUMMARY, machineFixture, phase, prompt, setCoverage, setMutate, stop, submitFixtureAnalysis, submitText, triage } from '../support/machine/harness.mjs';
import { append, readChain } from '../../src/workflow/chain.mjs';
import { survivor, verifiedWithGaps } from '../support/machine/gaps.mjs';
import { coverageMeasurement } from '../../src/workflow/result-readers.mjs';
import { analysisSummary } from '../../src/workflow/checks-analysis.mjs';
import { publishSnapshot } from '../../src/workflow/local-snapshot.mjs';
import { verificationSummary } from '../../src/workflow/verification-summary.mjs';

machineFixture({ approved: true });
const read = name => JSON.parse(readFileSync(join(ctx.logbook, events().filter(file => file.endsWith('__' + name + '.json')).at(-1)), 'utf8'));
const said = () => prompt('record').hookSpecificOutput.additionalContext;
const proposed = 'Coverage modules/feature.mjs:2\nScenario: Call off().\nAssert: It returns false.\n\n'
  + 'Mutants modules/feature.mjs:1\nVariant 1\nScenario: Read on.\nAssert: It is true.';

const evidenceFolders = { tests: 'junit/analysis', coverage: 'coverage', mutation: 'mutation/findings', scan: 'checks/analysis' };

function verifiedWithSavedChecks(requireAnalysis = true) {
  setCoverage({ 'modules/feature.mjs': { total: 1, uncovered: [] } });
  setMutate(survivor());
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path));
  config.checks.requireAnalysis = requireAnalysis;
  config.checks.codeQuality = { scan: { command: 'echo scanned', exitCodes: { 0: 'clean', 1: 'findings' },
    runs: 'oncePerPlan', output: 'reports/scan.json' } };
  writeFileSync(path, JSON.stringify(config));
  git('add', 'coverage.lcov', '.katatay/rulebook.json');
  git('commit', '--quiet', '-m', 'configure fixture checks and frozen coverage input');
  publish();
  approvePlan();
  mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
  writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\n');
  const frozenRun = cli('workflow.mjs', 'triage');
  expect(frozenRun.status, frozenRun.stderr).toBe(0);
  expect(stop().reason).toContain('Verification passed');
  return read('verified').payload;
}

// Publish the exact altered bytes under their own digest, then let append link
// the changed receipt to its predecessor. Neither artifact is overwritten.
function replaceAnalysisVersion(payload, name, version) {
  const result = payload.results.find(item => item.name === name);
  const evidence = result.evidence.find(item => item.role === 'analysis');
  const original = JSON.parse(readFileSync(join(ctx.repo, evidence.snapshot)));
  const bytes = Buffer.from(JSON.stringify({ ...original, version }));
  evidence.snapshot = publishSnapshot('feat/x', { folder: evidenceFolders[name], extension: 'json' }, bytes, ctx.repo);
  return { path: evidence.snapshot, bytes };
}

it.each([
  ['mutation', 2, 'mutation analysis.version has unsupported schema version 2'],
  ['coverage', undefined, 'coverage analysis.version is missing'],
  ['scan', '1', 'check analysis.version has unsupported schema version "1"'],
  ['tests', null, 'test analysis.version has unsupported schema version null'],
])('identifies invalid %s evidence in checks analysis and record', (name, version, diagnostic) => {
  const payload = verifiedWithSavedChecks();
  const evidence = replaceAnalysisVersion(payload, name, version);
  const receipt = append(ctx.logbook, 'verified', payload, 'feat/x');
  const before = events();
  if (name !== 'tests') {
    const summary = verificationSummary(receipt, { branch: 'feat/x', root: ctx.repo, dir: ctx.logbook }).replace(/\s+/g, ' ');
    expect(summary).toContain(evidence.path);
    expect(summary).toContain(diagnostic);
    if (name === 'coverage') expect(summary).not.toContain('no baseline');
  }
  const attempt = submitText(receipt.seq, proposed);
  expect(attempt.status).toBe(1);
  expect(attempt.stderr).toContain(evidence.path);
  expect(attempt.stderr).toContain(diagnostic);
  expect(events()).toEqual(before);
  const reply = said().replace(/\s+/g, ' ');
  expect(reply).toContain(evidence.path);
  expect(reply).toContain(diagnostic);
  expect(events()).toEqual(before);
  expect(phase()).toBe('verified');
});

it('recovers all four saved checks by running verification under a fresh approval', () => {
  const payload = verifiedWithSavedChecks(false);
  const invalid = Object.keys(evidenceFolders).map(name => replaceAnalysisVersion(payload, name, undefined));
  append(ctx.logbook, 'verified', payload, 'feat/x');
  const before = events();
  const refused = said().replace(/\s+/g, ' ');
  for (const artifact of invalid) expect(refused).toContain(artifact.path);
  expect(events()).toEqual(before);

  approvePlan({ plan: '# Restore check evidence\n\nRun every check under this approval.' });
  const run = cli('workflow.mjs', 'triage');
  expect(run.status, run.stderr).toBe(0);
  expect(stop().reason).toContain('Verification passed');
  const fresh = read('verified');
  for (const name of Object.keys(evidenceFolders)) {
    const result = fresh.payload.results.find(item => item.name === name);
    expect(['ok', 'partial']).toContain(result.status);
    const analysis = result.evidence.find(item => item.role === 'analysis');
    expect(JSON.parse(readFileSync(join(ctx.repo, analysis.snapshot))).version).toBe(1);
  }
  expect(said()).toMatch(/declared|held/i);
  for (const artifact of invalid) expect(readFileSync(join(ctx.repo, artifact.path))).toEqual(artifact.bytes);
});

it('keeps the missing-analysis attempt separate from a hold and from the operator’s override', () => {
  verifiedWithGaps();
  const receipt = read('verified');
  const coverage = receipt.payload.results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(result => result.name === 'coverage');
  expect(coverage.summary).not.toHaveProperty('touched');
  expect(coverageMeasurement(coverage, { branch: 'feat/x', root: ctx.repo, live: readChain(ctx.logbook, 'feat/x').entries, before: receipt.seq,
    baseline: readBaseline(receipt.payload.baseline), rulebookFingerprint: receipt.payload.rulebookFingerprint }).touched.uncovered).toEqual([{ file: 'modules/feature.mjs', lines: [2] }]);
  const before = events();
  expect(said()).toContain('needs its checks analysis');
  expect(events()).toEqual(before);
  const invalid = submitText(receipt.seq, FIXTURE_SUMMARY + '\n\n' + proposed); // missing the referee’s limitations
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toMatch(/missing Limit .*No analysis recorded/);
  expect(events()).toEqual(before);
  rmSync(join(ctx.repo, 'reports/mutation/mutation.json'));
  rmSync(join(ctx.repo, 'reports/coverage.info'));
  const text = submitFixtureAnalysis(proposed + '\n');
  const accepted = read('checks_analysis');
  expect(accepted.payload).toEqual({ verification: receipt.seq,
    summary: FIXTURE_SUMMARY.slice('Summary: '.length), analysisSnapshot: expect.stringMatching(/^\.katatay\/local\/feat_x\/checks-analysis\//) });
  // The full text stays out of the logbook. Its file ends with every
  // evidence item the receipt's results name, the ones the agent was told to read.
  const listed = receipt.payload.results.flatMap(result => result.evidence.map(item => `- ${result.name}, ${item.title}: ${item.snapshot}`));
  expect(listed.length).toBeGreaterThan(0);
  expect(readFileSync(join(ctx.repo, accepted.payload.analysisSnapshot), 'utf8')).toBe(`${text}\n\nEvidence\n${listed.join('\n')}\n`);
  expect(JSON.stringify(accepted)).not.toContain('Scenario: Call off().');
  // What the operator is shown links to the event, and the event names the
  // snapshot holding the full analysis.
  const shown = analysisSummary({ text, seq: receipt.seq, link: `.katatay/state/feat_x/${events().at(-1)}` });
  const link = /^Full analysis: (.+)$/m.exec(shown)[1];
  expect(JSON.parse(readFileSync(join(ctx.repo, link), 'utf8'))).toEqual(accepted);
  for (const [input, status] of [[text, 0], [text + 'other', 1]]) {
    const run = submitText(receipt.seq, input);
    expect(run.status).toBe(status);
    expect(run.stdout).toBe(shown + '\n');
    if (status) expect(run.stderr).toContain('already accepted');
  }
  expect(events()).toHaveLength(before.length + 1);
  const held = said();
  expect(held).toContain(shown);
  expect(held).not.toContain('Scenario: Call off().');
  expect(read('record_held').payload.treeFingerprint).toBe(receipt.payload.treeFingerprint);
  expect(phase()).toBe('verified');
  expect(said()).toContain('The operator declared this change finished');
});

it('requires the newest verification even if the tree fingerprint repeats', () => {
  approvedChange();
  triage();
  stop();
  submitFixtureAnalysis();
  const older = read('verified');
  const fresh = append(ctx.logbook, 'verified', older.payload, 'feat/x');
  expect(submitText(older.seq, 'stale').stderr).toContain('not the current receipt');
  expect(said()).toContain(`Verification ${fresh.seq} needs its checks analysis`);
  submitFixtureAnalysis();
  writeFileSync(join(ctx.repo, 'source.txt'), 'edit after verification');
  expect(submitText(fresh.seq, 'stale').stderr).toContain('not the current receipt');
  expect(said()).toContain('Restore the triaged implementation');
});

it('refuses a receipt without results before it can supersede the current verification', () => {
  approvedChange(); triage(); stop();
  const receipt = read('verified');
  const { results, ...incomplete } = receipt.payload;
  expect(() => append(ctx.logbook, 'verified', incomplete, 'feat/x')).toThrow('results is missing');
  expect(read('verified')).toEqual(receipt);
});

it('refuses the earlier analysis after the rulebook switches mutation off', () => {
  approvedChange();
  mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
  writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\nexport const off = () => false;\n');
  triage();
  setCoverage({ 'modules/feature.mjs': { total: 2, uncovered: [2] } });
  setMutate(survivor());
  const request = stop().reason;
  expect(phase()).toBe('verified');
  const headings = request.split('Then use these entry headings verbatim, each on its own line:\n')[1].split('\n\n')[0].split('\n');
  expect(headings).toContain('Mutants modules/feature.mjs:1');
  const body = headings.map(heading => heading.startsWith('Limit ') ? `${heading}\nImpact: Not measured on this pass.`
    : heading.startsWith('Mutants ') ? heading : `${heading}\nScenario: Call the feature.\nAssert: It answers.`);
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const rulebook = JSON.parse(readFileSync(path));
  rulebook.checks.testQuality.mutation = 'none';
  writeFileSync(path, JSON.stringify(rulebook));
  const receipt = read('verified');
  const run = submitText(receipt.seq, [FIXTURE_SUMMARY, ...body].join('\n\n'));
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('not the current receipt');
  expect(phase()).toBe('converging');
  expect(said()).toContain('The rulebook changed');
  expect(events().some(file => file.endsWith('__checks_analysis.json'))).toBe(false);
  expect(stop().reason).toContain('Verification passed');
  const fresh = read('verified');
  expect(fresh.payload.treeFingerprint).toBe(receipt.payload.treeFingerprint);
  expect(fresh.payload.rulebookFingerprint).not.toBe(receipt.payload.rulebookFingerprint);
});
