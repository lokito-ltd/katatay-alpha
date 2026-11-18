/**
 * The order of the referee verify's steps, read in process. The cases that run
 * verify as the `Stop` hook does are in `referee-verify.process.test.mjs`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { REFEREE_STEPS, verifySteps } from './referee-verify.ts';
import { RESERVED_CHECK_NAMES } from './rulebook.mjs';

describe('the referee verify', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'referee-verify-')));
    const check = { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' } };
    writeConfig(root, { fields: { checks: { testQuality: { coverage: 'none', mutation: 'none' }, codeQuality: { boundaries: check, build: check } } } });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names its steps in the order it runs them', () => {
    expect(REFEREE_STEPS).toEqual(['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace']);
    expect(verifySteps(root)).toEqual([...REFEREE_STEPS, 'boundaries', 'build']);
  });

  // Verify reports a failure by the step's name, so no check may share one.
  // The rulebook keeps the list, since it cannot import this file.
  it('keeps every one of its step names from the checks', () => {
    expect(REFEREE_STEPS.filter((step) => !RESERVED_CHECK_NAMES.includes(step))).toEqual([]);
  });
});
