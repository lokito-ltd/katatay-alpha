import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { renumber } from './renumber.js';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';

const cwd = process.cwd();
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'renum-'));
  mkdirSync(join(root, 'requirements/acceptance'), { recursive: true });
  mkdirSync(join(root, 'requirements/invariants'), { recursive: true });
  mkdirSync(join(root, 'requirements/changes'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  // A repository with a target, because renumbering asks the target whether an
  // id has already been agreed, and refuses when there is no target to ask.
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  configureTarget(root);
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const body = (statement: string) => `---\nstatus: accepted\n---\n\n${statement}\n`;

describe('renumber', () => {
  it('renames the file and rewrites every reference to the old id', () => {
    writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
    writeFileSync('requirements/changes/20260908T120000.000Z__a_change.md', '## What\n\n- added AC0009\n');
    writeFileSync('tools/example.test.ts', `it('does the thing [AC0009]', () => {});\n`);

    renumber('AC0009', 'AC0021');

    expect(existsSync('requirements/acceptance/AC0009__a_slug.md')).toBe(false);
    expect(existsSync('requirements/acceptance/AC0021__a_slug.md')).toBe(true);
    expect(readFileSync('requirements/changes/20260908T120000.000Z__a_change.md', 'utf8')).toContain('AC0021');
    expect(readFileSync('tools/example.test.ts', 'utf8')).toContain('[AC0021]');
  });

  it('rewrites the tags on acceptance tests, end-to-end tests and pages', () => {
    writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
    mkdirSync('tests/acceptance', { recursive: true });
    mkdirSync('tests/e2e', { recursive: true });
    mkdirSync('app/projects', { recursive: true });
    writeFileSync('tests/acceptance/a.test.ts', `it('A thing. [AC0009.1]', () => {});\n`);
    writeFileSync('tests/e2e/a.spec.ts', `test('A journey. [AC0009.2]', async () => {});\n`);
    writeFileSync('app/projects/page.tsx', `// AC0009: the page shows the thing\n`);

    renumber('AC0009', 'AC0021');

    expect(readFileSync('tests/acceptance/a.test.ts', 'utf8')).toContain('[AC0021.1]');
    expect(readFileSync('tests/e2e/a.spec.ts', 'utf8')).toContain('[AC0021.2]');
    expect(readFileSync('app/projects/page.tsx', 'utf8')).toContain('AC0021');
  });

  // Found through git, not through a list of folders, so a repository laid
  // out another way is covered too.
  it('rewrites code wherever it sits, not only in the folders this repository uses', () => {
    writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
    mkdirSync('src/lib', { recursive: true });
    writeFileSync('src/lib/thing.ts', '// AC0009: why this exists\n');

    renumber('AC0009', 'AC0021');

    expect(readFileSync('src/lib/thing.ts', 'utf8')).toContain('AC0021');
  });

  // The catalogue and its change files are where the rulebook says. A file of the
  // same kind in the default folder is not part of it.
  it('works in the folder the rulebook names, and leaves the default one and the folder\'s other files alone', () => {
    writeConfig(root, { fields: { requirementsDir: 'specs/' } });
    mkdirSync('specs/acceptance', { recursive: true });
    mkdirSync('specs/changes', { recursive: true });
    writeFileSync('specs/acceptance/AC0009__a_slug.md', body('A statement.'));
    writeFileSync('specs/changes/20260908T120000.000Z__a_change.md', '## What\n\n- added AC0009\n');
    writeFileSync('specs/notes.txt', 'AC0009\n');
    writeFileSync('requirements/changes/20260101T000000.000Z__old.md', '## What\n\n- added AC0009\n');

    renumber('AC0009', 'AC0021');

    expect(existsSync('specs/acceptance/AC0021__a_slug.md')).toBe(true);
    expect(existsSync('specs/acceptance/AC0009__a_slug.md')).toBe(false);
    expect(readFileSync('specs/changes/20260908T120000.000Z__a_change.md', 'utf8')).toContain('AC0021');
    expect(readFileSync('specs/notes.txt', 'utf8')).toContain('AC0009');
    expect(readFileSync('requirements/changes/20260101T000000.000Z__old.md', 'utf8')).toContain('AC0009');
  });

  // Prose outside the catalogue keeps the id it was written with: a follow-up
  // or a guide naming an old id is history, and data files are not ours to
  // rewrite. Ignored files are not this repository's at all.
  it('leaves alone what is neither the catalogue, a test nor code', () => {
    writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
    mkdirSync('docs', { recursive: true });
    writeFileSync('README.md', 'See AC0009.\n');
    writeFileSync('docs/guide.md', 'See AC0009.\n');
    writeFileSync('notes.txt', 'AC0009\n');
    writeFileSync('data.json', '{ "id": "AC0009" }\n');
    writeFileSync('.gitignore', 'ignored.ts\n');
    writeFileSync('ignored.ts', '// AC0009\n');

    renumber('AC0009', 'AC0021');

    for (const file of ['README.md', 'docs/guide.md', 'notes.txt', 'data.json', 'ignored.ts']) {
      expect(readFileSync(file, 'utf8'), file).toContain('AC0009');
    }
  });

  // Git still lists a tracked file that was deleted and not staged. Reading
  // it would fail the whole renumber.
  it('passes over a tracked file that is gone from disk', () => {
    writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
    writeFileSync('tools/gone.ts', '// AC0009\n');
    execFileSync('git', ['add', 'tools/gone.ts'], { cwd: root });
    rmSync('tools/gone.ts');

    expect(() => renumber('AC0009', 'AC0021')).not.toThrow();
    expect(existsSync('requirements/acceptance/AC0021__a_slug.md')).toBe(true);
  });

  it('refuses to renumber onto an id that is already taken', () => {
    writeFileSync('requirements/acceptance/AC0009__a.md', body('One.'));
    writeFileSync('requirements/acceptance/AC0021__b.md', body('Two.'));
    expect(() => renumber('AC0009', 'AC0021')).toThrow(/already taken/);
  });

  it('refuses to change a requirement from acceptance to invariant', () => {
    writeFileSync('requirements/acceptance/AC0009__a.md', body('One.'));
    expect(() => renumber('AC0009', 'INV0009')).toThrow(/cannot change a requirement's type/);
  });

  it('refuses when the requirement does not exist', () => {
    expect(() => renumber('AC0009', 'AC0021')).toThrow(/not found/);
  });

  describe('an id the target already knows', () => {
    // AC0009 committed and on the target: it has been agreed.
    beforeEach(() => {
      writeFileSync('requirements/acceptance/AC0009__a_slug.md', body('A statement.'));
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'agreed'], { cwd: root });
      markTarget(root);
    });

    const approval = (renumberedFrom: string, id = 'AC0021') =>
      [{ id, renumberedFrom, status: 'accepted' as const, statement: 'A statement.' }];

    it('refuses without an approved plan, and says how to get one', () => {
      expect(() => renumber('AC0009', 'AC0021')).toThrow(/renumberedFrom: AC0009/);
      expect(existsSync('requirements/acceptance/AC0009__a_slug.md')).toBe(true);
    });

    it('renumbers it when the approved plan names both ids', () => {
      renumber('AC0009', 'AC0021', approval('AC0009'));
      expect(existsSync('requirements/acceptance/AC0021__a_slug.md')).toBe(true);
    });

    it('refuses when the approved plan names a different pair', () => {
      expect(() => renumber('AC0009', 'AC0021', approval('AC0008'))).toThrow(/exists on main/);
      expect(() => renumber('AC0009', 'AC0021', approval('AC0009', 'AC0022'))).toThrow(/exists on main/);
      expect(() => renumber('AC0009', 'AC0021', [{ id: 'AC0021', status: 'accepted', statement: 'A statement.' }]))
        .toThrow(/exists on main/);
    });
  });
});
