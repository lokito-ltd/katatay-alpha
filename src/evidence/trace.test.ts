import { describe, expect, it } from 'vitest';
import { checksum } from '../requirements/checksum.js';
import { scenarioText, type Requirement, type Scenario, type Status } from '../requirements/parse.js';
import { bareIdsIn, idsIn, scenariosIn, type TaggedTest } from './tags.js';
import { failureReport, trace } from './trace.js';

const scenario = (id: string, text = `Scenario ${id} happens.`): Scenario =>
  ({ id, text: scenarioText(text), checksum: checksum(scenarioText(text)) });

/**
 * A requirement. An acceptance criterion gets one scenario, `<id>.1`, unless
 * others are given, so the tests about evidence in general can tag it the way
 * a real test would.
 */
const req = (id: string, status: Status, scenarios?: Scenario[]): Requirement => ({
  id,
  type: id.startsWith('INV') ? 'invariant' : 'acceptance',
  slug: 'a_slug',
  status,
  statement: `Statement for ${id}.`,
  checksum: checksum(`Statement for ${id}.`),
  supersededBy: undefined,
  path: `requirements/acceptance/${id}__a_slug.md`,
  scenarios: scenarios ?? (id.startsWith('AC') ? [scenario(`${id}.1`)] : []),
  malformedScenarios: [],
});

/** A test with this exact title. */
const titled = (file: string, title: string): TaggedTest =>
  ({ file, title, ids: idsIn(title), scenarios: scenariosIn(title), bare: bareIdsIn(title), notEvidence: null });

/** The same test, under `.skip` or `.todo`. */
const skipped = (test: TaggedTest): TaggedTest => ({ ...test, notEvidence: 'skipped' });

/** The same test, under `.fails`. */
const inverted = (test: TaggedTest): TaggedTest => ({ ...test, notEvidence: 'inverted' });

/** A test file the report leaves out, with the tags found in its text. */
const leftOut = (file: string, text: string) => ({ file, ids: idsIn(text), scenarios: scenariosIn(text), bare: bareIdsIn(text) });

/**
 * A test proving each id given. An AC id is tagged as its first scenario,
 * with that scenario's own words, and an INV id is tagged bare.
 */
const test_ = (file: string, ...ids: string[]): TaggedTest => titled(
  file,
  ids.map((id) => (id.startsWith('AC') ? `${scenario(`${id}.1`).text} [${id}.1]` : `[${id}]`)).join(' '),
);

const UNIT = 'tools/thing.test.ts';
const ACCEPTANCE = 'tests/acceptance/thing.test.ts';

describe('trace: evidence for active requirements', () => {
  it('passes when an active requirement has acceptance evidence', () => {
    expect(trace([req('AC0001', 'active')], [test_(ACCEPTANCE, 'AC0001')])).toEqual([]);
  });

  it('fails when an active requirement has no evidence at all', () => {
    const problems = trace([req('AC0001', 'active')], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('no acceptance test carries');
  });

  it('fails when an active requirement is evidenced only by unit tests', () => {
    const problems = trace([req('AC0001', 'active')], [test_(UNIT, 'AC0001'), test_(UNIT, 'AC0001')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('no acceptance test carries');
  });

  it('accepts a mix, so long as one test is acceptance', () => {
    expect(trace(
      [req('AC0001', 'active')],
      [test_(UNIT, 'AC0001'), test_(ACCEPTANCE, 'AC0001')],
    )).toEqual([]);
  });

  // The workflow depends on agreeing behaviour before implementing it, and
  // demanding evidence for an unbuilt requirement would make that impossible.
  // Found by the 2026-10-04 red-team pass: skipping the test the triage showed
  // failing reached `verified`, because a skipped test still counted here.
  it('fails when every test carrying an active requirement is skipped', () => {
    const problems = trace([req('INV0001', 'active')], [skipped(test_(ACCEPTANCE, 'INV0001'))]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['INV0001', expect.stringContaining('is skipped')],
    ]);
  });

  it('fails when every test carrying an active requirement is marked .fails', () => {
    const problems = trace([req('INV0001', 'active')], [inverted(test_(ACCEPTANCE, 'INV0001'))]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['INV0001', expect.stringContaining('marked as expected to fail')],
    ]);
  });

  // Found by the 2026-10-04 red-team pass: a tagged test moved to
  // `tests/integration/`, which no vitest project collects, kept counting.
  // A file the report leaves out now fails its tags, whatever the reason.
  it('fails the tags of a test file the report leaves out, once each, and not again as carrying no test', () => {
    const problems = trace([req('INV0001', 'active')], [], [leftOut(ACCEPTANCE, "it('holds [INV0001]'); it('still holds [INV0001]');")]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['INV0001', `tagged in ${ACCEPTANCE}, which the test report leaves out — the file failed to load, or the run never reached it`],
    ]);
  });

  // The left-out file is said once, and the test that does not count is
  // still said: it is a reason of its own.
  it('still says why a requirement\'s only test does not count, beside a file the report left out', () => {
    const problems = trace([req('INV0001', 'active')], [skipped(test_(ACCEPTANCE, 'INV0001'))], [leftOut('tests/acceptance/other.test.ts', '[INV0001]')]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['INV0001', expect.stringContaining('which the test report leaves out')],
      ['INV0001', expect.stringContaining('is skipped')],
    ]);
  });

  it('fails a left-out file\'s tags even beside a test that runs', () => {
    const problems = trace([req('INV0001', 'active')], [test_(ACCEPTANCE, 'INV0001')], [leftOut('tests/acceptance/other.test.ts', '[INV0001]')]);
    expect(problems.map((p) => p.id)).toEqual(['INV0001']);
  });

  it('names every reason when the tests fail to count for different ones', () => {
    const problems = trace([req('INV0001', 'active')], [skipped(test_(ACCEPTANCE, 'INV0001')), inverted(test_(ACCEPTANCE, 'INV0001'))]);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/is skipped.*; or marked as expected to fail/),
    ]);
  });

  it('exempts accepted requirements, which are agreed but unbuilt', () => {
    expect(trace([req('AC0001', 'accepted')], [])).toEqual([]);
  });
});

