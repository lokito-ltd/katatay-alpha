import { describe, expect, it } from 'vitest';
import { bareIdsIn, groupSuffixes, idsIn, sameWords, scenariosIn, scenariosOfFile, tagsOfFile, taggedTests, withoutTags, words } from './tags.js';
import type { TestCase, TestRun } from './test-run.js';

describe('idsIn', () => {
  it('reads acceptance and invariant ids', () => {
    expect(idsIn('does a thing [AC0001] and another [INV0002]')).toEqual(['AC0001', 'INV0002']);
  });

  it('ignores malformed ids', () => {
    expect(idsIn('[AC1] [ACC0001] [AC00011] AC0001 [AC0001.] [AC0001.x]')).toEqual([]);
  });

  // Everything that thinks in requirements, such as the risk report, reads
  // `ids`, so a scenario tag has to count toward its requirement there.
  it('counts a scenario tag toward its requirement, once', () => {
    expect(idsIn('A thing happens. [AC0009.2] [AC0009.3]')).toEqual(['AC0009']);
  });
});

describe('scenariosIn and bareIdsIn', () => {
  it('tells a scenario tag from a bare one', () => {
    const title = 'A thing happens. [AC0009.12] [AC0001] [INV0002]';
    expect(scenariosIn(title)).toEqual(['AC0009.12']);
    expect(bareIdsIn(title)).toEqual(['AC0001', 'INV0002']);
  });
});

describe('withoutTags', () => {
  it('leaves the words a scenario must match', () => {
    expect(withoutTags('A thing happens. [AC0009.2]').trim()).toBe('A thing happens.');
  });
});

/** A test case as the run reads it from a report, its tags read from its name. */
const testCase = (name: string, more: Partial<TestCase> = {}): TestCase => ({
  file: 'a.test.ts', name, status: 'passed', message: null,
  ids: idsIn(name), scenarios: scenariosIn(name), bare: bareIdsIn(name), inverted: false, ...more,
});
const runOf = (cases: TestCase[], leftOut: TestRun['leftOut'] = []): TestRun => ({ cases, leftOut, exit: 0 });

describe('taggedTests', () => {
  // The report holds every test. The referee keeps the tagged ones, so a
  // runner never has to know what a requirement is.
  it('keeps the test cases that carry a tag', () => {
    expect(taggedTests(runOf([testCase('a thing'), testCase('rejecting > A proposal is rejected. [AC0001.2]')]))).toEqual([
      { file: 'a.test.ts', title: 'rejecting > A proposal is rejected. [AC0001.2]', ids: ['AC0001'], scenarios: ['AC0001.2'], bare: [], notEvidence: null },
    ]);
  });

  it('carries why a test case is not evidence', () => {
    const found = taggedTests(runOf([
      testCase('a [AC0001.1]', { status: 'skipped' }),
      testCase('b [AC0001.2]', { inverted: true }),
      testCase('c [AC0001.3]', { status: 'skipped', inverted: true }),
      testCase('d [AC0001.4]', { status: 'failed' }),
    ]));
    expect(found.map((t) => [t.title, t.notEvidence])).toEqual([
      ['a [AC0001.1]', 'skipped'], ['b [AC0001.2]', 'inverted'], ['c [AC0001.3]', 'skipped'], ['d [AC0001.4]', null],
    ]);
  });
});

describe('tagsOfFile', () => {
  // A failure that stands for a whole file lands in the bucket its tests would
  // have, so it carries every tag in the file, once each.
  it('gives every requirement the file\'s tests carry, once each', () => {
    const run = runOf([
      testCase('one [AC0001.1]'),
      testCase('two [AC0001.2] [INV0003]', { status: 'skipped' }),
      testCase('other [AC0009.1]', { file: 'b.test.ts' }),
    ]);
    expect(tagsOfFile(run, 'a.test.ts')).toEqual(['AC0001', 'INV0003']);
    expect(tagsOfFile(run, 'c.test.ts')).toEqual([]);
  });

  it('gives a file the report left out the tags found in its text', () => {
    const run = runOf([], [
      { file: 'a.test.ts', ids: ['AC0002', 'INV0001'], scenarios: ['AC0002.1'], bare: ['INV0001'] },
      { file: 'b.test.ts', ids: ['AC0009'], scenarios: ['AC0009.1'], bare: [] },
    ]);
    expect(tagsOfFile(run, 'a.test.ts')).toEqual(['AC0002', 'INV0001']);
    expect(tagsOfFile(run, 'b.test.ts')).toEqual(['AC0009']);
  });
});

