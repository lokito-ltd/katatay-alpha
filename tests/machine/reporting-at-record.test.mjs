/**
 * The change report at `record`, through the real hooks. What each section says is proved in
 * `src/evidence/report.test.ts`, and the decision on its own in
 * `../record.test.mjs`; here the moment builds the report, directs the reply
 * and records what it decided. `reporting-gathered.test.mjs` calls the report builder
 * directly.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analysisPath } from '../fixtures/workflow/events.mjs';
import { submitFixtureAnalysis, appendEvent, ctx, approvedChange, approvePlan, cli, events, machineFixture, phase, prompt, reportedChangeFile, setCoverage, setMutate, stop, triage } from '../support/machine/harness.mjs';
import { mutant, mutationCommand } from '../fixtures/workflow/mutation-report.mjs';
import { verifiedWithGaps } from '../support/machine/gaps.mjs';

machineFixture({ approved: true });

const said = (text) => prompt(text).hookSpecificOutput.additionalContext;
const holdReply = 'Tell the operator to type `record` again to declare the change as it stands.';
const gapsAnalysis = 'Coverage modules/feature.mjs:2\nScenario: Call off().\nAssert: The result is false.\n\n'
  + 'Mutants modules/feature.mjs:1\nVariant 1\nScenario: Read on.\nAssert: It is true.';
const fullReport = () => {
  const run = cli('workflow.mjs', 'report');
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
};
const eventFile = (name) => events().find((e) => e.endsWith(`__${name}.json`));
/** The full change report the decision event `name` names. */
const keptReport = (name) => JSON.parse(readFileSync(join(ctx.repo, payloadOf(name).changeReportSnapshot), 'utf8'));
const payloadOf = (name) => JSON.parse(readFileSync(join(ctx.logbook, eventFile(name)), 'utf8')).payload;
/** A check's result on the latest receipt, and the snapshot its evidence names in a role. */
const resultOf = (name, payload = payloadOf('verified')) => payload.results.find(result => result.name === name);
const snapshotOf = (name, role) => resultOf(name).evidence.find(item => item.role === role).snapshot;