describe('trace: tags must resolve', () => {
  it('fails on a tag naming a requirement that does not exist', () => {
    const problems = trace([], [test_(ACCEPTANCE, 'AC0404')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('no such requirement');
  });

  it('ignores unknown and mismatched ordinary tags, including tags in a missing ordinary file', () => {
    expect(trace([req('AC0001', 'active')], [
      test_(ACCEPTANCE, 'AC0001'), test_(UNIT, 'AC0404'), titled(UNIT, 'Wrong title [AC0001.1]'),
    ], [leftOut(UNIT, '[INV0404]')])).toEqual([]);
  });

  it('fails on evidence still tagged to a withdrawn requirement', () => {
    const problems = trace([req('AC0001', 'withdrawn')], [test_(ACCEPTANCE, 'AC0001')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('withdrawn');
  });

  it('fails on evidence still tagged to a superseded requirement', () => {
    const problems = trace([req('AC0001', 'superseded')], [test_(ACCEPTANCE, 'AC0001')]);
    expect(problems[0]!.message).toContain('superseded');
  });

  it('reports one problem per requirement, not per test', () => {
    const problems = trace([], [test_(UNIT, 'AC0404'), test_(ACCEPTANCE, 'AC0404')]);
    expect(problems).toHaveLength(1);
  });

  it('handles a test carrying several tags', () => {
    expect(trace(
      [req('INV0001', 'active'), req('INV0002', 'active')],
      [test_(ACCEPTANCE, 'INV0001', 'INV0002')],
    )).toEqual([]);
  });
});

describe('trace: scenarios and the tests that prove them', () => {
  const AC = req('AC0009', 'active', [scenario('AC0009.1', 'A paste of exactly `50,000` characters is kept.'), scenario('AC0009.3', 'A longer one is refused.')]);
  const both = [
    titled(ACCEPTANCE, 'A paste of exactly 50,000 characters is kept. [AC0009.1]'),
    titled(ACCEPTANCE, 'A longer one is refused. [AC0009.3]'),
  ];

  it('passes when every scenario has a test whose title is its text', () => {
    expect(trace([AC], both)).toEqual([]);
  });

  it('fails on a scenario of an active requirement that no acceptance test carries', () => {
    const problems = trace([AC], [both[0]!]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('no acceptance test carries [AC0009.3]')],
    ]);
  });

  it('fails on a scenario evidenced only by unit tests', () => {
    const problems = trace([AC], [both[0]!, titled(UNIT, 'A longer one is refused. [AC0009.3]')]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('no acceptance test carries')],
    ]);
  });

  it('fails on a scenario whose only test is skipped', () => {
    const problems = trace([AC], [both[0]!, skipped(both[1]!)]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('is skipped')],
    ]);
  });

  it('fails on a scenario whose only test is marked .fails, and says so', () => {
    const problems = trace([AC], [both[0]!, inverted(both[1]!)]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('marked as expected to fail')],
    ]);
  });

  it('fails on a scenario whose only test is in a file the report leaves out, and says so once', () => {
    const problems = trace([AC], [both[0]!], [leftOut(ACCEPTANCE, "it('A longer one is refused. [AC0009.3]')")]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('which the test report leaves out')],
    ]);
  });

  it('accepts a skipped test beside one that runs', () => {
    expect(trace([AC], [...both, skipped(both[1]!)])).toEqual([]);
  });

  // Skipping a test must not also switch off the checks on what it says.
  it('still checks the title of a skipped test', () => {
    const problems = trace([AC], [...both, skipped(titled(ACCEPTANCE, 'refuses a longer one [AC0009.3]'))]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.3', expect.stringContaining('does not match its scenario')],
    ]);
  });

  it('asks nothing of an accepted requirement\'s scenarios', () => {
    expect(trace([req('AC0009', 'accepted', AC.scenarios)], [])).toEqual([]);
  });

  it('fails on a title that does not say what its scenario says', () => {
    const problems = trace([AC], [both[0]!, titled(ACCEPTANCE, 'refuses a longer one [AC0009.3]')]);
    expect(problems.map((p) => p.id)).toEqual(['AC0009.3']);
    expect(problems[0]!.message).toContain('does not match its scenario');
    expect(problems[0]!.message).toContain('A longer one is refused.');
  });

  it('compares words only: case, whitespace and punctuation are ignored', () => {
    expect(trace([AC], [titled(ACCEPTANCE, 'A  paste of exactly `50,000`\ncharacters is kept.  [AC0009.1]'), both[1]!])).toEqual([]);
    expect(trace([AC], [titled(ACCEPTANCE, 'a paste of exactly 50 000 characters, is kept [AC0009.1]'), both[1]!])).toEqual([]);
    expect(trace([AC], [titled(ACCEPTANCE, 'a paste of exactly 50,000 characters is not kept. [AC0009.1]'), both[1]!]))
      .toHaveLength(1);
  });

  // A report names a test with the groups around it in front.
  it('lets the group names in front of a title fall away, and nothing of the title itself', () => {
    expect(trace([AC], [titled(ACCEPTANCE, 'pastes > A paste of exactly 50,000 characters is kept. [AC0009.1]'), both[1]!])).toEqual([]);
    expect(trace([AC], [titled(ACCEPTANCE, 'Not a paste of exactly 50,000 characters is kept. [AC0009.1]'), both[1]!])).toHaveLength(1);
  });

  it('fails on a tag naming a scenario the requirement does not have', () => {
    const problems = trace([AC], [...both, titled(ACCEPTANCE, 'Something else. [AC0009.2]')]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009.2', expect.stringContaining('no such scenario')],
    ]);
  });

  it('reports a scenario of a requirement that does not exist once, as the requirement', () => {
    const problems = trace([], [titled(ACCEPTANCE, 'Something. [AC0404.1]')]);
    expect(problems.map((p) => p.id)).toEqual(['AC0404']);
  });

  it('fails on a test that names two scenarios', () => {
    const problems = trace([AC], [...both, titled(ACCEPTANCE, 'Both. [AC0009.1] [AC0009.3]')]);
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('names 2 scenarios')]);
  });

  it('fails on an acceptance criterion tagged bare, since the tag names nothing to check', () => {
    const problems = trace([AC], [...both, titled(ACCEPTANCE, 'does a thing [AC0009]')]);
    expect(problems.map((p) => [p.id, p.message])).toEqual([
      ['AC0009', expect.stringContaining('tag the scenario it proves')],
    ]);
  });

  it('still lets an invariant be tagged bare', () => {
    expect(trace([req('INV0001', 'active')], [titled(ACCEPTANCE, 'holds [INV0001]')])).toEqual([]);
  });
});

// In `workflow verify` the trace runs after the guard, so details printed before
// their heading sit under the guard's success line.
describe('the failure report', () => {
  it('prints its heading before its details', () => {
    expect(failureReport([{ id: 'AC0001.1', message: 'has no test' }])).toEqual([
      'req:trace — 1 problem(s)',
      '  AC0001.1: has no test',
    ]);
  });
});
