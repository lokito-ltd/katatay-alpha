import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failureReport, lint, runLint } from './lint.js';

let root: string;

function catalogue(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'req-'));
  mkdirSync(join(root, 'acceptance'), { recursive: true });
  mkdirSync(join(root, 'invariants'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, path), content);
  }
  return root;
}

const ok = (status = 'accepted', extra = '', scenarios = '') =>
  `---\nstatus: ${status}\n${extra}---\n\nA statement that says something.\n${scenarios}`;

/** A requirement that lists one scenario per id given. */
const withScenarios = (status: string, ...ids: string[]) =>
  ok(status, '', `\n## Scenarios\n\n${ids.map((id) => `- [${id}] Something observable happens.`).join('\n')}\n`);

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lint', () => {
  it('accepts a well-formed catalogue', () => {
    expect(lint(catalogue({ 'acceptance/AC0001__a_slug.md': withScenarios('accepted', 'AC0001.1') }))).toEqual([]);
  });

  it('rejects a filename that does not carry an id', () => {
    const problems = lint(catalogue({ 'acceptance/some_notes.md': ok() }));
    expect(problems[0]!.message).toContain('filename must match');
  });

  it('rejects a requirement filed under the wrong type directory', () => {
    const problems = lint(catalogue({ 'acceptance/INV0001__a_slug.md': ok() }));
    expect(problems[0]!.message).toContain('must live in invariants/');
  });

  it('rejects a body with no statement', () => {
    const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': '---\nstatus: accepted\n---\n\n' }));
    expect(problems[0]!.message).toContain('no statement');
  });

  it('rejects an unknown status', () => {
    const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': ok('archived') }));
    expect(problems[0]!.message).toContain('status must be one of');
  });

  it('rejects a duplicate id across directories', () => {
    const problems = lint(catalogue({
      'acceptance/AC0001__one.md': withScenarios('accepted', 'AC0001.1'),
      'invariants/INV0001__two.md': ok(),
      'acceptance/AC0002__three.md': withScenarios('accepted', 'AC0002.1'),
    }));
    expect(problems).toEqual([]);
  });

  it('requires superseded to name its replacement', () => {
    const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': ok('superseded') }));
    expect(problems[0]!.message).toContain('requires supersededBy');
  });

  it('rejects supersededBy pointing at nothing', () => {
    const problems = lint(catalogue({
      'acceptance/AC0001__a_slug.md': ok('superseded', 'supersededBy: AC9999\n'),
    }));
    expect(problems.some((p) => p.message.includes('does not exist'))).toBe(true);
  });

  it('rejects a supersession trail that dead-ends in a withdrawn requirement', () => {
    const problems = lint(catalogue({
      'acceptance/AC0001__old.md': ok('superseded', 'supersededBy: AC0002\n'),
      'acceptance/AC0002__new.md': ok('withdrawn'),
    }));
    expect(problems.some((p) => p.message.includes('dead-ends'))).toBe(true);
  });

  it('rejects supersededBy on a requirement that is not superseded', () => {
    const problems = lint(catalogue({
      'acceptance/AC0001__a.md': ok('active', 'supersededBy: AC0002\n'),
      'acceptance/AC0002__b.md': ok(),
    }));
    expect(problems.some((p) => p.message.includes('only meaningful with status superseded'))).toBe(true);
  });

  it('follows a valid supersession trail', () => {
    expect(lint(catalogue({
      'acceptance/AC0001__old.md': ok('superseded', 'supersededBy: AC0002\n'),
      'acceptance/AC0002__new.md': withScenarios('active', 'AC0002.1'),
    }))).toEqual([]);
  });
});

describe('lint: scenarios', () => {
  it('requires an accepted or active acceptance criterion to have a scenario', () => {
    for (const status of ['accepted', 'active']) {
      const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': ok(status) }));
      expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('has no scenarios')]);
    }
  });

  it('leaves a retired acceptance criterion as it was written', () => {
    expect(lint(catalogue({
      'acceptance/AC0001__old.md': ok('withdrawn'),
    }))).toEqual([]);
  });

  it('lets an invariant go without scenarios', () => {
    expect(lint(catalogue({ 'invariants/INV0001__a_slug.md': ok('active') }))).toEqual([]);
  });

  it('rejects a scenario item that is not [ID] text, rather than dropping it', () => {
    const problems = lint(catalogue({
      'acceptance/AC0001__a_slug.md': ok('accepted', '', '\n## Scenarios\n\n- [AC0001.1] Fine.\n- Something with no id.\n'),
    }));
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('Something with no id.')]);
  });

  it('rejects a scenario id that belongs to another requirement', () => {
    const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': withScenarios('accepted', 'AC0002.1') }));
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('belongs to another requirement')]);
  });

  it('rejects a scenario id used twice', () => {
    const problems = lint(catalogue({ 'acceptance/AC0001__a_slug.md': withScenarios('accepted', 'AC0001.1', 'AC0001.1') }));
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('duplicate scenario id AC0001.1')]);
  });
});

// In `workflow verify` the checks print one after another, so details printed
// before their heading sit under the previous check's success line.
describe('the failure report', () => {
  it('prints its heading before its details', () => {
    expect(failureReport([{ path: 'requirements/acceptance/x.md', message: 'not a markdown file' }])).toEqual([
      'req:lint — 1 problem(s)',
      '  requirements/acceptance/x.md: not a markdown file',
    ]);
  });
});

/** The check as `workflow req lint` and the referee verify run it: it prints what
 *  it found and says whether it passed, rather than exiting. */
describe('runLint', () => {
  const printed = (run: () => boolean) => {
    const lines: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: string) => lines.push(line);
    console.error = (line: string) => lines.push(line);
    try {
      return { passed: run(), lines };
    } finally {
      [console.log, console.error] = [log, error];
    }
  };

  it('passes a well-formed catalogue and says so', () => {
    const dir = catalogue({ 'acceptance/AC0001__a_slug.md': withScenarios('accepted', 'AC0001.1') });
    expect(printed(() => runLint(dir))).toEqual({ passed: true, lines: ['req:lint — catalogue OK'] });
  });

  it('fails a broken one, heading first', () => {
    const dir = catalogue({ 'acceptance/some_notes.md': ok() });
    const { passed, lines } = printed(() => runLint(dir));
    expect(passed).toBe(false);
    expect(lines[0]).toBe('req:lint — 1 problem(s)');
  });
});