/** The scenarios behind a whole-file failure, which a prediction by scenario
 *  matches. Read as `tagsOfFile` reads requirement ids. */
describe('scenariosOfFile', () => {
  it('gives every scenario the file\'s tests carry, and its text when the report left it out, once each', () => {
    const run = runOf([
      testCase('one [AC0001.1]'),
      testCase('again [AC0001.1] [AC0001.2]'),
      testCase('other [AC0009.1]', { file: 'b.test.ts' }),
    ], [
      { file: 'a.test.ts', ids: ['AC0002'], scenarios: ['AC0002.1'], bare: [] },
      { file: 'c.test.ts', ids: ['AC0008'], scenarios: ['AC0008.1'], bare: [] },
    ]);
    expect(scenariosOfFile(run, 'a.test.ts')).toEqual(['AC0001.1', 'AC0001.2', 'AC0002.1']);
    expect(scenariosOfFile(run, 'd.test.ts')).toEqual([]);
  });
});

describe('groupSuffixes', () => {
  it('takes the group names in front off one at a time, at each separator a runner uses', () => {
    expect(groupSuffixes('a > b > the title')).toEqual(['a > b > the title', 'b > the title', 'the title']);
    expect(groupSuffixes('TestThing/the_title')).toEqual(['TestThing/the_title', 'the_title']);
    expect(groupSuffixes('tests/x.py::TestThing::test_title')).toEqual(['tests/x.py::TestThing::test_title', 'x.py::TestThing::test_title', 'TestThing::test_title', 'test_title']);
    expect(groupSuffixes('no groups')).toEqual(['no groups']);
  });
});

describe('words', () => {
  it('ignores case, whitespace and punctuation', () => {
    expect(words('  A Rejected,   proposal — is GONE.  ')).toBe('a rejected proposal is gone');
    expect(words('the `startProject` call')).toBe('the startproject call');
  });

  it('drops apostrophes, so a possessive and a plural are one word', () => {
    expect(words("the proposal's source")).toBe(words('the proposals source'));
    expect(words('the proposal\u2019s source')).toBe('the proposals source');
  });

  it('counts any other symbol, the underscore included, as a space', () => {
    expect(words('a_rejected_proposal')).toBe('a rejected proposal');
    expect(words('one+two/three')).toBe('one two three');
  });

  // A scenario may hold a camelCase word of its own.
  it('keeps camelCase whole', () => {
    expect(words('startProject')).toBe('startproject');
    expect(words('startProject')).not.toBe(words('start project'));
  });

  it('keeps letters outside English', () => {
    expect(words('Zażółć gęślą jaźń')).toBe('zażółć gęślą jaźń');
  });
});

describe('sameWords', () => {
  const scenario = 'A rejected proposal is not in the public catalogue.';

  it('matches a name that says the scenario word for word, its tags taken out', () => {
    expect(sameWords('A rejected proposal is not in the public catalogue. [AC0001.1]', scenario)).toBe(true);
    expect(sameWords('a rejected proposal, is not in the public-catalogue [AC0001.1]', scenario)).toBe(true);
  });

  it('lets the group names in front of the title fall away', () => {
    expect(sameWords('proposals > rejecting > A rejected proposal is not in the public catalogue. [AC0001.1]', scenario)).toBe(true);
    expect(sameWords('TestProposals/a_rejected_proposal_is_not_in_the_public_catalogue', scenario)).toBe(true);
  });

  // Only whole groups fall away, never the title's own leading words.
  it('never lets the title\'s own leading words fall away', () => {
    expect(sameWords('Not a rejected proposal is not in the public catalogue. [AC0001.1]', scenario)).toBe(false);
    expect(sameWords('proposals > Not a rejected proposal is not in the public catalogue.', scenario)).toBe(false);
  });

  it('refuses a name with a word more, a word fewer or a word changed', () => {
    expect(sameWords('A rejected proposal is not in the public catalogue yet.', scenario)).toBe(false);
    expect(sameWords('A rejected proposal is not in the catalogue.', scenario)).toBe(false);
    expect(sameWords('An accepted proposal is not in the public catalogue.', scenario)).toBe(false);
  });
});
