/** The approved snapshot remains the plan across working-file edits and sessions. */
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, approvePlan, events, git, publish, phase, planFile, prompt, show,
} from '../support/machine/harness.mjs';

machineFixture();

const grant = () => JSON.parse(readFileSync(join(ctx.logbook,
  events().filter(name => name.endsWith('__plan_approved.json')).at(-1)), 'utf8')).payload;
const context = () => prompt('carry on').hookSpecificOutput.additionalContext;
const snapshotLine = () => `approved plan: ${grant().planSnapshot} — read the approved plan from this snapshot.`;

describe('the plan a change is working under', () => {
  it('points approval, state show and every prompt at the readable snapshot', () => {
    const approved = approvePlan();
    const { planSnapshot } = grant();
    expect(grant()).not.toHaveProperty('planFile');
    expect(approved.systemMessage).toContain(snapshotLine());
    expect(show()).toContain(snapshotLine());
    expect(context()).toContain(snapshotLine());
    expect(context()).toContain(snapshotLine());
    expect(readFileSync(join(ctx.repo, planSnapshot))).toEqual(readFileSync(planFile()));
  });

  it.each(['edited', 'removed'])('keeps the snapshot authoritative when the working file is %s', damage => {
    approvePlan();
    const path = join(ctx.repo, grant().planSnapshot);
    const bytes = readFileSync(path);
    if (damage === 'edited') writeFileSync(planFile(), '# Something else.');
    else rmSync(planFile());
    for (const said of [show(), context()]) {
      expect(said).toContain(snapshotLine());
      expect(said).not.toContain(planFile());
      expect(said).not.toMatch(/has changed since|no longer readable|unavailable locally/);
    }
    expect(readFileSync(path)).toEqual(bytes);
    expect(phase()).toBe('implementing');
  });

  it('keeps the grant and points at its original snapshot when identical bytes arrive in another file', () => {
    approvePlan();
    const before = events();
    const original = grant();
    writeFileSync(planFile(), 'Changed on disk.');
    const result = approvePlan({ file: planFile('copy.md') });
    expect(result.systemMessage).toContain('already approved');
    expect(result.systemMessage).toContain(snapshotLine());
    expect(events()).toEqual(before);
    expect(grant()).toEqual(original);
    expect(show()).toContain(snapshotLine());
  });

  it.each(['reset', 'merge'])('records a fresh grant for the same bytes after %s', (end) => {
    approvePlan();
    if (end === 'reset') prompt('reset');
    else {
      git('add', '-A');
      git('commit', '--quiet', '-m', 'finish change');
      publish();
    }
    expect(phase()).toBe('open');
    expect(context()).not.toContain('approved plan:');
    expect(show()).not.toContain('approved plan:');
    approvePlan();
    expect(phase()).toBe('implementing');
    expect(events().filter((name) => name.endsWith('__plan_approved.json'))).toHaveLength(2);
  });

  it.each(['missing', 'corrupt'])('reports a %s snapshot without changing the phase, and recognizes restored bytes', damage => {
    approvePlan();
    const path = join(ctx.repo, grant().planSnapshot);
    const bytes = readFileSync(path);
    if (damage === 'missing') rmSync(path);
    else writeFileSync(path, 'Other bytes.');
    for (const said of [show(), context(), approvePlan().systemMessage]) {
      expect(said).toContain(`approved plan: ${grant().planSnapshot} — unavailable locally`);
      expect(said).toContain(damage === 'missing' ? 'ENOENT' : 'SHA-256 digest mismatch');
      expect(said).toContain('Restore the exact approved snapshot at the recorded path and retry.');
      expect(said).not.toContain('read the approved plan from this snapshot');
    }
    expect(events()).toHaveLength(1);
    expect(phase()).toBe('implementing');
    writeFileSync(path, bytes);
    expect(context()).toContain(snapshotLine());
  });

  it('follows the latest approved snapshot when a revision replaces an earlier plan', () => {
    approvePlan({ file: planFile('first.md') });
    const original = grant();
    const revision = '# Plan\n\nRevised.';
    const result = approvePlan({ plan: revision, file: planFile('second.md') });
    rmSync(planFile('first.md'));
    rmSync(planFile('second.md'));
    expect(grant().planSnapshot).not.toBe(original.planSnapshot);
    expect(readFileSync(join(ctx.repo, grant().planSnapshot), 'utf8')).toBe(revision);
    for (const said of [result.systemMessage, show(), context()]) {
      expect(said).toContain(snapshotLine());
      expect(said).not.toContain(original.planSnapshot);
    }
  });
});
