/** Reaching `declared`: the operator's word, and what it takes to hear it.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, approvedChange, events, phase, prompt, show, stop, triage, reportedChangeFile,
} from '../support/machine/harness.mjs';

const verifiedChange = machineFixture({ verified: true, approved: true });

describe('the operator declares a change finished', () => {
  const changeFile = 'requirements/changes/20260908T000000.000Z__x.md';
  const writeChangeFile = (body = reportedChangeFile()) => {
    mkdirSync(join(ctx.repo, 'requirements/changes'), { recursive: true });
    writeFileSync(join(ctx.repo, changeFile), body);
  };

  it('does not treat a change file written by the agent as finished', () => {
    verifiedChange();
    // Complete in every section, the report included, and still not a
    // declaration: nothing was declared for it to match.
    writeChangeFile('---\n---\n\n# X\n\n## Report\n\n```text\nrisk LOW\n```\n\n## Departures\n\nNone.\n');
    expect(phase()).toBe('verified');
    const decision = stop();
    expect(decision.decision).toBeUndefined();
    expect(decision.systemMessage).toMatch(/record/);
    expect(events().some((e) => e.includes('recorded'))).toBe(false);
  });

  // The old verified phase blocked until a change file existed, which told the
  // agent to finish its own work.
  it('does not block a verified turn, because only the operator can move it on', () => {
    verifiedChange();
    expect(stop().decision).toBeUndefined();
  });

  it('walks verified → declared → recorded once the operator types record', () => {
    verifiedChange();
    const told = prompt('record: happy with this');
    expect(told.hookSpecificOutput.additionalContext).toMatch(/declared this change finished/);
    expect(phase()).toBe('declared');
    expect(show()).toContain('happy with this');

    expect(stop().decision).toBe('block');

    // Writing the summary must not void the declaration it follows.
    writeChangeFile();
    expect(phase()).toBe('declared');
    const decision = stop();
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/Recorded by/);
    expect(events().at(-1)).toMatch(/__recorded\.json$/);
    expect(phase()).toBe('recorded');
  });

  it('refuses record before the tree is verified, and says so', () => {
    approvedChange();
    triage();
    const told = prompt('record');
    expect(told.hookSpecificOutput.additionalContext).toMatch(/not recorded.*converging/);
    expect(events().some((e) => e.includes('declared'))).toBe(false);
    expect(phase()).toBe('converging');
  });
});
