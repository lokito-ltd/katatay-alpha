import { createHash } from 'node:crypto';

/**
 * Fingerprint of a requirement's statement.
 *
 * Only the statement is fingerprinted, never the prose around it. The statement
 * is the requirement. The prose below it explains, and anyone may improve it
 * freely. Weakening a requirement means editing the statement, and that is what
 * this has to catch.
 *
 * Normalising first keeps the fingerprint stable across changes that mean
 * nothing: line endings, surrounding whitespace, and runs of spaces inside.
 */
export function checksum(statement: string): string {
  const normalised = statement
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 12);
}
