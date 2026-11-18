import { expect, it } from 'vitest';
import { CUT, LINES, NAMED, NO_EVENT, WIDTH, compactReport, row, trimmed, wrap } from './compact-report.mjs';

const LINK = '.katatay/state/topic/0007__checks_analysis.json';
const lines = (n, word = 'Line') => Array.from({ length: n }, (_, i) => `${word} ${i}.`);
const linesOf = text => text.split('\n');

it('puts the title, each block after a blank line, and the link last after a blank line', () => {
  const text = compactReport({ title: 'Title.', blocks: [{ lines: ['One.'] }, { lines: ['Two.', 'Three.'] }], link: LINK, label: 'Full analysis' });
  expect(text).toBe(`Title.\n\nOne.\n\nTwo.\nThree.\n\nFull analysis: ${LINK}`);
});

it('never wraps or cuts a long line', () => {
  const long = `${'a'.repeat(200)} ${'b'.repeat(200)}`;
  const text = compactReport({ title: 'Title.', blocks: [{ lines: [long, `  ${long}`] }], link: null });
  expect(text).toBe(`Title.\n\n${long}\n  ${long}\n\n${NO_EVENT}`);
});

it('says no event was recorded instead of giving a link', () => {
  expect(compactReport({ title: 'Title.', blocks: [], link: null })).toBe(`Title.\n\n${NO_EVENT}`);
});

it('keeps a title that holds a line break on its own lines, and leaves out an empty block', () => {
  expect(compactReport({ title: 'One.\nTwo.', blocks: [{ lines: [] }, { lines: ['Body.'] }], link: null }))
    .toBe(`One.\nTwo.\n\nBody.\n\n${NO_EVENT}`);
});

it('keeps a report of exactly the line ceiling whole, link included', () => {
  // Title, blank, 96 lines, blank and the link make LINES.
  const body = lines(LINES - 4);
  const text = compactReport({ title: 'Title.', blocks: [{ lines: body, cut: true }], link: LINK });
  expect(linesOf(text)).toHaveLength(LINES);
  expect(text).not.toContain(CUT);
  expect(text).toBe(['Title.', '', ...body, '', `Details: ${LINK}`].join('\n'));
});

it('cuts a cuttable block from its end, one line over the ceiling, and keeps the rest', () => {
  const body = lines(LINES - 3);
  const text = compactReport({ title: 'Title.', blocks: [{ lines: body, cut: true }, { lines: ['Kept.'] }], link: LINK });
  expect(linesOf(text)).toHaveLength(LINES);
  expect(text).toBe(['Title.', '', ...body.slice(0, LINES - 7), CUT, '', 'Kept.', '', `Details: ${LINK}`].join('\n'));
});

it('cuts a cuttable block down to the cut line alone when that is what fits', () => {
  // Title, blank, cut line, blank, the kept lines, blank and the link make LINES.
  const kept = lines(LINES - 6, 'Kept');
  const text = compactReport({ title: 'Title.', blocks: [{ lines: lines(10), cut: true }, { lines: kept }], link: LINK });
  expect(text).toBe(['Title.', '', CUT, '', ...kept, '', `Details: ${LINK}`].join('\n'));
});

it('folds lines to their short form only when cutting alone cannot fit', () => {
  const names = lines(200, 'name');
  const fits = compactReport({
    title: 'Title.',
    blocks: [{ lines: ['Summary.'], cut: true }, { lines: [{ text: 'Names: 2 (a, b).', short: 'Names: 2.' }] }],
    link: LINK,
  });
  expect(fits).toContain('Names: 2 (a, b).');
  const folded = compactReport({
    title: 'Title.',
    blocks: [{ lines: ['Summary.'], cut: true }, { lines: [{ text: `Names: 200\n${names.join('\n')}`, short: 'Names: 200.' }] }],
    link: LINK,
  });
  expect(folded).toBe(`Title.\n\nSummary.\n\nNames: 200.\n\nDetails: ${LINK}`);
});

it('cuts the cuttable text and folds names together when neither alone fits', () => {
  const names = lines(200, 'name').join('\n');
  const text = compactReport({
    title: 'Title.',
    blocks: [{ lines: lines(200), cut: true }, { lines: [{ text: names, short: 'Names: 200.' }] }],
    link: LINK,
  });
  expect(linesOf(text)).toHaveLength(LINES);
  expect(text).toContain(`${CUT}\n\nNames: 200.\n\nDetails: ${LINK}`);
  expect(text).not.toContain('name 0.');
});

it('stops at the ceiling even when the kept blocks alone are too long, with the link whole', () => {
  const text = compactReport({ title: 'Title.', blocks: [{ lines: lines(300, 'Kept') }], link: LINK });
  const all = linesOf(text);
  expect(all).toHaveLength(LINES);
  expect(all.slice(-3)).toEqual([CUT, '', `Details: ${LINK}`]);
  expect(all[LINES - 4]).toBe(`Kept ${LINES - 6}.`);
});

it('is as long as its content and no longer', () => {
  expect(linesOf(compactReport({ title: 'Title.', blocks: [{ lines: ['One.'] }], link: LINK }))).toHaveLength(5);
});

it('keeps every line of a report with no limit, past the usual ceiling', () => {
  const body = lines(LINES * 3);
  const text = compactReport({ title: 'Title.', blocks: [{ lines: body, cut: true }], link: LINK, limit: Infinity });
  expect(text).toBe(['Title.', '', ...body, '', `Details: ${LINK}`].join('\n'));
});

it('trims a list to its first rows and says how many there are, joining a name broken over lines', () => {
  const rows = Array.from({ length: NAMED + 2 }, (_, i) => `row ${i}`);
  expect(trimmed(rows, 'rows')).toEqual([...rows.slice(0, NAMED), `[…] Output trimmed. All ${NAMED + 2} rows are in the details file.`]);
  expect(trimmed(['a\n  b', 'c'], 'rows')).toEqual(['a b', 'c']);
  expect(trimmed(rows.slice(0, NAMED), 'rows')).toEqual(rows.slice(0, NAMED));
});

it('wraps prose at the width on spaces, keeps a longer word whole, and keeps each line of the text apart', () => {
  const words = Array.from({ length: 30 }, () => 'word').join(' ');
  const wrapped = wrap(words);
  expect(wrapped.every(line => line.length <= WIDTH)).toBe(true);
  expect(wrapped.join(' ')).toBe(words);
  // Each line is as full as it can be: the next word would pass the width.
  expect(wrapped.slice(0, -1).every(line => line.length + ' word'.length > WIDTH)).toBe(true);
  const path = `a/${'b'.repeat(WIDTH)}/c.mjs`;
  expect(wrap(`See ${path} now.`)).toEqual(['See', path, 'now.']);
  expect(wrap('One.\nTwo.')).toEqual(['One.', 'Two.']);
  expect(wrap('x '.repeat(40).trim(), '  ').every(line => line.startsWith('  x') && line.length <= WIDTH)).toBe(true);
});

it('joins a name broken over lines into one row, and wraps prose with leading or doubled spaces into single spaces', () => {
  expect(row('a\n  b\n c')).toBe('a b c');
  expect(row(7)).toBe('7');
  expect(wrap('  two   spaces ')).toEqual(['two spaces']);
});
