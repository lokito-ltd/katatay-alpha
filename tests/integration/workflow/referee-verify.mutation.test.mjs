/** Verify against the plan in a real logbook. Call verify against the fixture
 * to observe how it chooses and reuses evidence. */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVerify } from '../../../src/workflow/referee-verify.ts';
import { ctx, approvedChange, events, git, machineFixture, setMutate, stop, triage } from '../../support/machine/harness.mjs';
import { mutant, mutationCommand } from '../../fixtures/workflow/mutation-report.mjs';
import { readMutationSnapshot } from '../../../src/workflow/mutation-snapshot.mjs';
import { mutationReferences } from '../../../src/workflow/result-readers.mjs';

machineFixture({ approved: true });

async function manual(...options) {
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(ctx.repo);
    vi.stubEnv('HOME', ctx.home);
    const file = join(ctx.home, 'manual-results.json');
    const code = await runVerify(['--results', file, ...options]);
    const { results } = JSON.parse(readFileSync(file, 'utf8'));
    return { code, mutation: results.filter(item => ['tests', 'coverage', 'mutation'].includes(item.name)).find(c => c.name === 'mutation'), output: [...log.mock.calls, ...error.mock.calls].flat().join('\n') };
  } finally {
    vi.unstubAllEnvs();
    process.chdir(cwd);
    log.mockRestore();
    error.mockRestore();
  }
}

describe('manual verification of an approved plan', () => {
  it('uses the pinned baseline even when the tracking ref contains the new code', async () => {
    approvedChange();
    writeFileSync(join(ctx.repo, 'feature.ts'), 'export const on = true;\n');
    git('add', 'feature.ts');
    git('commit', '--quiet', '-m', 'code');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const asked = join(ctx.home, 'input.json');
    setMutate(mutationCommand('partial run', 2, [mutant('Survived')],
      `fs.writeFileSync(${JSON.stringify(asked)}, fs.readFileSync(0));`));
    const before = events();
    const result = await manual();
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(readFileSync(asked))).toEqual({ budget: 240, verbose: false, targets: [{ file: 'feature.ts', lines: [1, 1] }] });
    expect(result.mutation).toMatchObject({ status: 'partial', reason: 'Mutation measurement is incomplete: inconclusive: 1 mutant, 0 caught, 1 survived',
      summary: { survived: 1 } });
    expect(result.output).toContain('modules/a.ts:1\n  a === b\n    EqualityOperator → a !== b');
    expect(events()).toEqual(before);
  });

  it('defers at its position and reuses the first passing hook report after the raw evidence is removed', async () => {
    approvedChange();
    writeFileSync(join(ctx.repo, 'feature.ts'), 'export const a = true;\n');
    triage();
    setMutate(mutationCommand('caught by no test', 1, [mutant('Survived')]));
    const report = join(ctx.repo, 'reports/mutation/mutation.json');
    const deferred = await manual('--deadline', String(Date.now() + 25_000));
    expect(deferred.code, deferred.output).toBe(0);
    expect(deferred.mutation.reason).toContain('Mutation testing deferred');
    expect(existsSync(report)).toBe(false);
    expect(stop().reason).toContain('mutation: FINDINGS\n1 survived · 0 killed · 1 mutants');
    rmSync(report);
    const before = events();
    const later = await manual();
    expect(later.code, later.output).toBe(0);
    expect(later.mutation).toMatchObject({ status: 'reused', summary: { survived: 1 } });
    expect(later.mutation.summary).not.toHaveProperty('survivors');
    expect(readMutationSnapshot('feat/x', mutationReferences(later.mutation), ctx.repo).findings.survivors)
      .toEqual([expect.objectContaining({ id: '1' })]);
    expect(later.output).toContain('caught by no test');
    expect(events()).toEqual(before);
    expect(existsSync(report)).toBe(false);
  });

  it('says there is no baseline when the target has no common commit, and starts no command', async () => {
    // No approved plan: this target exists, so the catalogue guard can read
    // it, but it has no shared history from which to select changed lines.
    const tree = git('rev-parse', 'HEAD^{tree}').trim();
    const unrelated = git('commit-tree', tree, '-m', 'unrelated root').trim();
    git('update-ref', 'refs/remotes/origin/main', unrelated);
    writeFileSync(join(ctx.repo, 'feature.ts'), 'export const a = true;\n');
    const result = await manual();
    expect(result.code).toBe(1);
    expect(result.mutation).toMatchObject({ status: 'failed', reason: expect.stringContaining('no baseline') });
    expect(result.output).toContain('failed at mutation');
  });
});
