/** Where the rulebook says plans and follow-ups live, and the shapes of it the
 *  referee refuses because they would leave edits ungated.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ctx, machineFixture, show,
} from '../support/machine/harness.mjs';

machineFixture({ approved: true });

/** The fixture's rulebook with `change` applied to it. */
const rulebook = (change) => {
  const path = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  change(config);
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

describe('the extra-hooks check, switched off', () => {
  const off = () => rulebook((config) => { config.agent.adapters.claude.extraHooks = { check: false, acknowledged: [] }; });

  it('is said once by state:show', () => {
    off();
    const said = show();
    expect(said.match(/turns the extra-hooks check off/g)).toHaveLength(1);
    expect(said).toMatch(/^NOTE\s+claude: the rulebook turns the extra-hooks check off \(agent\.adapters\.claude\.extraHooks\.check\)/m);
  });

  it('is not mentioned while it is on', () => {
    expect(show()).not.toMatch(/extra-hooks check/);
  });
});
