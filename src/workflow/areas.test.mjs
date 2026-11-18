import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRequirementFile, renderAreas, reviewAreas } from './areas.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';

/**
 * Which files are high-risk is the operator's policy, in the rulebook. These
 * cases test what the review areas do with a list, so each writes a rulebook of
 * its own and never asserts what this repository's list holds.
 */
let root;
const withAreas = (highRisk) => writeConfig(root, { fields: { highRisk } });
const areas = (input) => reviewAreas({ ...input, root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'areas-'));
  withAreas([]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const GUARDED = { paths: ['guarded/**', 'Makefile'], why: 'Guarded. Read them.' };
const DATA = { paths: ['db/**'], why: 'Data. Every database runs them.' };

describe('review areas: must look', () => {
  it('lists the changed files of each high-risk area under that area\'s reason, in the rulebook\'s order', () => {
    withAreas([GUARDED, DATA]);
    const { must } = areas({ changed: ['db/0001.sql', 'guarded/a.mjs', 'src/x.ts', 'Makefile'] });
    expect(must).toEqual([
      { text: GUARDED.why, items: ['guarded/a.mjs', 'Makefile'] },
      { text: DATA.why, items: ['db/0001.sql'] },
    ]);
  });

  it('lists nothing for a file in no high-risk area, or one that only resembles a listed path', () => {
    withAreas([GUARDED]);
    expect(areas({ changed: ['src/x.ts', 'docs/guarded/a.md', 'Makefile.bak', 'src/Makefile'] }).must).toEqual([]);
  });

  it('lists nothing for a folder the rulebook does not name, however much the change edits it', () => {
    withAreas([GUARDED]);
    expect(areas({ changed: ['src/workflow/phase.mjs', 'src/evidence/risk.ts'] }).must).toEqual([]);
  });

  // In CI a reworded or retired requirement no longer fails the guard; it is
  // handed to the reviewer, and this list is how the reviewer hears of it.
  it('lists requirements that existed before and were changed, under their own reason', () => {
    const { must } = areas({
      changed: ['requirements/acceptance/AC0004__x.md', 'requirements/invariants/INV0001__y.md', 'requirements/changes/z.md'],
    });
    expect(must).toHaveLength(1);
    expect(must[0].text).toMatch(/requirements/);
    expect(must[0].items).toEqual(['requirements/acceptance/AC0004__x.md', 'requirements/invariants/INV0001__y.md']);
  });

  it('finds requirements under the folder the rulebook names', () => {
    writeConfig(root, { fields: { requirementsDir: 'specs/' } });
    const { must } = areas({ changed: ['specs/acceptance/AC0004__x.md', 'requirements/acceptance/AC0004__x.md'] });
    expect(must.flatMap((reason) => reason.items)).toEqual(['specs/acceptance/AC0004__x.md']);
  });

  it('leaves out a requirement added by this change, which takes no promise away', () => {
    const { must } = areas({
      changed: ['requirements/acceptance/AC0004__x.md', 'requirements/acceptance/AC0012__new.md'],
      added: ['requirements/acceptance/AC0012__new.md'],
    });
    expect(must.flatMap((reason) => reason.items)).toEqual(['requirements/acceptance/AC0004__x.md']);
  });

  // Lowering a minimum is the plainest way past the coverage check, and it is
  // a one-number edit in a data file. No session may write the file, but a
  // reviewer cannot tell who made an edit, only that it is there.
  it('lists the rulebook, even when its high-risk list is empty', () => {
    const { must } = areas({ changed: ['.katatay/rulebook.json', 'modules/projects/x.ts'] });
    expect(must).toHaveLength(1);
    expect(must[0].text).toMatch(/rulebook/);
    expect(must[0].items).toEqual(['.katatay/rulebook.json']);
  });

  // The logbook grows by an event whenever a hook runs. Listed, it would put a
  // line in every report, and the reviewer would learn to skip the reason.
  it('does not list the workflow logbook, which every change appends to', () => {
    expect(areas({ changed: ['.katatay/state/feat-x/0001__plan_approved.json'] }).must).toEqual([]);
  });

  it('does not take a file that only resembles the rulebook', () => {
    expect(areas({ changed: ['modules/.katatay/rulebook.json', '.katatay/rulebook.json.md'] }).must).toEqual([]);
  });

  // Product code, which no other reason would list, and a reason of its own,
  // so the reviewer knows which line to look for.
  it('lists files that gain a coverage ignore comment, under their own reason', () => {
    withAreas([GUARDED]);
    const { must } = areas({ changed: ['modules/projects/x.ts', 'guarded/a.mjs'], ignores: ['modules/projects/x.ts'] });
    expect(must.map((reason) => reason.items)).toEqual([['guarded/a.mjs'], ['modules/projects/x.ts']]);
    expect(must[1].text).toMatch(/coverage ignore comments/);
  });

  // A check silenced in one spot, with no test failing. The reason names the
  // check, so the reviewer knows which comment to look for.
  it('lists files that gain a check\'s suppression comment, under a reason naming the check', () => {
    const { must } = areas({ changed: ['a.mjs', 'b.py'], suppressed: [{ name: 'lint', files: ['a.mjs'] }, { name: 'scan', files: ['b.py'] }, { name: 'build', files: [] }] });
    expect(must).toEqual([
      { text: 'New suppressions of the lint check. Each silences it where it sits.', items: ['a.mjs'] },
      { text: 'New suppressions of the scan check. Each silences it where it sits.', items: ['b.py'] },
    ]);
  });

  it('says nothing about ignore comments when none were added', () => {
    expect(areas({ changed: ['modules/projects/x.ts'] }).must).toEqual([]);
    expect(areas({ changed: ['modules/projects/x.ts'], ignores: [] }).must).toEqual([]);
  });

  // With the indent `renderAreas` adds, a reason has to fit a 72-column commit
  // body, which the skill pastes without re-wrapping. These are the two reasons
  // this file writes; the rulebook's, and the referee's own for the rulebook,
  // are wrapped when rendered.
  it('words each reason it writes to fit a commit body', () => {
    const { must } = areas({
      changed: ['requirements/acceptance/AC0004__x.md'],
      ignores: ['modules/projects/x.ts'],
    });
    expect(must).toHaveLength(2);
    for (const { text } of must) expect(text.length, text).toBeLessThanOrEqual(70);
  });
});

// The reasons come from the rulebook, so their length is the rulebook's. The
// commit message skill pastes this output without re-wrapping it.
describe('review areas as text', () => {
  const x = 'x'.repeat(12);

  it('prints nothing at all when there is nothing to look at', () => {
    expect(renderAreas(areas({ changed: ['README.md'] }))).toEqual([]);
  });

  it('prints a title, each reason, and each item under it', () => {
    expect(renderAreas({
      must: [{ text: 'Read these.', items: ['a.ts', 'b.ts'] }, { text: 'And these.', items: ['c.ts'] }],
    })).toEqual(['Must look:', '  Read these.', '  - a.ts', '  - b.ts', '  And these.', '  - c.ts']);
  });

  it('indents every line it prints by the indent it is given', () => {
    expect(renderAreas({ must: [{ text: 'Read.', items: ['a'] }] }, '    ')).toEqual(['    Must look:', '      Read.', '      - a']);
  });

  // Seventy characters is the width a reason may take: 72 columns less the
  // two it is indented by. A word that makes exactly seventy stays.
  it('fills a line up to 70 characters, and starts the next with the word that would pass it', () => {
    const fits = `${x} ${x} ${x} ${x} ${x} yyyyy`;
    expect(fits).toHaveLength(70);
    expect(renderAreas({ must: [{ text: `${fits} z`, items: [] }] })).toEqual(['Must look:', `  ${fits}`, '  z']);
    const passes = `${x} ${x} ${x} ${x} ${x} yyyyyy`;
    expect(renderAreas({ must: [{ text: passes, items: [] }] })).toEqual(['Must look:', `  ${x} ${x} ${x} ${x} ${x}`, '  yyyyyy']);
  });

  it('leaves room for the indent it is given', () => {
    const text = `${x} ${x} ${x} ${x} ${x} yyyyy`;
    const lines = renderAreas({ must: [{ text, items: [] }] }, '    ');
    expect(lines).toEqual(['    Must look:', `      ${x} ${x} ${x} ${x} ${x}`, '      yyyyy']);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(72);
  });

  it('keeps every line of a long reason within 72 columns, and every word of it', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = renderAreas({ must: [{ text, items: ['f.ts'] }] }, '  ');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(72);
    expect(lines.slice(1, -1).map((line) => line.trim()).join(' ')).toBe(text);
  });

  it('reads any run of white space, newlines included, as one space', () => {
    expect(renderAreas({ must: [{ text: ' a  b\n\tc  ', items: [] }] })).toEqual(['Must look:', '  a b c']);
  });

  it('prints a word longer than the width on a line of its own', () => {
    const long = 'w'.repeat(90);
    expect(renderAreas({ must: [{ text: `a ${long} b`, items: [] }] })).toEqual(['Must look:', '  a', `  ${long}`, '  b']);
  });

  it('does not start with an empty line when the first word is longer than the width', () => {
    const long = 'w'.repeat(90);
    expect(renderAreas({ must: [{ text: `${long} b`, items: [] }] })).toEqual(['Must look:', `  ${long}`, '  b']);
  });

  it('prints only the items for a reason with no words', () => {
    expect(renderAreas({ must: [{ text: '  ', items: ['a'] }] })).toEqual(['Must look:', '  - a']);
  });
});

describe('which files are requirement files', () => {
  it('are the acceptance criteria and the invariants under the requirements folder', () => {
    expect(isRequirementFile('requirements/acceptance/AC0004__x.md', 'requirements/')).toBe(true);
    expect(isRequirementFile('requirements/invariants/INV0001__y.md', 'requirements/')).toBe(true);
  });

  it('are not the change files, the README, or a folder of that name deeper in', () => {
    for (const file of [
      'requirements/changes/z.md', 'requirements/README.md', 'requirements/changes/acceptance/z.md',
      'docs/requirements/acceptance/AC0004__x.md', 'acceptance/AC0004__x.md',
    ]) expect(isRequirementFile(file, 'requirements/'), file).toBe(false);
  });

  it('are found under whatever folder the rulebook names', () => {
    expect(isRequirementFile('specs/acceptance/AC0004__x.md', 'specs/')).toBe(true);
    expect(isRequirementFile('requirements/acceptance/AC0004__x.md', 'specs/')).toBe(false);
    expect(isRequirementFile('specs/changes/acceptance/z.md', 'specs/')).toBe(false);
  });
});
