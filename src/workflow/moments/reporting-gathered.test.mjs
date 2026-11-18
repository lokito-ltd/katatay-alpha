import { readBaseline } from '../phase.mjs';
/**
 * The change report gathered in this process, against the same fixture as
 * `reporting-at-record.test.mjs`, which starts it through the hooks. Here so
 * coverage sees the part of `buildReport` that reads git, the logbook and the
 * adapter, and mutation testing can run these cases: it leaves out a file that
 * reaches the code only through processes, and those cases do.
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analysisPath } from '../../../tests/fixtures/workflow/events.mjs';
import { append, fileFor, sha256 } from '../chain.mjs';
import { verifiedPayload, ctx, fixtureJUnit, git, approvedChange, machineFixture, setCoverage, triage } from '../../../tests/support/machine/harness.mjs';
import { testResult, coverageSummary, mutationSummary } from '../../../tests/fixtures/workflow/quality-results.mjs';
import { writeCoverageSnapshot } from '../coverage-snapshot.mjs';
import { writeMutationSnapshot } from '../mutation-snapshot.mjs';
import { publishSnapshot } from '../local-snapshot.mjs';
import { checkDocument } from '../result-format.mjs';
import { reportFor } from '../checks-report.mjs';
import { findingsOf } from '../../evidence/mutation-report.mjs';
import { mutant, reportOf } from '../../../tests/fixtures/workflow/mutation-report.mjs';
import { writeTriageSnapshot } from '../triage-snapshot.mjs';
import { current } from '../state.mjs';
import { fingerprint } from '../tree.mjs';
import { buildReport, summaryLines } from '../../evidence/report.ts';

machineFixture({ approved: true });

/**
 * `buildReport` called in this process, against the fixture, so coverage sees
 * the part that reads git, the logbook and the adapter. `reporting-at-record`
 * starts it as the hook does, in a process of its own. Refused unless the move into the
 * fixture took, as in `deciding.test.mjs`: run here, it would read the real
 * repository.
 */
function inFixture(read) {
  const cwd = process.cwd();
  const home = process.env.HOME;
  process.chdir(ctx.repo);
  try {
    if (realpathSync(process.cwd()) !== realpathSync(ctx.repo)) throw new Error('not in the fixture repository — refusing to read anything');
    process.env.HOME = ctx.home;
    return read();
  } finally {
    process.chdir(cwd);
    process.env.HOME = home;
  }
}

// Construct the receipt a successful verification would write for these report bytes.
function verifiedWorkingReport() {
  const xml = readFileSync(join(ctx.repo, 'reports/junit/run.xml'));
  append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ junit: fixtureJUnit(xml) })), 'feat/x');
}

/**
 * Coverage switched on, then the analysis a verification of this tree would
 * keep, with line 2 of the feature uncovered. Returns the tree and the
 * snapshot references, for a receipt to name.
 */
function keptCoverage() {
  setCoverage({ 'modules/feature.mjs': { total: 2, uncovered: [2] } });
  const figure = (covered, total) => ({ covered, total, measured: total ? Math.floor((covered * 1000) / total) : 1000, minimum: 0 });
  const analysis = { version: 1, name: 'coverage',
    result: { outcome: 'clean', exitCode: 0, text: '', reason: 'every folder is at or above its minimum' },
    measurement: { folders: [{ folder: 'modules/', files: 1, lines: figure(1, 2), branches: figure(0, 0) }], failures: [],
      touched: { covered: 1, total: 2, uncovered: [{ file: 'modules/feature.mjs', lines: [2] }] } } };
  const coverage = writeCoverageSnapshot('feat/x', { raw: 'SF:modules/feature.mjs\nend_of_record\n', analysis: JSON.stringify(analysis) }, ctx.repo);
  return { coverage };
}

function keptMutation(mutants = [mutant('Survived')]) {
  const raw = JSON.stringify(reportOf(mutants));
  const run = { raw, status: 1, outcome: 'survived', report: 'original mutation report', findings: findingsOf(JSON.parse(raw)) };
  const snapshots = writeMutationSnapshot('feat/x', run, ctx.repo);
  return { run, evidence: { snapshots } };
}

