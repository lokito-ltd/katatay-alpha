import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { append } from '../../src/workflow/chain.mjs';
import { verifiedPayload, ctx, fixtureChecks, approvePlan, git, machineFixture, publish, triage } from '../support/machine/harness.mjs';
import { verifiedWithGaps } from '../support/machine/gaps.mjs';
import { buildReport, gapsOf, renderReport } from '../../src/evidence/report.ts';

machineFixture({ approved: true });

/** Gather the report in the fixture repository, and always restore the caller's environment. */
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

describe('the change report, gathered', () => {
  it('keeps the stored counts and survivors after the report file is replaced or removed', () => {
    verifiedWithGaps();
    const config = JSON.parse(readFileSync(join(ctx.repo, '.katatay/rulebook.json'), 'utf8'));
    const file = join(ctx.repo, config.checks.testQuality.mutation.output);
    const original = inFixture(() => buildReport()).mutation;
    expect(original.findings).toMatchObject({ counts: { survived: 1, caught: 0 },
      survivors: [{ file: 'modules/feature.mjs', id: '1', mutator: 'BooleanLiteral' }] });
    writeFileSync(file, 'a later run left invalid JSON');
    expect(inFixture(() => buildReport()).mutation).toEqual(original);
    rmSync(file);
    expect(inFixture(() => buildReport()).mutation).toEqual(original);
  });

  it('reads current sections and reports coverage and mutation missing once the tree moves past its verification', () => {
    verifiedWithGaps();
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    writeFileSync(join(ctx.repo, 'modules/feature.test.mjs'), "it('x', () => {});\n");
    writeFileSync(join(ctx.repo, 'FOLLOW-UPS.md'), '# Follow-ups\n\n- **A parked idea.** Later.\n');
    const d = inFixture(() => buildReport());
    expect(d.incomplete).toEqual([{ section: 'verified JUnit', reason: expect.stringContaining('No verification for the current tree') },
      { section: 'coverage', reason: expect.stringContaining('no verification for the current tree') },
      { section: 'mutation', reason: 'mutation: no verification for the current tree and approval. Run workflow verification.' }]);
    expect(d.size).toEqual({ code: { added: 2, deleted: 0 }, tests: { added: 1, modified: 0, removed: 0 } });
    expect(d.surprises?.level).toBeDefined();
    expect(d.requirements).toBeUndefined();
    expect(d.coverage).toBeUndefined();
    expect(d.mutation).toBeUndefined();
    expect(d.notChecked.join(' ')).not.toMatch(/not checked: mutation|has not run for this plan/);
    expect(d.followUps).toEqual({ added: ['A parked idea.'], removed: [] });
    expect(d.drift).toEqual([]);
    expect(gapsOf(d)).toEqual({});
    expect(renderReport(d)[0]).toBe('Change report');
  });

  // A file the triage's run left out has no tests in the list. Its tests are
  // new only if the file is; otherwise their lines decide.
  it('counts a test in a file the triage could not list by whether the file is new, and by its lines', () => {
    mkdirSync(join(ctx.repo, 'modules'), { recursive: true });
    const old = join(ctx.repo, 'modules/old.test.mjs');
    writeFileSync(old, "it('one', () => {});\nit('two', () => {\n  expect(1).toBe(1);\n});\n");
    git('add', '-A');
    git('commit', '--quiet', '-m', 'a test file at the baseline');
    publish();
    approvePlan();
    writeFileSync(old, "it('one', () => {});\nit('two', () => {\n  expect(2).toBe(2);\n});\n");
    writeFileSync(join(ctx.repo, 'modules/new.test.mjs'), "it('x', () => {});\n");
    triage({ list: { tests: [], unlisted: ['modules/new.test.mjs', 'modules/old.test.mjs'] } });
    const testcase = (file, name, line, endLine) =>
      `  <testcase name="${name}" file="${file}"><properties><property name="line" value="${line}"/><property name="endLine" value="${endLine}"/></properties></testcase>`;
    mkdirSync(join(ctx.repo, 'reports/junit'), { recursive: true });
    writeFileSync(join(ctx.repo, 'reports/junit/run.xml'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites>',
      testcase('modules/old.test.mjs', 'one', 1, 1),
      testcase('modules/old.test.mjs', 'two', 2, 4),
      testcase('modules/new.test.mjs', 'x', 1, 1),
      '</testsuites>',
      '',
    ].join('\n'));
    const checks = fixtureChecks(readFileSync(join(ctx.repo, 'reports/junit/run.xml')));
    append(ctx.logbook, 'verified', verifiedPayload(checks), 'feat/x');
    const d = inFixture(() => buildReport());
    expect(d.tests).toEqual({ added: 1, modified: 1, removed: 0 });
  });
});
