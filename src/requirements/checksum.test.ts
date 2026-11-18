import { describe, expect, it } from 'vitest';
import { checksum } from './checksum.js';

describe('checksum', () => {
  it('is stable across line endings and surrounding whitespace', () => {
    const base = checksum('A relationship cannot reference a person who does not exist.');
    expect(checksum('  A relationship cannot reference a person who does not exist.  ')).toBe(base);
    expect(checksum('A relationship cannot reference a person who does not exist.\r\n')).toBe(base);
    expect(checksum('A  relationship   cannot reference a person who does not exist.')).toBe(base);
  });

  it('changes when a single meaningful character changes', () => {
    const strong = checksum('A user can reject an AI proposal without it entering canonical data.');
    const weakened = checksum('A user can reject an AI proposal without it entering canonical data sometimes.');
    expect(weakened).not.toBe(strong);
  });

  it('distinguishes negation, which is the cheapest way to weaken a statement', () => {
    expect(checksum('AI output cannot mutate canonical data.'))
      .not.toBe(checksum('AI output can mutate canonical data.'));
  });
});
