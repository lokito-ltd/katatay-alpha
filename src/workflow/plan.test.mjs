import { describe, expect, it } from 'vitest';
import { declarationsOf, parsePrediction, readPlan, requirementChangesIn } from './plan.mjs';
import { planFormat } from './plan-format.mjs';

/** The problems a plan's declarations can have where they sit. */
const TOP = 'it opens with `---` frontmatter, which is no longer read: its declarations go in a `workflow` block at its end';
const ONE = 'a plan holds one `workflow` block, at its end: the last thing in the file, closed by its own fence';
const DASHES = 'a line in the `workflow` block starts with `---`, which would end the YAML there';

/**
 * The requirement changes a plan asks the operator to approve. Read from the
 * plan's closing `workflow` block only, and each entry must state its result in full, because the
 * guard compares it with the catalogue and accepts nothing less.
 */
describe('requirementChangesIn', () => {
  const plan = (front) => `# Plan\n\n\`\`\`workflow\n${front}\n\`\`\`\n`;

  it('reads each change as its resulting requirement', () => {
    expect(requirementChangesIn(plan([
      'requirement-changes:',
      '  - id: AC0004',
      '    status: active',
      '    statement: "  A project opens for its owner.  "',
      '  - id: INV0002',
      '    status: withdrawn',
      '    statement: Something no longer wanted.',
    ].join('\n')))).toEqual([
      { id: 'AC0004', status: 'active', statement: 'A project opens for its owner.', scenarios: [] },
      { id: 'INV0002', status: 'withdrawn', statement: 'Something no longer wanted.', scenarios: [] },
    ]);
  });

  it('reads the scenarios an approved change lists', () => {
    expect(requirementChangesIn(plan([
      'requirement-changes:',
      '  - id: AC0004',
      '    status: active',
      '    statement: A project opens for its owner.',
      '    scenarios:',
      '      - "[AC0004.1] The owner opens it. "',
      '      - "[AC0004.3] A stranger does not."',
    ].join('\n')))).toEqual([{
      id: 'AC0004',
      status: 'active',
      statement: 'A project opens for its owner.',
      scenarios: ['[AC0004.1] The owner opens it.', '[AC0004.3] A stranger does not.'],
    }]);
  });

  it('reads the old id a renumber names', () => {
    expect(requirementChangesIn(plan([
      'requirement-changes:',
      '  - id: AC0009',
      '    renumberedFrom: AC0001',
      '    status: active',
      '    statement: A project opens for its owner.',
    ].join('\n')))).toEqual([{
      id: 'AC0009',
      renumberedFrom: 'AC0001',
      status: 'active',
      statement: 'A project opens for its owner.',
      scenarios: [],
    }]);
  });

  it('drops an entry whose old id is malformed, of another type, or the same id', () => {
    for (const from of ['AC1', 'INV0001', 'AC0009', '[AC0001]']) {
      expect(requirementChangesIn(plan([
        'requirement-changes:',
        '  - id: AC0009',
        `    renumberedFrom: "${from}"`,
        '    status: active',
        '    statement: A project opens for its owner.',
      ].join('\n')))).toEqual([]);
    }
  });

  it('drops an entry whose scenarios are not a list of lines', () => {
    expect(requirementChangesIn(plan([
      'requirement-changes:',
      '  - id: AC0004',
      '    status: active',
      '    statement: A project opens for its owner.',
      '    scenarios: The owner opens it.',
    ].join('\n')))).toEqual([]);
  });

  it('drops entries that do not state a requirement completely', () => {
    expect(requirementChangesIn(plan([
      'requirement-changes:',
      '  - id: AC4',
      '    status: active',
      '    statement: A short id.',
      '  - id: AC0005',
      '    status: done',
      '    statement: A status outside the lifecycle.',
      '  - id: AC0006',
      '    status: active',
      '  - just a string',
    ].join('\n')))).toEqual([]);
  });

  it('reads nothing from a plan that only discusses a change in its body', () => {
    expect(requirementChangesIn('# Plan\n\n```\n---\nrequirement-changes:\n  - id: AC0004\n    status: active\n    statement: x\n---\n```\n')).toEqual([]);
  });

  it('reads nothing from a plan without a block, with a malformed one, or with frontmatter at the top', () => {
    expect(requirementChangesIn('# Plan\n')).toEqual([]);
    expect(requirementChangesIn(plan('requirement-changes: ['))).toEqual([]);
    expect(requirementChangesIn('---\nrequirement-changes:\n  - id: AC0001\n    status: active\n    statement: A thing.\n---\n# Plan\n')).toEqual([]);
    expect(requirementChangesIn(undefined)).toEqual([]);
  });

  it('sits beside test-only without either disturbing the other', () => {
    expect(requirementChangesIn(plan('test-only: true\nrequirement-changes:\n  - id: AC0001\n    status: active\n    statement: A thing.')))
      .toEqual([{ id: 'AC0001', status: 'active', statement: 'A thing.', scenarios: [] }]);
  });
});

