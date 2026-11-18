/** Named setup warnings through the real CLI and moment processes. */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, cli, machineFixture, approvedChange, show, stop, triage } from '../support/machine/harness.mjs';

machineFixture({ approved: true });

const configure = (settings = {}) => {
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(join(ctx.repo, 'check.mjs'), 'console.log(JSON.stringify({ version: 1, warnings: ["shared warning"] }));');
  config.agent.adapters = Object.fromEntries(['zeta', 'alpha'].map((name) => [name, {
    checkCommand: 'node check.mjs', ...settings[name],
  }]));
  writeFileSync(path, JSON.stringify(config));
};

const both = (text) => {
  expect(text).toContain('zeta: shared warning');
  expect(text).toContain('alpha: shared warning');
  expect(text.indexOf('zeta: shared warning')).toBeLessThan(text.indexOf('alpha: shared warning'));
};

describe('several agents in one rulebook', () => {
  it('carries both named warnings on the first and subsequent verified turn ends', () => {
    approvedChange();
    configure();
    triage();
    both(stop().reason);
    both(stop().systemMessage);
  });

  it('names every disabled check when the rulebook is valid', () => {
    configure({ zeta: { extraHooks: { check: false } }, alpha: { extraHooks: { check: false } } });
    const disabled = show();
    expect(disabled.match(/turns the extra-hooks check off/g)).toHaveLength(2);
    expect(disabled).toContain('zeta: the rulebook turns the extra-hooks check off (agent.adapters.zeta.extraHooks.check)');
    expect(disabled).toContain('alpha: the rulebook turns the extra-hooks check off (agent.adapters.alpha.extraHooks.check)');
  });

  it('refuses state display with the offending extra-hook field', () => {
    configure({ zeta: { extraHooks: { check: 'no' } }, alpha: { extraHooks: { check: false } } });
    const invalid = cli('show.mjs');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('state: refused — "agent.adapters.zeta.extraHooks.check" must be true or false');
    expect(invalid.stdout).toBe('');
  });

  it('reports invalid adapter configuration without claiming a disabled check', () => {
    configure();
    const path = join(ctx.repo, '.katatay/rulebook.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.agent.commands = { check: 'node check.mjs' };
    writeFileSync(path, JSON.stringify(config));
    const refusal = cli('show.mjs');
    expect(refusal.status).toBe(1);
    expect(refusal.stderr).toContain('unknown "agent.commands"');
    expect(refusal.stderr).not.toContain('turns the extra-hooks check off');
  });
});