/** A unified mutation result naming a kept run. */
const mutationOk = (mutation, raw = mutation.evidence.snapshots.raw) => ({ name: 'mutation', status: 'ok',
  summary: mutationSummary(mutation.run.findings), evidence: [
    { role: 'raw', title: 'Raw mutation results', snapshot: raw },
    { role: 'analysis', title: 'Mutation findings and limitations', snapshot: mutation.evidence.snapshots.findings }] });

/** Unified results naming whichever evidence is given; the rest skipped, as
 *  a skip, with `mutationSkip` as the mutation skip's reason. */
function resultsOf({ junit, coverage, mutation, mutationSkip } = {}) {
  const skipped = (name, reason = 'Not measured by this case.') => ({ name, status: 'skipped', reason, evidence: [], summary: {} });
  return [
    junit ? testResult('feat/x', junit, ctx.repo) : skipped('tests'),
    coverage ? { name: 'coverage', status: 'ok', summary: coverageSummary(JSON.parse(readFileSync(join(ctx.repo, coverage.coverage.analysis), 'utf8')).measurement), evidence: [
      { role: 'raw', title: 'Raw LCOV coverage', snapshot: coverage.coverage.raw },
      { role: 'analysis', title: 'Coverage thresholds and changed lines', snapshot: coverage.coverage.analysis }] } : skipped('coverage'),
    mutation ? mutationOk(mutation) : skipped('mutation', mutationSkip),
  ];
}

/** Unified results naming kept evidence, as a verification writes them. */
function unifiedChecks({ coverage, mutation, junit, mutationResult }) {
  const summary = coverageSummary(JSON.parse(readFileSync(join(ctx.repo, coverage.coverage.analysis), 'utf8')).measurement);
  return [
    testResult('feat/x', junit, ctx.repo),
    { name: 'coverage', status: 'ok', summary, evidence: [
      { role: 'raw', title: 'Raw LCOV coverage', snapshot: coverage.coverage.raw },
      { role: 'analysis', title: 'Coverage thresholds and changed lines', snapshot: coverage.coverage.analysis }] },
    mutationResult ?? { name: 'mutation', status: 'ok', summary: mutationSummary(mutation.run.findings), evidence: [
      { role: 'raw', title: 'Raw mutation results', snapshot: mutation.evidence.snapshots.raw },
      { role: 'analysis', title: 'Mutation findings and limitations', snapshot: mutation.evidence.snapshots.findings }] },
  ];
}

