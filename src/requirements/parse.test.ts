import { describe, expect, it } from 'vitest';
import { parseRequirement, scenariosOf, statementOf } from './parse.js';

const file = (id: string, raw: string) => parseRequirement(`${id}__a_slug.md`, raw, `requirements/acceptance/${id}__a_slug.md`);

const STATEMENT = 'A user can reject an AI proposal without it entering canonical data.';

const withProse = (prose: string, statement = STATEMENT, status = 'accepted') =>
  `---\nstatus: ${status}\n---\n\n${statement}\n\n${prose}\n`;

describe('statementOf', () => {
  it('takes the first non-empty line', () => {
    expect(statementOf('\n\n  The statement.  \n\nSome prose.\n')).toBe('The statement.');
  });

  it('returns empty string when there is no statement', () => {
    expect(statementOf('\n   \n\n')).toBe('');
  });

  it('stops at the first line — later paragraphs are never part of the statement', () => {
    expect(statementOf('First line.\nSecond line.\n')).toBe('First line.');
  });
});

describe('the fingerprint covers the statement and nothing else', () => {
  // This is the property the whole lifecycle rests on: prose below the statement
  // is explanation and may be improved freely, while the statement itself is
  // what guard protects. If statementOf ever widened to the whole body, every
  // other test here would still pass and rewording a comment would silently
  // become an approval-gated operation.
  it('gives the same fingerprint when only the prose changes', () => {
    const before = file('AC0001', withProse('Rejection is a first-class outcome.'));
    const after = file('AC0001', withProse(
      'Rejection is a first-class outcome, not merely the absence of acceptance.\n' +
      'A rejected proposal must not reappear as unresolved on a later pass.',
    ));

    expect(after.statement).toBe(before.statement);
    expect(after.checksum).toBe(before.checksum);
  });

  it('gives the same fingerprint when the prose is removed entirely', () => {
    const withExplanation = file('AC0001', withProse('Some explanation.'));
    const bare = file('AC0001', `---\nstatus: accepted\n---\n\n${STATEMENT}\n`);

    expect(bare.checksum).toBe(withExplanation.checksum);
  });

  it('gives the same fingerprint when only the status changes', () => {
    // Status transitions are tracked separately by guard. Folding them into the
    // fingerprint would make every promotion look like a reworded requirement.
    const accepted = file('AC0001', withProse('Prose.', STATEMENT, 'accepted'));
    const active = file('AC0001', withProse('Prose.', STATEMENT, 'active'));

    expect(active.status).toBe('active');
    expect(active.checksum).toBe(accepted.checksum);
  });

  it('gives a different fingerprint when the statement changes, prose untouched', () => {
    const strong = file('AC0001', withProse('Same prose.', 'A user can reject an AI proposal.'));
    const weak = file('AC0001', withProse('Same prose.', 'A user can usually reject an AI proposal.'));

    expect(weak.checksum).not.toBe(strong.checksum);
  });
});

describe('identity comes from the filename', () => {
  it('derives id, type and slug', () => {
    const req = parseRequirement('AC0042__person_may_do_a_thing.md', withProse('x'), 'p');
    expect(req).toMatchObject({ id: 'AC0042', type: 'acceptance', slug: 'person_may_do_a_thing' });
  });

  it('reads INV as an invariant', () => {
    expect(parseRequirement('INV0007__a_slug.md', withProse('x'), 'p').type).toBe('invariant');
  });

  it('rejects a filename that carries no id', () => {
    expect(() => parseRequirement('notes.md', withProse('x'), 'p')).toThrow(/does not match/);
  });

  it('does not let the filename influence the fingerprint', () => {
    const a = parseRequirement('AC0001__one_slug.md', withProse('x'), 'p');
    const b = parseRequirement('AC0002__another_slug.md', withProse('x'), 'p');
    expect(b.checksum).toBe(a.checksum);
  });
});

describe('scenariosOf', () => {
  const body = (section: string) => `The statement.\n\n## Scenarios\n\n${section}\n\n## Why\n\n- [AC0001.9] Not a scenario: it is under Why.\n`;

  it('reads each [ID] text item under the heading, up to the next heading', () => {
    const { scenarios, malformed } = scenariosOf(body('- [AC0001.1] The owner opens it.\n- [AC0001.3] Nobody else does.'));
    expect(scenarios.map((s) => [s.id, s.text])).toEqual([
      ['AC0001.1', 'The owner opens it.'],
      ['AC0001.3', 'Nobody else does.'],
    ]);
    expect(malformed).toEqual([]);
  });

  it('joins an item that wraps onto indented lines', () => {
    const { scenarios } = scenariosOf(body('- [AC0001.1] The owner opens it,\n  and sees it unchanged.'));
    expect(scenarios[0]!.text).toBe('The owner opens it, and sees it unchanged.');
  });

  it('drops backticks and runs of whitespace from the text it compares', () => {
    const { scenarios } = scenariosOf(body('- [AC0001.1] A line break sent as `\\r\\n`   counts once.'));
    expect(scenarios[0]!.text).toBe('A line break sent as \\r\\n counts once.');
  });

  it('returns an item it cannot read as malformed, rather than dropping it', () => {
    expect(scenariosOf(body('- The owner opens it.\n- [AC0001] Bare id.')).malformed)
      .toEqual(['The owner opens it.', '[AC0001] Bare id.']);
  });

  it('finds none when there is no Scenarios heading', () => {
    expect(scenariosOf('The statement.\n\nProse.\n')).toEqual({ scenarios: [], malformed: [] });
  });

  // The statement is still the first line, and scenarios below it must not
  // change its fingerprint: the guard recognises a renumber by it.
  it('leaves the statement and its fingerprint alone', () => {
    const plain = file('AC0001', withProse('Prose.'));
    const listed = file('AC0001', withProse('## Scenarios\n\n- [AC0001.1] The owner opens it.\n\n## Why\n\nProse.'));
    expect(listed.checksum).toBe(plain.checksum);
    expect(listed.scenarios).toHaveLength(1);
  });
});