describe('the change report at record', () => {
  it.each(['replaced', 'removed'])('uses saved mutation evidence at record after the working report is %s', damage => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    const file = join(ctx.repo, 'reports/mutation/mutation.json');
    if (damage === 'removed') rmSync(file);
    else writeFileSync(file, 'a later command replaced the working report');
    expect(said('record')).toContain(holdReply);
    expect(fullReport()).toContain('mutants: 0 caught, 1 survived');
    expect(phase()).toBe('verified');
    said('record');
    expect(phase()).toBe('declared');
    expect(payloadOf('declared').gaps).toEqual({ uncoveredLines: 1, uncaughtMutants: 1 });
  });

  it('refuses every record when the selected mutation snapshot is missing despite a saved checks report', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    rmSync(join(ctx.repo, snapshotOf('mutation', 'analysis')));
    for (let i = 0; i < 2; i++) {
      const told = said('record');
      expect(told).toMatch(/mutation: verification \d+: .*Restore the exact evidence/);
      expect(told).toContain('mutation findings');
    }
    expect(eventFile('record_held')).toBeUndefined();
    expect(eventFile('declared')).toBeUndefined();
    expect(phase()).toBe('verified');
  });

  it('uses saved coverage at record after the source LCOV has been removed', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    rmSync(join(ctx.repo, 'reports/coverage.info'));
    const told = said('record');
    expect(told).toContain(holdReply);
    // The hold keeps the full report, uncovered lines included.
    const full = keptReport('record_held').lines.join('\n');
    expect(full).toContain('change coverage 50% (1 of 2 lines)');
    expect(full).toContain('modules/feature.mjs: 1 line no test runs (2)');
    expect(full).not.toContain('Could not be read');
    expect(fullReport()).toContain('change coverage 50% (1 of 2 lines)');
    expect(phase()).toBe('verified');
    expect(eventFile('record_held')).toBeDefined();
    expect(payloadOf('record_held').gaps).toEqual({ uncoveredLines: 1, uncaughtMutants: 1 });
    expect(payloadOf('record_held').gaps).toEqual(keptReport('record_held').gaps);
  });

  it('refuses record when the coverage analysis the verification names is missing, whatever the working output holds', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    rmSync(join(ctx.repo, snapshotOf('coverage', 'analysis')));
    for (let i = 0; i < 2; i++) {
      const told = said('record');
      expect(told).toContain('coverage analysis');
      expect(told).toMatch(/coverage: verification \d+: .*Restore the exact evidence/);
    }
    expect(eventFile('record_held')).toBeUndefined();
    expect(phase()).toBe('verified');
  });

  it('keeps the raw coverage and the analysis as separate snapshots on the verification', () => {
    verifiedWithGaps();
    expect(resultOf('coverage').evidence.map(item => item.role).sort()).toEqual(['analysis', 'raw']);
    expect(readFileSync(join(ctx.repo, snapshotOf('coverage', 'raw')), 'utf8')).toContain('SF:modules/feature.mjs');
    expect(JSON.parse(readFileSync(join(ctx.repo, snapshotOf('coverage', 'analysis')), 'utf8')).measurement.touched.uncovered)
      .toEqual([{ file: 'modules/feature.mjs', lines: [2] }]);
  });

  it('reads the verification\'s coverage after the working output is rewritten', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    const working = join(ctx.repo, 'reports/checks/coverage.json');
    const data = JSON.parse(readFileSync(working, 'utf8'));
    data.measurement.touched = { covered: 2, total: 2, uncovered: [] };
    writeFileSync(working, JSON.stringify(data));
    expect(said('record')).toContain(holdReply);
    expect(fullReport()).toContain('change coverage 50% (1 of 2 lines)');
  });

  it('refuses every record when the receipt reports coverage as skipped', () => {
    verifiedWithGaps();
    const receipt = payloadOf('verified');
    const at = receipt.results.findIndex(result => result.name === 'coverage');
    receipt.results[at] = { name: 'coverage', status: 'skipped', reason: 'Skipped by this fixture.', evidence: [], summary: {} };
    appendEvent('verified', receipt);
    // A skipped coverage result names no uncovered lines to analyse.
    submitFixtureAnalysis(gapsAnalysis.split('\n\n')[1]);
    for (let i = 0; i < 2; i++) expect(said('record')).toContain("The verification's coverage result is skipped");
    expect(eventFile('record_held')).toBeUndefined();
    expect(phase()).toBe('verified');
  });

  it('points back to verify and holds a change whose gaps nobody acted on', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    const first = said('record');
    expect(first).toContain(holdReply);
    // The hold shows the analysis's compact summary, not its entries.
    expect(first).toContain('Tests suggested: ');
    expect(first).not.toContain(gapsAnalysis.split('\n')[1]);
    expect(first).not.toContain('Change report');
    expect(first).not.toContain('Write the change file');
    expect(eventFile('record_held')).toBeDefined();
    expect(eventFile('declared')).toBeUndefined();
    expect(phase()).toBe('verified');
  });

  it('shows a preview before record and the recorded summary after, writing no event', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    const before = events();
    const preview = fullReport();
    expect(preview).toMatch(/^Change report preview\. No `record` decision exists for this tree\.\n/);
    expect(preview).toMatch(/\nNo logbook event was recorded\.\n$/);
    expect(events()).toEqual(before);

    const told = said('record');
    const link = relative(ctx.repo, join(ctx.logbook, eventFile('record_held')));
    expect(told).toContain('Change held: 1 touched line no test runs, and 1 mutant no test caught.');
    expect(told).toContain(`\nDetails: ${link}\n`);
    const after = events();
    const recorded = fullReport();
    expect(recorded).toMatch(/^Change held on this tree\. This is the report recorded with that decision\.\n/);
    expect(recorded).toContain(`\nDetails: ${link}\n`);
    for (const line of keptReport('record_held').summary) expect(recorded).toContain(`\n${line}\n`);
    expect(events()).toEqual(after);

    // A snapshot that no longer matches its digest is said, and a preview follows.
    writeFileSync(join(ctx.repo, payloadOf('record_held').changeReportSnapshot), '{}');
    expect(fullReport()).toMatch(/^Change report preview\.[\s\S]*\n- recorded change report: record_held \d+ \S+: SHA-256 digest mismatch\n/);
  });

  it('declares on a second record on the same tree, keeping the gaps accepted', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    said('record');
    const second = said('record');
    expect(second).toContain('Change declared. You typed `record` again on the same tree, so you accept the gaps it shows.');
    expect(second).toMatch(/typed `record` again on the same tree[\s\S]*The operator declared this change finished\. Write the change file now\./);
    expect(phase()).toBe('declared');
    expect(payloadOf('declared').gaps).toEqual({ uncoveredLines: 1, uncaughtMutants: 1 });
  });

  it('requires the selected snapshot even after the operator has a quality hold', () => {
    verifiedWithGaps();
    submitFixtureAnalysis(gapsAnalysis);
    expect(said('record')).toContain(holdReply);
    const triageFile = analysisPath(payloadOf('triaged'));
    const path = join(ctx.repo, triageFile);
    const bytes = readFileSync(path);
    rmSync(path);
    for (let i = 0; i < 2; i++) {
      expect(said('record')).toContain(triageFile);
      expect(phase()).toBe('verified');
    }
    expect(events().filter(e => e.endsWith('__record_held.json'))).toHaveLength(1);
    expect(eventFile('declared')).toBeUndefined();
    writeFileSync(path, bytes);
    said('record');
    expect(phase()).toBe('declared');
  });

  it('holds the first record for a confirmed survivor even when the run was inconclusive', () => {
    approvedChange();
    const file = 'modules/feature.mjs';
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, file), 'export const on = true;\n');
    triage();
    setCoverage({ [file]: { total: 1, uncovered: [] } });
    setMutate(mutationCommand('partial run', 2, [mutant('Survived', { file })]));
    const verified = stop();
    expect(phase(), verified.reason).toBe('verified');
    submitFixtureAnalysis('Mutants modules/feature.mjs:1\nVariant 1\nScenario: Read on.\nAssert: It is true.');
    const first = said('record');
    expect(first).toContain(holdReply);
    expect(fullReport()).toContain('mutants: 0 caught, 1 survived (inconclusive run)');
    expect(phase()).toBe('verified');
    expect(payloadOf('record_held').gaps).toEqual({ uncoveredLines: 0, uncaughtMutants: 1 });
    said('record');
    expect(payloadOf('declared').gaps).toEqual({ uncoveredLines: 0, uncaughtMutants: 1 });
  });

  it('holds for unproved mutants alone and keeps the same counts when the operator accepts them', () => {
    approvedChange();
    const file = 'modules/feature.mjs';
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, file), 'export const on = true;\n');
    triage();
    setCoverage({ [file]: { total: 1, uncovered: [] } });
    setMutate(mutationCommand('partial run', 2, ['NoCoverage', 'Pending', 'Survived'].map((status, i) =>
      mutant(status, { file, id: String(i), testsCompleted: 0 }))));
    stop();
    expect(resultOf('mutation').summary).toMatchObject({ survived: 0, unproved: 3 });
    submitFixtureAnalysis();
    expect(said('record')).toContain('Change held: 3 mutants no test caught.');
    expect(phase()).toBe('verified');
    expect(payloadOf('record_held').gaps).toEqual({ uncoveredLines: 0, uncaughtMutants: 3 });
    const held = keptReport('record_held');
    expect(held.gaps).toEqual({ uncoveredLines: 0, uncaughtMutants: 3 });
    expect(held.lines).toContain('  Unproved mutants: 1 reached by no test, 1 pending, 1 with no completed tests.');
    expect(said('record')).toContain('You typed `record` again on the same tree');
    expect(phase()).toBe('declared');
    expect(payloadOf('declared').gaps).toEqual(held.gaps);
    expect(keptReport('declared').gaps).toEqual(held.gaps);
  });

  it('requires the triaged implementation to be restored before recording', () => {
    verifiedWithGaps();
    writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = false;');
    expect(stop().reason).toContain('Restore the triaged implementation');
    expect(said('record')).toContain('Restore the triaged implementation');
    expect(eventFile('declared')).toBeUndefined();
  });

  it('declares at once when the report finds no gaps', () => {
    approvedChange();
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\n');
    triage();
    setCoverage({ 'modules/feature.mjs': { total: 1, uncovered: [] } });
    stop();
    submitFixtureAnalysis();
    const told = said('record');
    expect(told).toContain('\n\nChange declared. The report found no gaps.\n');
    expect(told).toContain('\nThe operator declared this change finished. Write the change file now.');
    expect(phase()).toBe('declared');
  });

  // The change file is what survives the merge, so it opens with the summary
  // the operator read, and the harness checks it against what it stored.
  it('keeps the summary it showed with the declaration, and records only a change file that opens with it', () => {
    approvedChange();
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, 'modules/feature.mjs'), 'export const on = true;\n');
    triage();
    setCoverage({ 'modules/feature.mjs': { total: 1, uncovered: [] } });
    stop();
    submitFixtureAnalysis();
    const told = said('record');
    const { summary } = payloadOf('declared');
    expect(summary.length).toBeGreaterThan(0);
    // What the operator read, the event, its snapshot and the change file
    // hold the same lines, about the same tree.
    expect(told).toContain(`\n\n${summary.join('\n')}\n\nDetails: ${relative(ctx.repo, join(ctx.logbook, eventFile('declared')))}\n`);
    expect(keptReport('declared')).toMatchObject({ treeFingerprint: payloadOf('declared').treeFingerprint, decision: 'declared', summary });
    expect(told).toContain(`## Report\n\n\`\`\`text\n${summary.join('\n')}\n\`\`\``);

    const changeFile = join(ctx.repo, 'requirements/changes/20261023T000000.000Z__x.md');
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    writeFileSync(changeFile, reportedChangeFile().replace(summary[0], 'risk LOW · all good'));
    const refused = stop();
    expect(refused.decision).toBe('block');
    expect(refused.reason).toContain('differs from the summary the operator declared on');
    expect(phase()).toBe('declared');

    writeFileSync(changeFile, reportedChangeFile());
    stop();
    expect(phase()).toBe('recorded');
  });

  it('keeps test counts and scenario evidence from both verified reports through declaration', () => {
    // The change adds AC0001 below, so the approved plan states it as it will
    // read, or verify's guard would refuse the new requirement.
    approvePlan({ plan: [
      '# Plan', '', 'Add AC0001 and its acceptance test.', '',
      '```workflow',
      'requirement-changes:',
      '  - id: AC0001',
      '    status: accepted',
      '    statement: A name is kept.',
      '    scenarios:',
      "      - '[AC0001.1] The name is kept.'",
      '```', '',
    ].join('\n') });
    const path = name => join(ctx.repo, name);
    const configPath = path('.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(configPath));
    config.tests.run.command = 'mkdir -p reports/junit && cp fast-input.xml reports/junit/fast.xml && cp slow-input.xml reports/junit/slow.xml';
    writeFileSync(configPath, JSON.stringify(config));
    const fast = '<testsuites><testcase name="The name is kept. [AC0001.1]" file="name.acceptance.test.mjs"/></testsuites>\r\n';
    const slow = '<testsuites><testcase name="Slow case" file="slow.test.mjs"/></testsuites>\n';
    writeFileSync(path('fast-input.xml'), fast);
    writeFileSync(path('slow-input.xml'), slow);
    mkdirSync(path('requirements/acceptance'), { recursive: true });
    writeFileSync(path('requirements/acceptance/AC0001__name.md'),
      '---\nstatus: accepted\n---\n\nA name is kept.\n\n## Scenarios\n\n- [AC0001.1] The name is kept.\n\n## Why\n\nNames identify people.\n');
    triage();
    writeFileSync(path('name.acceptance.test.mjs'), '// The name is kept. [AC0001.1]\n');
    writeFileSync(path('slow.test.mjs'), '// Slow case\n');
    const response = stop();
    expect(phase(), response.reason).toBe('verified');
    const reports = resultOf('tests').evidence.filter(item => item.role === 'raw');
    expect(reports.map(f => f.title)).toEqual(['JUnit: reports/junit/fast.xml', 'JUnit: reports/junit/slow.xml']);
    expect(reports.map(f => readFileSync(path(f.snapshot)))).toEqual([Buffer.from(fast), Buffer.from(slow)]);
    submitFixtureAnalysis();
    const before = fullReport();
    expect(before).toContain('tests: 2 added, 0 modified, 0 removed');
    writeFileSync(path('reports/junit/fast.xml'), '<testsuites/>');
    rmSync(path('reports/junit/slow.xml'));
    expect(fullReport()).toBe(before);
    said('record');
    expect(phase()).toBe('declared');
    const full = keptReport('declared').lines.join('\n');
    expect(full).toContain('tests: 2 added, 0 modified, 0 removed');
    expect(full).toContain('1 has acceptance evidence');
  });

  it('recovers from corrupt JUnit only after the evidence is restored', () => {
    approvedChange();
    triage();
    stop();
    submitFixtureAnalysis();
    const file = join(ctx.repo, snapshotOf('tests', 'raw'));
    const original = readFileSync(file);
    rmSync(file);
    expect(said('record')).toContain('ENOENT');
    writeFileSync(file, 'not a report');
    for (let i = 0; i < 2; i++) {
      expect(said('record')).toMatch(/Could not be read[\s\S]*verified JUnit:[\s\S]*digest mismatch/);
      expect(phase()).toBe('verified');
    }
    expect(eventFile('record_held')).toBeUndefined();
    expect(eventFile('declared')).toBeUndefined();
    writeFileSync(file, original);
    said('record');
    expect(phase()).toBe('declared');
  });
});