describe('the change report, gathered', () => {

  it('reads a receipt from its unified results', () => {
    approvedChange();
    triage();
    const coverage = keptCoverage();
    const mutation = keptMutation();
    const junit = fixtureJUnit();
    append(ctx.logbook, 'verified', verifiedPayload(unifiedChecks({ coverage, mutation, junit })), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.incomplete).toEqual([]);
    expect(d.mutation.findings).toEqual(mutation.run.findings);
    expect(d.coverage).toEqual({ covered: 1, total: 2, uncovered: [{ file: 'modules/feature.mjs', lines: [2] }] });
    expect(d.tests).toBeDefined();
  });

  it('identifies only the ordinary check whose saved schema is unreadable', () => {
    approvedChange();
    triage();
    const checks = unifiedChecks({ coverage: keptCoverage(), mutation: keptMutation(), junit: fixtureJUnit() });
    const savedCheck = (name, version) => {
      const doc = checkDocument(name, { outcome: 'clean', code: 0, text: '', reason: 'Clean.' });
      const bytes = Buffer.from(JSON.stringify({ ...doc, version }));
      const snapshot = publishSnapshot('feat/x', { folder: 'checks/analysis', extension: 'json' }, bytes, ctx.repo);
      return { name, status: 'ok', summary: { outcome: 'clean', exitCode: 0 },
        evidence: [{ role: 'analysis', title: name + ' result', snapshot }] };
    };
    checks.push(savedCheck('lint', 1), { name: 'format', status: 'skipped', reason: 'Disabled.', evidence: [], summary: {} });
    for (const version of [1, undefined, null, '1']) {
      const scan = savedCheck('scan', version);
      append(ctx.logbook, 'verified', verifiedPayload([...checks, scan]), 'feat/x');
      const issues = inFixture(() => buildReport()).incomplete;
      if (version === 1) expect(issues).toEqual([]);
      else {
        const problem = version === undefined ? 'is missing' : `has unsupported schema version ${JSON.stringify(version)} (expected 1)`;
        expect(issues).toEqual([{ section: 'scan', reason: `${scan.evidence[0].snapshot}: check analysis.version ${problem}` }]);
      }
    }
  });

  it.each(['ok', 'partial'])('compares reused test evidence with its producer’s %s status', status => {
    approvedChange();
    triage();
    const checks = unifiedChecks({ coverage: keptCoverage(), mutation: keptMutation(), junit: fixtureJUnit() });
    // The test analysis describes a complete run. Only an ok producer agrees with those bytes.
    checks.find(result => result.name === 'tests').status = status;
    const original = append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    const source = { seq: original.seq, fingerprint: sha256(readFileSync(join(ctx.logbook, fileFor(original)))) };
    const reused = checks.map(result => result.name === 'tests' ? { ...result, status: 'reused', source } : result);
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(reused), 'feat/x');
    const report = inFixture(() => buildReport());
    if (status === 'ok') {
      expect(report.incomplete).toEqual([]);
      expect(report.tests).toEqual({ added: 0, modified: 0, removed: 0 });
    } else {
      expect(report.incomplete).toEqual([{ section: 'verified JUnit', reason: `Verification ${receipt.seq}: Test summary or status differs from its evidence. Restore the exact evidence or obtain a fresh workflow verification.` }]);
      expect(report.tests).toBeUndefined();
    }
  });

  it.each(['baseline', 'rulebook'])('requires a fresh receipt for the current report after only the %s changes', field => {
    approvedChange();
    triage();
    const checks = unifiedChecks({ coverage: keptCoverage(), mutation: keptMutation(), junit: fixtureJUnit() });
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    if (field === 'baseline') {
      git('commit', '--allow-empty', '--quiet', '-m', 'same files, new baseline');
      append(ctx.logbook, 'baseline_moved', { from: readBaseline(receipt.payload.baseline), to: git('rev-parse', 'HEAD').trim() }, 'feat/x');
    } else {
      appendFileSync(join(ctx.repo, '.katatay/rulebook.json'), '\n');
    }
    inFixture(() => {
      const state = current();
      expect(state.treeFingerprint).toBe(receipt.payload.treeFingerprint);
      expect(buildReport().incomplete).toContainEqual({ section: 'verified JUnit', reason: 'No verification for the current tree and approval. Run workflow verification.' });
      expect(reportFor(receipt, state.live).coverage.uncovered).toEqual([{ file: 'modules/feature.mjs', line: 2 }]);
    });
  });

  it('reports a skipped unified mutation result as not checked, and a missing tests result as incomplete', () => {
    approvedChange();
    triage();
    const coverage = keptCoverage();
    const mutation = keptMutation();
    const junit = fixtureJUnit();
    const skip = 'Mutation testing deferred: insufficient time.';
    const checks = unifiedChecks({ coverage, mutation, junit,
      mutationResult: { name: 'mutation', status: 'skipped', reason: skip, evidence: [], summary: {} } });
    checks[checks.findIndex(item => item.name === 'tests')] = { name: 'tests', status: 'skipped', reason: 'An earlier step stopped verification.', evidence: [], summary: {} };
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.mutation).toBeNull();
    expect(d.notChecked).toContain(skip);
    expect(d.incomplete).toContainEqual({ section: 'verified JUnit', reason: `Verification ${receipt.seq}: The verification's tests result is skipped: `
      + 'An earlier step stopped verification. Restore the exact evidence or obtain a fresh workflow verification.' });
  });

  it('reports unreadable unified mutation evidence and a skipped coverage result as incomplete, naming each', () => {
    approvedChange();
    triage();
    const coverage = keptCoverage();
    const mutation = keptMutation();
    const checks = unifiedChecks({ coverage, mutation, junit: fixtureJUnit() });
    checks[checks.findIndex(item => item.name === 'coverage')] = { name: 'coverage', status: 'skipped', reason: 'Skipped by this case.', evidence: [], summary: {} };
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    unlinkSync(join(ctx.repo, mutation.evidence.snapshots.findings));
    const d = inFixture(() => buildReport());
    expect(d.mutation).toBeUndefined();
    expect(d.incomplete).toContainEqual({ section: 'mutation', reason: expect.stringMatching(
      new RegExp(`^mutation: verification ${receipt.seq}: mutation findings \\(.*\\): ENOENT.*\\. Restore the exact evidence or obtain a fresh workflow verification\\.$`)) });
    expect(d.incomplete).toContainEqual({ section: 'coverage', reason: `coverage: verification ${receipt.seq}: `
      + "The verification's coverage result is skipped: Skipped by this case. Restore the exact evidence or obtain a fresh workflow verification." });
  });

  it('measures a reused unified mutation result against the tree of the verification that produced it', () => {
    approvedChange();
    triage();
    const coverage = keptCoverage();
    const mutation = keptMutation();
    const junit = fixtureJUnit();
    const checks = unifiedChecks({ coverage, mutation, junit });
    const original = append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    writeFileSync(join(ctx.repo, 'later.test.mjs'), '// a later test\n');
    const later = keptCoverage();
    const reused = { ...structuredClone(checks.find(item => item.name === 'mutation')), status: 'reused', reason: 'Runs once per approved plan.',
      source: { seq: original.seq, fingerprint: sha256(readFileSync(join(ctx.logbook, fileFor(original)))) } };
    const next = unifiedChecks({ coverage: later, mutation, junit, mutationResult: reused });
    append(ctx.logbook, 'verified', verifiedPayload(next), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.mutation).toMatchObject({ findings: mutation.run.findings, earlier: true });
    expect(summaryLines(d).join('\n')).toContain('mutants: 0 caught, 1 survived (earlier tree)');
  });

  it('identifies the missing baseline and the recovery action before triage', () => {
    approvedChange();
    const report = inFixture(() => buildReport());
    expect(report.tests).toBeUndefined();
    expect(report.incomplete).toContainEqual({ section: 'verified JUnit', reason: 'No verification for the current tree and approval. Run workflow verification.' });
    expect(report.incomplete).toContainEqual({ section: 'mutation', reason: 'mutation: no verification for the current tree and approval. Run workflow verification.' });
    expect(report.notChecked.join(' ')).not.toContain('has not run for this plan');
    expect(report.incomplete).toContainEqual({ section: 'tests', reason: 'No triage under the current approval. Run triage to measure the baseline tests.' });
  });

  it('distinguishes an omitted verified test file from a test removed by the change', () => {
    approvedChange();
    const files = ['first.test.mjs', 'second.test.mjs', 'third.test.mjs'];
    for (const file of files) writeFileSync(join(ctx.repo, file), "it('works', () => {});");
    triage({ list: { tests: files.map(file => ({ file, titles: ['works'] })), unlisted: [] } });
    const dir = join(ctx.repo, 'reports/junit');
    mkdirSync(dir, { recursive: true });
    const writeRun = names => writeFileSync(join(dir, 'run.xml'), '<testsuites>' +
      names.map(file => `<testcase file="${file}" name="works"/>`).join('') + '</testsuites>');
    writeRun(files.slice(0, 1));
    verifiedWorkingReport();
    const partial = inFixture(() => buildReport());
    expect(partial.incomplete).toContainEqual({ section: 'verified JUnit', reason: expect.stringContaining('omit test files: second.test.mjs, third.test.mjs') });
    expect(partial.tests).toBeUndefined();
    writeRun(files);
    verifiedWorkingReport();
    const complete = inFixture(() => buildReport());
    expect(complete.tests).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(complete.incomplete.map(i => i.section)).not.toContain('tests');
  });

  it('reports a recorded mutation skip', () => {
    approvedChange();
    triage();
    const skip = 'Mutation testing deferred: insufficient time.';
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutationSkip: skip })), 'feat/x');
    const skipped = inFixture(() => buildReport());
    expect(skipped.incomplete.map(i => i.section)).not.toContain('mutation');
    expect(skipped.notChecked).toContain(skip);
  });

  it('takes mutation from the current receipt even when the working report disagrees', () => {
    approvedChange();
    triage();
    const kept = keptMutation();
    const { run } = kept;
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: kept })), 'feat/x');
    mkdirSync(join(ctx.repo, 'reports/mutation'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/mutation/mutation.json'), JSON.stringify(reportOf()));
    const d = inFixture(() => buildReport());
    expect(d.mutation).toMatchObject({ outcome: 'survived', findings: run.findings, earlier: false });
    expect(d.mutation.report).toContain('original mutation report');
    expect(d.incomplete.map(item => item.section)).not.toContain('mutation');
  });

  it('does not borrow earlier mutation evidence when the selected receipt skips it', () => {
    approvedChange();
    triage();
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: keptMutation() })), 'feat/x');
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutationSkip: 'Skipped on this pass.' })), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.mutation).toBeNull();
    expect(d.notChecked).toContain('Skipped on this pass.');
  });

  it('rejects individually valid snapshots from different runs instead of falling back to earlier usable evidence', () => {
    approvedChange();
    triage();
    const first = keptMutation();
    const second = keptMutation([mutant('Survived', { id: 'other', replacement: 'false' })]);
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: first })), 'feat/x');
    const mixed = resultsOf();
    mixed[mixed.findIndex(item => item.name === 'mutation')] = mutationOk(second, first.evidence.snapshots.raw);
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(mixed), 'feat/x');
    const reason = `mutation: verification ${receipt.seq}: Mutation findings do not match the raw report. Restore the exact evidence or obtain a fresh workflow verification.`;
    const d = inFixture(() => buildReport());
    expect(d.mutation).toBeUndefined();
    expect(d.incomplete).toContainEqual({ section: 'mutation', reason });
    expect(() => inFixture(() => reportFor(receipt, current().live))).toThrow('Mutation findings do not match the raw report');
  });

  it('reconstructs each receipt from its own real snapshots while the change report selects the latest receipt', () => {
    approvedChange();
    triage();
    const first = keptMutation();
    const second = keptMutation([mutant('Survived', { id: 'other', replacement: 'false' })]);
    const earlier = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: first })), 'feat/x');
    const latest = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: second })), 'feat/x');
    const reports = inFixture(() => {
      const { live } = current();
      return [reportFor(live.find(event => event.seq === earlier.seq), live),
        reportFor(live.find(event => event.seq === latest.seq), live)];
    });
    expect(reports[0].mutation.survivors.map(survivor => survivor.id)).toEqual(['1']);
    expect(reports[1].mutation.survivors.map(survivor => survivor.id)).toEqual(['other']);
    expect(inFixture(() => buildReport()).mutation.findings).toEqual(second.run.findings);
  });

  it.each([['raw', 'removed'], ['findings', 'removed'], ['raw', 'altered'], ['findings', 'altered']])(
    'reports unreadable %s mutation evidence when it is %s, without using an earlier receipt', (kind, damage) => {
      approvedChange();
      triage();
      const earlier = keptMutation([mutant('Survived', { id: 'earlier', replacement: 'earlier' })]);
      append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: earlier })), 'feat/x');
      const kept = keptMutation();
      const { evidence } = kept;
      const receipt = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: kept })), 'feat/x');
      const path = join(ctx.repo, evidence.snapshots[kind]);
      if (damage === 'removed') unlinkSync(path);
      else writeFileSync(path, '{}');
      const d = inFixture(() => buildReport());
      expect(d.mutation).toBeUndefined();
      const failure = d.incomplete.find(item => item.section === 'mutation');
      expect(failure.reason).toContain(`mutation: verification ${receipt.seq}:`);
      expect(failure.reason).toContain(kind === 'raw' ? 'raw mutation report' : 'mutation findings');
      expect(failure.reason).toContain(damage === 'removed' ? 'ENOENT' : 'SHA-256 digest mismatch');
      expect(failure.reason).toContain('Restore the exact evidence or obtain a fresh workflow verification.');
    });

  it.each([false, true])('does not require mutation evidence while disabled, with a current receipt: %s', currentReceipt => {
    approvedChange();
    triage();
    const kept = keptMutation();
    const { evidence } = kept;
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: kept })), 'feat/x');
    unlinkSync(join(ctx.repo, evidence.snapshots.raw));
    unlinkSync(join(ctx.repo, evidence.snapshots.findings));
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.testQuality.mutation = 'none';
    writeFileSync(path, JSON.stringify(config));
    writeFileSync(join(ctx.repo, 'later.test.mjs'), '// changed tree\n');
    if (currentReceipt) append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutation: kept })), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.mutation).toBeNull();
    expect(d.notChecked).toContain('not checked: mutation (checks.testQuality.mutation is "none")');
    expect(d.incomplete.map(item => item.section)).not.toContain('mutation');
  });

  // A rerun ran in someone's shell, whose environment can shape a pass, so
  // the summary the declaration and the change file keep says so.
  it('names a receipt from a rerun in the summary, and a receipt from the hook not at all', () => {
    approvedChange();
    triage();
    const checks = resultsOf({ junit: fixtureJUnit() });
    append(ctx.logbook, 'verified', { ...verifiedPayload(checks), trigger: 'rerun' }, 'feat/x');
    const rerun = inFixture(() => buildReport());
    expect(rerun.rerun).toBe(true);
    expect(summaryLines(rerun).at(-1)).toMatch(/^verified by a rerun( · |$)/);
    append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    const hook = inFixture(() => buildReport());
    expect(hook.rerun).toBeUndefined();
    expect(summaryLines(hook).join('\n')).not.toContain('rerun');
  });

  // A check silenced in one spot is where review has to look, in the report
  // the operator reads at record as much as in the commit message.
  it('lists a file that gains a check\'s suppression comment, under the check', () => {
    approvedChange();
    triage();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.testQuality.mutation.suppressions = ['\\bStryker\\s+disable\\b'];
    config.checks.codeQuality = { lint: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' }, suppressions: ['eslint-disable'] } };
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, 'modules/quiet.mjs'), '// Stryker disable next-line all\nexport const x = 1; // eslint-disable-line\n');
    const d = inFixture(() => buildReport());
    expect(d.areas?.must).toContainEqual({ text: 'New suppressions of the mutation check. Each silences it where it sits.', items: ['modules/quiet.mjs'] });
    expect(d.areas?.must).toContainEqual({ text: 'New suppressions of the lint check. Each silences it where it sits.', items: ['modules/quiet.mjs'] });
  });

  it('says what was not checked when coverage and mutation are off, and the plan has had no run', () => {
    approvedChange();
    triage();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.checks.testQuality.mutation = 'none';
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    const d = inFixture(() => buildReport());
    expect(d.coverage).toBeNull();
    expect(d.mutation).toBeNull();
    expect(d.notChecked.join(' ')).not.toContain('has not run for this plan');
    expect(d.notChecked).toEqual([expect.stringContaining('not checked: coverage'), 'not checked: mutation (checks.testQuality.mutation is "none")']);
  });

  it('counts follow-ups in the file the rulebook names, not FOLLOW-UPS.md', () => {
    approvedChange();
    triage();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.followUpsFile = 'docs/LATER.md';
    writeFileSync(path, `${JSON.stringify(config)}\n`);
    mkdirSync(join(ctx.repo, 'docs'), { recursive: true });
    writeFileSync(join(ctx.repo, 'docs/LATER.md'), '# Later\n\n- **Kept here.** Later.\n');
    writeFileSync(join(ctx.repo, 'FOLLOW-UPS.md'), '# Follow-ups\n\n- **Not counted.** Later.\n');
    const d = inFixture(() => buildReport());
    expect(d.followUps).toEqual({ added: ['Kept here.'], removed: [] });
  });

  // The triage stored the baseline's tests, so the report counts tests and
  // not test files: against the list, the last run's report, and git.
  it('counts tests against the list the triage stored', () => {
    approvedChange();
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, 'modules/b.test.mjs'), "it('one', () => {});\nit('two', () => {});\n");
    triage({ list: { tests: [{ file: 'modules/gone.test.mjs', titles: ['old'] }], unlisted: [] } });
    mkdirSync(join(ctx.repo, 'reports/junit'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/junit/run.xml'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites>',
      '  <testcase name="one" file="modules/b.test.mjs"/>',
      '  <testcase name="two" file="modules/b.test.mjs"/>',
      '</testsuites>',
      '',
    ].join('\n'));
    verifiedWorkingReport();
    const d = inFixture(() => buildReport());
    expect(d.tests).toEqual({ added: 2, modified: 0, removed: 1 });
    expect(summaryLines(d)).toContain('tests: 2 added, 0 modified, 1 removed');
  });

  it('recovers test counts and surprise names together when the exact snapshot is restored', () => {
    approvedChange();
    const file = 'sample.test.mjs';
    writeFileSync(join(ctx.repo, file), "it('replacement', () => {});");
    const identities = { tests: [{ file, titles: ['original'] }], unlisted: [] };
    const measured = { predicted: { failed: 0, total: 0 }, surprise: { failed: 1, total: 1, failures: ['original failed'] },
      overPredicted: { count: 0, total: 0, tests: [] }, notRun: { predicted: [], unpredicted: [] } };
    const snapshot = writeTriageSnapshot('feat/x', identities, measured, ctx.repo);
    const entry = append(ctx.logbook, 'triaged', { treeFingerprint: inFixture(fingerprint), implementationFingerprint: inFixture(current).implementationFingerprint, level: 'HIGH', reasons: ['Raised to HIGH by surprise failures: 1 against 0 predicted, 20% or more.'], implemented: true, ...snapshot }, 'feat/x');
    const dir = join(ctx.repo, 'reports/junit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.xml'), `<testsuites><testcase file="${file}" name="replacement"/></testsuites>`);
    verifiedWorkingReport();
    const path = join(ctx.repo, analysisPath(snapshot));
    const bytes = readFileSync(path);
    unlinkSync(path);
    const partial = inFixture(() => buildReport());
    expect(partial.tests).toBeUndefined();
    expect(partial.incomplete).toContainEqual({ section: 'triage snapshot', reason: expect.stringContaining(`triage ${entry.seq} ${analysisPath(snapshot)}`) });
    expect(partial.incomplete.map(issue => issue.section)).not.toContain('tests');
    expect(summaryLines(partial)[0]).toMatch(/prediction: 1 surprise.*risk: HIGH/);
    writeFileSync(path, bytes);
    const restored = inFixture(() => buildReport());
    expect(restored.incomplete).not.toContainEqual(expect.objectContaining({ section: 'triage snapshot' }));
    expect(restored.tests).toEqual({ added: 1, modified: 0, removed: 1 });
    expect(restored.surprises.surprise.failures).toEqual(['original failed']);
  });

  it('identifies malformed XML in the selected verification', () => {
    approvedChange();
    triage();
    mkdirSync(join(ctx.repo, 'reports/junit'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/junit/run.xml'), 'not a report');
    verifiedWorkingReport();
    const d = inFixture(() => buildReport());
    expect(d.incomplete).toContainEqual({ section: 'verified JUnit', reason: expect.stringContaining('a test report could not be read') });
    expect(d.tests).toBeUndefined();
  });

  it('counts scenario evidence from archived XML after the working report loses its tag', () => {
    approvedChange();
    const req = join(ctx.repo, 'requirements/acceptance');
    mkdirSync(req, { recursive: true });
    writeFileSync(join(req, 'AC0001__name.md'), '---\nstatus: active\n---\n\nKeep a name.\n\n## Scenarios\n\n- [AC0001.1] The name is kept.\n');
    triage();
    const test = 'name.acceptance.test.mjs';
    writeFileSync(join(ctx.repo, test), '// test source\n');
    const junitReports = fixtureJUnit(`<testsuites><testcase file="${test}" name="The name is kept. [AC0001.1]"/></testsuites>`);
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ junit: junitReports })), 'feat/x');
    mkdirSync(join(ctx.repo, 'reports/junit'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/junit/run.xml'), `<testsuites><testcase file="${test}" name="unrelated"/></testsuites>`);
    const report = inFixture(() => buildReport());
    expect(report.requirements?.evidence).toEqual([{ id: 'AC0001.1', evidence: 'solid' }]);
  });

  // A receipt that measured no tests cannot vouch for the current XML.
  it('reports missing JUnit evidence for a receipt whose tests result is skipped, even with working XML', () => {
    approvedChange();
    triage();
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ mutationSkip: 'Deferred.' })), 'feat/x');
    mkdirSync(join(ctx.repo, 'reports/junit'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/junit/run.xml'), 'not a report');
    const d = inFixture(() => buildReport());
    expect(d.notChecked).toContain('Deferred.');
    expect(d.incomplete).toEqual([{ section: 'verified JUnit', reason: `Verification ${receipt.seq}: The verification's tests result is skipped: `
      + 'Not measured by this case. Restore the exact evidence or obtain a fresh workflow verification.' }]);
    expect(d.requirements).toBeUndefined();
  });

  it('reports coverage as missing when nothing verified the current tree', () => {
    approvedChange();
    triage();
    setCoverage({ 'modules/feature.mjs': { total: 2, uncovered: [2] } });
    const d = inFixture(() => buildReport());
    expect(d.coverage).toBeUndefined();
    expect(d.incomplete).toContainEqual({ section: 'coverage', reason: 'coverage: no verification for the current tree and approval. Run workflow verification.' });
  });

  it('takes touched-line coverage from the snapshots the verification names, not the working output', () => {
    approvedChange();
    triage();
    const kept = keptCoverage();
    mkdirSync(join(ctx.repo, 'reports/checks'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/checks/coverage.json'), '{ "not": "the evidence" }');
    append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ junit: fixtureJUnit(), coverage: kept })), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.coverage).toEqual({ covered: 1, total: 2, uncovered: [{ file: 'modules/feature.mjs', lines: [2] }] });
    expect(d.incomplete.map((i) => i.section)).not.toContain('coverage');
  });

  it('names the verification that recorded no coverage snapshots', () => {
    approvedChange();
    triage();
    keptCoverage();
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ junit: fixtureJUnit() })), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.incomplete).toContainEqual({ section: 'coverage', reason: `coverage: verification ${receipt.seq}: The verification's coverage result is skipped: `
      + 'Not measured by this case. Restore the exact evidence or obtain a fresh workflow verification.' });
  });

  it('names the verification whose coverage analysis is gone', () => {
    approvedChange();
    triage();
    const kept = keptCoverage();
    const receipt = append(ctx.logbook, 'verified', verifiedPayload(resultsOf({ junit: fixtureJUnit(), coverage: kept })), 'feat/x');
    unlinkSync(join(ctx.repo, kept.coverage.analysis));
    const reason = inFixture(() => buildReport()).incomplete.find((i) => i.section === 'coverage')?.reason;
    expect(reason).toMatch(new RegExp(`^coverage: verification ${receipt.seq}: coverage analysis \\(`));
    expect(reason).toMatch(/Restore the exact evidence or obtain a fresh workflow verification\.$/);
  });
});