/**
 * A plan checked against the format the referee reads, at approval.
 *
 * The closing `workflow` block and nothing else declares anything. The hazard is specific and
 * has already happened: the plan that introduced the test-only route quotes
 * the declaration three times while not being a test-only change itself.
 * Anything matched anywhere in the body would have read that plan as
 * declaring one.
 */
describe('readPlan', () => {
  const plan = (front, body = '# A plan\n\nSome prose.\n') =>
    (front === null ? body : `${body}\n\`\`\`workflow\n${front}\n\`\`\`\n`);
  const fine = (testOnly = false, requirementChanges = []) => ({ problems: [], testOnly, requirementChanges, predictedFailures: [] });

  it('reads the declaration from the closing block, whatever the spacing', () => {
    expect(readPlan(plan('test-only: true'))).toEqual(fine(true));
    expect(readPlan(plan('test-only:   true'))).toEqual(fine(true));
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('reads all three declarations with %s line endings', (_, newline) => {
    const text = plan([
      'test-only: true',
      'requirement-changes:',
      '  - {id: AC0004, status: active, statement: Keep the original bytes.}',
      'predicted-failures: [AC0004.1]',
    ].join('\n')).replaceAll('\n', newline);
    expect(readPlan(text)).toEqual({
      problems: [],
      testOnly: true,
      requirementChanges: [{ id: 'AC0004', status: 'active', statement: 'Keep the original bytes.', scenarios: [] }],
      predictedFailures: ['AC0004.1'],
    });
  });

  it('reports a malformed declaration in a CRLF plan', () => {
    const text = plan('test-only: "true"').replaceAll('\n', '\r\n');
    expect(readPlan(text).problems).toEqual(['`test-only` must be true or false, and is "true"']);
  });

  it('is not test-only when the field says so, and when it is absent', () => {
    expect(readPlan(plan('test-only: false'))).toEqual(fine(false));
    expect(readPlan(plan(null))).toEqual(fine(false));
    expect(readPlan(plan(''))).toEqual(fine(false));
  });

  // The case the closing block's rules were chosen for. A plan about test-only changes says
  // the words, shows the syntax in a fenced block, and declares nothing.
  it('ignores a declaration quoted in the body', () => {
    const body = '# Test-only changes\n\nDeclare one like this:\n\n```\n---\ntest-only: true\n---\n```\n\nThen triage first.\n';
    expect(readPlan(plan(null, body))).toEqual(fine(false));
  });

  it('reads the requirement changes, trimmed, with a renumber kept', () => {
    const front = [
      'requirement-changes:',
      '  - id: AC0004',
      '    renumberedFrom: AC0002',
      '    status: active',
      '    statement: "  A thing.  "',
      '    scenarios:',
      "      - '[AC0004.1] Once. '",
      '  - id: INV0001',
      '    status: withdrawn',
      '    statement: Gone.',
    ].join('\n');
    expect(readPlan(plan(front))).toEqual(fine(false, [
      { id: 'AC0004', renumberedFrom: 'AC0002', status: 'active', statement: 'A thing.', scenarios: ['[AC0004.1] Once.'] },
      { id: 'INV0001', status: 'withdrawn', statement: 'Gone.', scenarios: [] },
    ]));
  });

  // A typo would otherwise declare nothing, silently. That is the failure the
  // check exists for: the operator approves what they read, and the referee
  // records something else.
  it('refuses a key a plan may not hold, a spelling of one included', () => {
    expect(readPlan(plan('title: Something\ntest-only: true')).problems)
      .toEqual(['its `workflow` block holds `title`, which is not a key a plan may hold']);
    expect(readPlan(plan('Test-Only: true')).problems)
      .toEqual(['its `workflow` block holds `Test-Only`, which is not a key a plan may hold']);
  });

  it('refuses a test-only that is not true or false', () => {
    expect(readPlan(plan('test-only: yes')).problems).toEqual(['`test-only` must be true or false, and is "yes"']);
    expect(readPlan(plan('test-only: "true"')).problems).toEqual(['`test-only` must be true or false, and is "true"']);
  });

  it('refuses requirement changes that are not a list', () => {
    expect(readPlan(plan('requirement-changes: AC0004')).problems).toEqual(['`requirement-changes` must be a list']);
  });

  it('names every field wrong in every entry', () => {
    const front = [
      'requirement-changes:',
      '  - id: AC4',
      '    status: done',
      '    scenarios: one',
      '  - id: AC0005',
      '    renumberedFrom: INV0001',
      '    status: active',
      '    statement: Fine.',
      '  - just text',
      '  - null',
    ].join('\n');
    expect(readPlan(plan(front)).problems).toEqual([
      '`requirement-changes` AC4 (entry 1): `id` must be AC or INV and four digits, and is "AC4"',
      '`requirement-changes` AC4 (entry 1): `status` must be one of accepted, active, superseded, withdrawn, and is "done"',
      '`requirement-changes` AC4 (entry 1): `statement` must be some text',
      '`requirement-changes` AC4 (entry 1): `scenarios` must be a list of strings',
      '`requirement-changes` AC0005 (entry 2): `renumberedFrom` must be a different id of the same kind as AC0005, and is "INV0001"',
      '`requirement-changes` entry 3: is not a list of keys and values',
      '`requirement-changes` entry 4: is not a list of keys and values',
    ]);
  });

  it('declares nothing from a plan with problems', () => {
    expect(readPlan(plan('test-only: true\ntypo: 1'))).toMatchObject({ testOnly: false, requirementChanges: [] });
    expect(readPlan(plan('predicted-failures:\n  - a.test.ts\ntypo: 1')).predictedFailures).toEqual([]);
  });

  it('reads the predicted failures in each form, trimmed, with a leading ./ dropped', () => {
    const front = [
      'predicted-failures:',
      '  - AC0004.1',
      '  - ./tools/a.test.ts',
      "  - '  tools/a.test.ts::refuses a missing key  '",
      '  - src/lib.rs::tests::adds',
    ].join('\n');
    expect(readPlan(plan(front)).predictedFailures).toEqual([
      'AC0004.1', 'tools/a.test.ts', 'tools/a.test.ts::refuses a missing key', 'src/lib.rs::tests::adds',
    ]);
    expect(readPlan(plan('predicted-failures:'))).toEqual(fine(false));
  });

  it('refuses predicted failures that are not a list', () => {
    expect(readPlan(plan('predicted-failures: a.test.ts')).problems).toEqual(['`predicted-failures` must be a list']);
  });

  // Each in the words of the mistake most likely to cause it: YAML reads a
  // scenario id in brackets as a list, and `a.test.ts:: name` as a key and a
  // value.
  it('names every entry that is not a prediction, and why', () => {
    const front = [
      'predicted-failures:',
      '  - [AC0004.1]',
      '  - a.test.ts:: refuses x',
      '  - AC0004',
      "  - ''",
      '  - /abs/a.test.ts',
      '  - ../a.test.ts',
      "  - 'a.test.ts::'",
      "  - '::refuses x'",
      '  - 5',
    ].join('\n');
    expect(readPlan(plan(front)).problems).toEqual([
      '`predicted-failures` entry 1: is a list, which is how YAML reads `[AC0004.1]`: write the scenario id without brackets, such as AC0004.1',
      '`predicted-failures` entry 2: is a key and a value, which is how YAML reads `file:: name` with a space after the colons: write `::` with no space after it, or quote the entry',
      '`predicted-failures` entry 3: names the requirement AC0004 and no scenario: name each scenario, such as AC0004.1',
      '`predicted-failures` entry 4: is empty',
      '`predicted-failures` entry 5: is an absolute path, "/abs/a.test.ts": write it from the repository root',
      '`predicted-failures` entry 6: leaves the repository, "../a.test.ts": write the path from the repository root',
      '`predicted-failures` entry 7: names no test after `::` in "a.test.ts::": leave out `::` to predict the whole file',
      '`predicted-failures` entry 8: names no test file before `::`: write the path from the repository root, then `::` and the test\'s name',
      '`predicted-failures` entry 9: must be a string, and is 5',
    ]);
  });

  it('refuses a plan with no text, or a `workflow` block only', () => {
    expect(readPlan('').problems).toEqual(['it has no text besides its `workflow` block']);
    expect(readPlan(plan('test-only: true', '\n\n')).problems).toEqual(['it has no text besides its `workflow` block']);
  });

  it('refuses a block that is not YAML keys and values', () => {
    expect(readPlan(plan('- a list')).problems).toEqual(['its `workflow` block is not a list of keys and values']);
    expect(readPlan(plan('just words')).problems).toEqual(['its `workflow` block is not a list of keys and values']);
    expect(readPlan(plan('a: [')).problems[0]).toMatch(/^its `workflow` block cannot be read: /);
  });

  // gray-matter runs a `---js` block with eval. A plan is a file an agent
  // writes, so that would let it run code inside the referee.
  it('runs nothing: a plan cannot ask for JavaScript or JSON', () => {
    globalThis.planRan = false;
    const js = '---js\n(globalThis.planRan = true, { "test-only": true })\n---\n# Plan';
    expect(readPlan(js).problems).toEqual([TOP]);
    expect(requirementChangesIn(js)).toEqual([]);
    const inside = plan('---js\n(globalThis.planRan = true, { "test-only": true })');
    expect(readPlan(inside).problems).toEqual([DASHES]);
    expect(requirementChangesIn(inside)).toEqual([]);
    expect(globalThis.planRan).toBe(false);
    expect(readPlan('---json\n{ "test-only": true }\n---\n# Plan').problems).toEqual([TOP]);
  });
});

/**
 * Where a plan's declarations may sit. Only the last top-level fenced block
 * counts, when it is labelled `workflow` and ends the file, so that a plan
 * quoting the format declares nothing.
 */
describe('the closing workflow block', () => {
  const F = '```';
  const block = (body, fence = F) => `${fence}workflow\n${body}\n${fence}`;

  it('reads the block that ends the plan, and gives the rest of the plan as its text', () => {
    const read = declarationsOf(`# Plan\n\nProse.\n\n${block('test-only: true')}\n`);
    expect(read).toEqual({ problems: [], data: { 'test-only': true }, content: '# Plan\n\nProse.\n' });
  });

  it('reads a plan with no block as declaring nothing, and as all text', () => {
    expect(declarationsOf('# Plan\n')).toEqual({ problems: [], data: {}, content: '# Plan\n' });
  });

  it('reads the block with blank lines and spaces after its closing fence', () => {
    expect(readPlan(`# Plan\n\n${block('test-only: true')}\n\n   \n`).testOnly).toBe(true);
  });

  it('reads a block opened and closed by tildes, or closed by a longer fence', () => {
    expect(readPlan(`# Plan\n\n${block('test-only: true', '~~~')}\n`).testOnly).toBe(true);
    expect(readPlan(`# Plan\n\n${F}workflow\ntest-only: true\n${F}${F[0]}\n`).testOnly).toBe(true);
  });

  it('refuses frontmatter at the top, and says where the declarations go', () => {
    expect(readPlan('---\ntest-only: true\n---\n\n# Plan\n\nProse.\n')).toEqual({
      problems: [TOP], testOnly: false, requirementChanges: [], predictedFailures: [],
    });
  });

  it('refuses a workflow block that is not the last thing in the file', () => {
    expect(readPlan(`# Plan\n\n${block('test-only: true')}\n\nMore prose.\n`).problems).toEqual([ONE]);
  });

  it('refuses two workflow blocks, even when the second ends the plan', () => {
    expect(readPlan(`# Plan\n\n${block('test-only: false')}\n\nProse.\n\n${block('test-only: true')}\n`).problems).toEqual([ONE]);
  });

  it('refuses a workflow block that is never closed', () => {
    expect(readPlan('# Plan\n\n```workflow\ntest-only: true\n').problems).toEqual([ONE]);
  });

  it('reads nothing from a block inside a longer fence, with backticks or tildes', () => {
    for (const outer of ['````', '~~~']) {
      const quoted = `# Plan\n\nLike this:\n\n${outer}markdown\n${block('test-only: true')}\n${outer}\n`;
      expect(readPlan(quoted)).toEqual({ problems: [], testOnly: false, requirementChanges: [], predictedFailures: [] });
    }
  });

  it('reads nothing from an example labelled yaml that ends the plan', () => {
    expect(readPlan(`# Plan\n\n${F}yaml\ntest-only: true\n${F}\n`).testOnly).toBe(false);
  });

  it('refuses a line in the block that starts with ---', () => {
    expect(readPlan(`# Plan\n\n${block('test-only: true\n---\npredicted-failures:\n  - AC0001.1')}\n`).problems).toEqual([DASHES]);
  });

  it('takes the label as the first word after the fence, and no backtick in it', () => {
    expect(readPlan(`# Plan\n\n${F}workflow extra words\ntest-only: true\n${F}\n`).testOnly).toBe(true);
    expect(readPlan(`# Plan\n\n${F}workflows\ntest-only: true\n${F}\n`).testOnly).toBe(false);
    expect(readPlan(`# Plan\n\n${F}workflow\`\ntest-only: true\n${F}\n`).testOnly).toBe(false);
  });

  it('reads no plan at all as an empty one', () => {
    expect(declarationsOf(undefined)).toEqual({ problems: [], data: {}, content: '' });
    expect(readPlan(undefined).problems).toEqual(['it has no text besides its `workflow` block']);
  });

  it('takes `---` as frontmatter only when it opens the plan', () => {
    expect(readPlan(`# Plan --- a draft\n\n${block('test-only: true')}\n`)).toMatchObject({ problems: [], testOnly: true });
  });

  // A problem anywhere means nothing is declared, even from a block that reads
  // well, because the operator was not shown a plan in the format.
  it('declares nothing from a good block in a plan with another problem', () => {
    const both = `---\ntest-only: true\n---\n\n# Plan\n\n${block('requirement-changes:\n  - id: AC0001\n    status: active\n    statement: A thing.')}\n`;
    expect(declarationsOf(both)).toEqual({ problems: [TOP], data: {}, content: both });
    expect(requirementChangesIn(both)).toEqual([]);
  });

  it('says what YAML could not read', () => {
    expect(readPlan(`# Plan\n\n${block('a: [')}\n`).problems).toEqual([expect.stringMatching(/^its `workflow` block cannot be read: unexpected end of the stream/)]);
  });

  // gray-matter, called without options, caches a text before parsing it, and
  // then answers the second read of YAML that threw from that cache, cleanly.
  it('refuses the same unreadable block every time it is read', () => {
    const broken = `# Plan\n\n${block('test-only: [')}\n`;
    for (let i = 0; i < 2; i += 1) expect(readPlan(broken).problems, `read ${i + 1}`).toHaveLength(1);
  });

  it('reads a label after spaces, and a closing fence with spaces after it', () => {
    expect(readPlan(`# Plan\n\n${F} workflow\ntest-only: true\n${F}   \n`).testOnly).toBe(true);
  });

  // Each of these is a line inside an earlier block that looks like a fence,
  // and is not the one that closes it. Read as closing it, the block after it
  // would be swallowed and nothing declared.
  it('closes a block only on a bare fence of the same character, at least as long', () => {
    const before = [
      `${F}text\n~~~\ninside\n${F}`,
      `${F}${F[0]}markdown\n${F}\ninside\n${F}${F[0]}`,
      `${F}text\n${F}yaml\ninside\n${F}`,
    ];
    for (const earlier of before) {
      expect(readPlan(`# Plan\n\n${earlier}\n\n${block('test-only: true')}\n`), earlier).toMatchObject({ problems: [], testOnly: true });
    }
  });

  // A backtick label with a backtick in it is inline code, not a fence. A tilde
  // fence's label may hold one.
  it('opens no block on inline code, and opens a tilde block whose label holds a backtick', () => {
    expect(readPlan(`# Plan\n\n${F}inline${F} in prose\n\n${block('test-only: true')}\n`)).toMatchObject({ problems: [], testOnly: true });
    expect(readPlan(`# Plan\n\n~~~markdown \`quoted\`\n${block('test-only: true')}\n~~~\n`))
      .toEqual({ problems: [], testOnly: false, requirementChanges: [], predictedFailures: [] });
  });

  it('reads a fence indented by up to three spaces, and not by four', () => {
    expect(readPlan(`# Plan\n\n   ${F}workflow\ntest-only: true\n   ${F}\n`).testOnly).toBe(true);
    expect(readPlan(`# Plan\n\n    ${F}workflow\ntest-only: true\n    ${F}\n`).testOnly).toBe(false);
  });
});

/**
 * One entry, read. Each case here is a rule the parser holds that a looser
 * one would break without any other test noticing.
 */
describe('parsePrediction', () => {
  const kindOf = (entry) => parsePrediction(entry).kind ?? parsePrediction(entry).problem;

  it('reads a scenario id only when it is the whole entry, with any number after the dot', () => {
    expect(kindOf('AC0004.12')).toBe('scenario');
    expect(kindOf('INV0001.1')).toBe('scenario');
    expect(kindOf('xAC0004.1')).toBe('file');
    expect(kindOf('AC0004.1x')).toBe('file');
  });

  it('says a requirement id names no scenario only when it is the whole entry', () => {
    expect(kindOf('AC0004')).toMatch(/^names the requirement AC0004/);
    expect(kindOf('xAC0004')).toBe('file');
    expect(kindOf('AC0004x')).toBe('file');
  });

  it('trims the entry, the path and the name', () => {
    expect(parsePrediction('  AC0004.1  ')).toEqual({ kind: 'scenario', id: 'AC0004.1', text: 'AC0004.1' });
    expect(parsePrediction('   ')).toEqual({ problem: 'is empty' });
    expect(parsePrediction('a.test.ts  ::  refuses x')).toEqual({ kind: 'test', file: 'a.test.ts', name: 'refuses x', text: 'a.test.ts::refuses x' });
  });

  it('drops every leading ./ from a path', () => {
    expect(parsePrediction('././a.test.ts')).toEqual({ kind: 'file', file: 'a.test.ts', text: 'a.test.ts' });
  });

  it('refuses a Windows path from a drive, and takes a folder whose name ends in a colon', () => {
    expect(kindOf('C:/a.test.ts')).toMatch(/^is an absolute path/);
    expect(kindOf('C:\\a.test.ts')).toMatch(/^is an absolute path/);
    expect(kindOf('\\a.test.ts')).toMatch(/^is an absolute path/);
    expect(kindOf('1:/a.test.ts')).toBe('file');
  });

  // YAML gives null for an empty list item, which is not a key and a value.
  it('says null is not a string, rather than a key and a value', () => {
    expect(parsePrediction(null)).toEqual({ problem: 'must be a string, and is null' });
  });
});

describe('planFormat', () => {
  it('names the folder as given and every key a plan may hold', () => {
    const text = planFormat('~/plans');
    expect(text).toMatch(/^A plan is a Markdown file directly in ~\/plans, the rulebook's plans folder\./);
    expect(text).toContain('`test-only: true`');
    expect(text).toContain('`requirement-changes:`');
    expect(text).toContain('`renumberedFrom`');
    expect(text).toContain('`predicted-failures:`');
    expect(text).toContain('accepted, active, superseded, withdrawn');
    expect(text).toContain('fenced code block labelled `workflow`');
    expect(text).toContain('`---` frontmatter at the top of the plan, are refused');
  });
});
