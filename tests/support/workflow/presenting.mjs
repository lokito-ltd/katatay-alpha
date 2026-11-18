import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ctx, planFile } from '../machine/harness.mjs';
import { onTurnEnd } from '../../../src/workflow/moments/turn-end.mjs';

export const valid = '# A plan\n\n## Why\nNeed.\n\n## What\nBehaviour.\n\n## How\nDesign.\n\n## Requirements\nNone.\n\n## Predicted failures\nNone.\n\n## Test delta\nNew cases.\n';
export const inFixture = (fn) => {
  const cwd = process.cwd(); const home = process.env.HOME;
  try {
    process.chdir(ctx.repo); process.env.HOME = ctx.home;
    if (realpathSync(process.cwd()) !== realpathSync(ctx.repo)) throw new Error('not in fixture');
    return fn();
  } finally { process.chdir(cwd); process.env.HOME = home; }
};
export const present = (text = valid) => {
  const file = planFile('presented.md');
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
  return file;
};
export const end = (extra = {}, world) => inFixture(() => onTurnEnd({ stopRefusedBefore: false, secondsLeft: 0, ...extra }, world));
export const said = (result) => result.messages.map((m) => m.text).join('\n');
export const switchTo = (validateFormat) => {
  const file = join(ctx.repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.plans.validateFormat = validateFormat;
  writeFileSync(file, JSON.stringify(config));
};
