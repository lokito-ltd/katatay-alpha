/** A logbook that was edited.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, approvedChange, approvePlan, attempt, cli, events, git, phase, publish, show, triage,
} from '../support/machine/harness.mjs';
import { append, readChain, sha256 } from '../../src/workflow/chain.mjs';

machineFixture({ approved: true });

describe('tampering', () => {
  it.each([undefined, null, '1', 2, 1])('checks event version %j after a valid predecessor, including on the target', version => {
    approvedChange();
    triage();
    const [first, second] = events();
    const path = join(ctx.logbook, second);
    const entry = JSON.parse(readFileSync(path));
    expect(entry.prev).toBe(sha256(readFileSync(join(ctx.logbook, first))));
    const bytes = JSON.stringify({ ...entry, version }) + '\n';
    writeFileSync(path, bytes);
    const chain = readChain(ctx.logbook, 'feat/x');
    const diagnostic = second + ': event.version ' + (version === undefined ? 'is missing'
      : 'has unsupported schema version ' + JSON.stringify(version));
    if (version === 1) {
      expect(chain.broken).toBeNull();
      expect(phase()).toBe('converging');
    } else {
      expect(chain.entries.map(event => event.seq)).toEqual([1]);
      expect(chain.broken).toContain(diagnostic);
      expect(phase()).toBe('broken');
      expect(show()).toContain(diagnostic);
      expect(() => append(ctx.logbook, 'reset', { note: null }, 'feat/x')).toThrow(diagnostic);
    }
    git('add', '-A');
    git('commit', '--quiet', '-m', 'Fixture logbook on target');
    publish();
    const checked = cli('workflow.mjs', 'state', 'verify');
    expect(checked.status).toBe(version === 1 ? 0 : 1);
    if (version !== 1) expect(checked.stderr).toContain(diagnostic);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('catches an event rewritten with the chain left inconsistent', () => {
    approvedChange();
    triage();
    writeFileSync(join(ctx.logbook, '0001__plan_approved.json'),
      '{"seq":1,"prev":null,"ts":"x","event":"plan_approved","payload":{},"branch":"feat/x"}\n');

    expect(show()).toMatch(/BROKEN/);
    expect(phase()).toBe('broken');
    // and nothing may proceed while it is
    const decision = attempt('source.txt');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(/broken/);
  });

  it.each(['empty approval in reset file', 'wrong sequence', 'truncated JSON', 'missing baseline'])(
    'denies edits and diagnoses %s in both state commands', defect => {
      approvedChange();
      const original = '0001__plan_approved.json';
      const event = JSON.parse(readFileSync(join(ctx.logbook, original), 'utf8'));
      const file = defect === 'empty approval in reset file' ? '0001__reset.json'
        : defect === 'wrong sequence' ? '0002__plan_approved.json' : original;
      if (file !== original) renameSync(join(ctx.logbook, original), join(ctx.logbook, file));
      if (defect === 'missing baseline') delete event.payload.baseline;
      if (defect === 'empty approval in reset file') event.payload = {};
      writeFileSync(join(ctx.logbook, file), defect === 'truncated JSON' ? '{"seq":' : JSON.stringify(event));
      const shown = cli('show.mjs'), verified = cli('verify.mjs');
      expect(shown.status).toBe(1);
      expect(shown.stdout).toContain('phase      broken');
      expect(shown.stdout).toContain(file);
      expect(verified.status).toBe(1);
      expect(verified.stderr).toContain(file);
      const decision = attempt('source.txt').hookSpecificOutput;
      expect(decision.permissionDecision).toBe('deny');
      expect(decision.permissionDecisionReason).toContain(file);
    });
  it('does not record an approval into a broken logbook', () => {
    approvedChange();
    triage();
    writeFileSync(join(ctx.logbook, '0001__plan_approved.json'),
      '{"seq":1,"prev":null,"ts":"x","event":"plan_approved","payload":{},"branch":"feat/x"}\n');

    const decision = approvePlan({ plan: '# Plan\n\nAnother.' });
    expect(decision.systemMessage).toMatch(/broken/);
    expect(events()).toEqual(['0001__plan_approved.json', '0002__triaged.json']);
  });

  // The forgery the hash chain cannot see. The last event has nothing after it
  // to recompute, so the logbook links up perfectly. Git is the only witness,
  // and the hooks ask it as `state:verify` does.
  it('catches a rewritten final event, which the chain cannot', () => {
    approvedChange();
    git('add', '-A');
    git('commit', '--quiet', '-m', 'commit the logbook');

    const forged = JSON.parse(readFileSync(join(ctx.logbook, '0001__plan_approved.json'), 'utf8'));
    forged.payload.proposal = 'f'.repeat(64);
    writeFileSync(join(ctx.logbook, '0001__plan_approved.json'), `${JSON.stringify(forged, null, 2)}\n`);

    expect(show()).toMatch(/^BROKEN\s+.*0001__plan_approved\.json: committed as history, but the working tree disagrees with it\. Restore it from git\./m);
    expect(attempt('source.txt').hookSpecificOutput.permissionDecision).toBe('deny');
    const verify = cli('verify.mjs');
    expect(verify.status).toBe(1);
    expect(verify.stderr).toMatch(/committed as history, but the working tree disagrees/);
  });
});
