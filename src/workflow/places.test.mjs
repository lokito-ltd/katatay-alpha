import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inPlansFolder, isRulebookExempt, real } from './places.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';

let root;
let home;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'places-root-'));
  home = mkdtempSync(join(tmpdir(), 'places-home-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const rulebook = (fields = {}) => writeConfig(root, { fields });
const exempt = (path) => isRulebookExempt(path, root, home);

describe('the files the rulebook says need no plan', () => {
  it('cover a Markdown file directly in the plans folder, from the home folder', () => {
    rulebook();
    expect(exempt(join(home, '.claude/plans/a-plan.md'))).toBe(true);
  });

  // A folder git would commit is the operator's choice too: the rulebook is
  // theirs, and it refuses a plans folder at the root.
  it('cover a plan in a plans folder inside the repository, by either spelling', () => {
    rulebook({ plans: { dir: 'plans/' } });
    expect(exempt('plans/a-plan.md')).toBe(true);
    expect(exempt(join(root, 'plans/a-plan.md'))).toBe(true);
    expect(exempt(join(home, '.claude/plans/a-plan.md'))).toBe(false);
  });

  it('cover neither a subfolder of the plans folder nor a file there that is not Markdown', () => {
    rulebook();
    expect(exempt(join(home, '.claude/plans/drafts/a-plan.md'))).toBe(false);
    expect(exempt(join(home, '.claude/plans/hook.mjs'))).toBe(false);
    expect(exempt(join(home, '.claude/a-plan.md'))).toBe(false);
  });

  it('cover the follow-ups file the rulebook names, and FOLLOW-UPS.md only by default', () => {
    rulebook();
    expect(exempt('FOLLOW-UPS.md')).toBe(true);
    expect(exempt(join(root, 'FOLLOW-UPS.md'))).toBe(true);
    expect(exempt('docs/FOLLOW-UPS.md')).toBe(false);
    rulebook({ followUpsFile: 'docs/LATER.md' });
    expect(exempt('docs/LATER.md')).toBe(true);
    expect(exempt('FOLLOW-UPS.md')).toBe(false);
  });

  it('cover nothing else', () => {
    rulebook();
    for (const path of ['source.ts', 'CLAUDE.md', join(home, '.claude/settings.json'), '', null, undefined, 3]) {
      expect(exempt(path), String(path)).toBe(false);
    }
  });

  // A plan-shaped name that is really a link to something else is that
  // something else.
  it('judge a symlink by what it points at', () => {
    rulebook();
    mkdirSync(join(home, '.claude/plans'), { recursive: true });
    writeFileSync(join(home, '.claude/settings.json'), '{}');
    symlinkSync(join(home, '.claude/settings.json'), join(home, '.claude/plans/innocent.md'));
    expect(exempt(join(home, '.claude/plans/innocent.md'))).toBe(false);
  });

  // The first plan is written before the folder exists. On macOS the
  // temporary folder is /var and resolves to /private/var, so a plan whose
  // folder is missing has to be spelled the same way as the folder.
  it('cover a plan whose folder does not exist yet', () => {
    rulebook({ plans: { dir: '~/not-yet/plans' } });
    expect(exempt(join(home, 'not-yet/plans/a-plan.md'))).toBe(true);
  });

  // The referee has no plans folder of its own to fall back to, and no
  // approval is recorded while the rulebook is refused.
  it('are only FOLLOW-UPS.md when the rulebook is refused or missing', () => {
    for (const write of [() => rulebook({ plans: { dir: '.' } }), () => rmSync(join(root, '.katatay'), { recursive: true, force: true })]) {
      write();
      expect(exempt('FOLLOW-UPS.md')).toBe(true);
      expect(exempt(join(home, '.claude/plans/a-plan.md'))).toBe(false);
      expect(exempt('CLAUDE.md')).toBe(false);
    }
  });
});

// What an approval may name: the same files the gate lets an agent write
// without a plan, so a plan that could be written can be approved and one
// that could not cannot.
describe('a plan file an approval may name', () => {
  it('is a Markdown file directly in the plans folder, symlinks resolved', () => {
    rulebook();
    const plans = join(home, '.claude/plans');
    mkdirSync(plans, { recursive: true });
    symlinkSync(plans, join(home, 'linked'));
    expect(inPlansFolder(join(plans, 'a-plan.md'), root, home)).toBe(true);
    expect(inPlansFolder(join(home, 'linked', 'a-plan.md'), root, home)).toBe(true);
  });

  it('is not a file in a subfolder, elsewhere, or not Markdown', () => {
    rulebook();
    expect(inPlansFolder(join(home, '.claude/plans/drafts/a-plan.md'), root, home)).toBe(false);
    expect(inPlansFolder(join(home, 'a-plan.md'), root, home)).toBe(false);
    expect(inPlansFolder(join(home, '.claude/plans/a-plan.txt'), root, home)).toBe(false);
    expect(inPlansFolder('', root, home)).toBe(false);
  });

  it('reads a plans folder inside the repository from the repository root', () => {
    rulebook({ plans: { dir: 'plans/' } });
    expect(inPlansFolder('plans/a-plan.md', root, home)).toBe(true);
    expect(inPlansFolder(join(root, 'plans', 'a-plan.md'), root, home)).toBe(true);
  });

  // Unlike the gate, which falls back to the follow-ups file: an approval
  // needs the folder, and has none to fall back to.
  it('cannot be named while the rulebook is missing', () => {
    rmSync(join(root, '.katatay'), { recursive: true, force: true });
    expect(() => inPlansFolder(join(home, '.claude/plans/a-plan.md'), root, home)).toThrow();
  });
});

describe('a path with symlinks resolved', () => {
  it('resolves the nearest folder that exists, and keeps the rest', () => {
    const base = real(root);
    expect(real(join(root, 'a/b/c.md'))).toBe(join(base, 'a/b/c.md'));
    expect(real(root)).toBe(base);
  });
});
