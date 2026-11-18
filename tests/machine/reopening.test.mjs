/** Editing the implementation after recording requires the triaged bytes to be restored.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx,
  machineFixture,
  phase,
  prompt,
  stop,
  reportedChangeFile,
} from '../support/machine/harness.mjs';

const verifiedChange = machineFixture({ verified: true });

describe('the operator declares a change finished', () => {
  const changeFile = 'requirements/changes/20260908T000000.000Z__x.md';
  // A change file the real guard accepts. Verify runs the guard itself now, so
  // a case that verifies again after `record` meets it, where the record step
  // only ever met the fixture's stub.
  const writeChangeFile = (body = reportedChangeFile()) => {
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(ctx.repo, changeFile), body);
  };

  // A declaration is about the code the operator saw. Code edited afterwards is
  // code they have not seen, so it needs verifying and declaring again.
  it('voids the declaration when code is edited after it', () => {
    verifiedChange();
    prompt('record');
    writeChangeFile();
    stop();
    writeFileSync(join(ctx.repo, 'source.txt'), 'changed after record\n');
    expect(phase()).toBe('converging');
    expect(stop().reason).toContain('Restore the triaged implementation');
    expect(phase()).toBe('converging');
  });
});
