/**
 * A compact report: a short summary for the operator, then one link to the
 * logbook event that holds the details.
 *
 * The whole report, its title, blank lines and link included, is at most
 * LINES lines. That leaves room for several reports in one message. It is a
 * ceiling, not a target: a report is as long as its content and no longer.
 *
 * Lines are never wrapped or cut. A terminal or a chat wraps a long line
 * itself, and a test name or a path broken in two can no longer be searched
 * for or copied. The limit of 20 rows of 76 columns this replaced made test
 * names wrap and push each other out, and cost 32i.2 three plan revisions.
 *
 * When the report is too long, cuttable blocks lose lines from their end
 * first, with a line saying the rest is in the event. Then lines with a short
 * form switch to it, such as a count without its names. Each report decides
 * what is cuttable; this file knows nothing about what the reports say.
 */
export const LINES = 100;
export const NO_EVENT = 'No logbook event was recorded.';
export const CUT = '… The rest is in the event.';
/** How many rows a named list shows before its trim line. */
export const NAMED = 5;
/** The column prose wraps at. Rows naming a test, a file or output never wrap. */
export const WIDTH = 76;

/** A row is one line, never cut: a name holding a line break is joined up. */
export const row = (name) => String(name).replace(/\s*\n\s*/g, ' ');

/**
 * The first NAMED rows, then a line saying how many there are in all. The
 * rows are kept whole; the rest stay in the event's evidence.
 */
export function trimmed(rows, noun) {
  if (rows.length <= NAMED) return rows.map(row);
  return [...rows.slice(0, NAMED).map(row), `[…] Output trimmed. All ${rows.length} ${noun} are in the details file.`];
}

/**
 * Prose wrapped at WIDTH on spaces, each line of the text on its own. A word
 * longer than the row, such as a path or a command, is never broken: a path
 * cut in two can no longer be searched for or copied.
 */
export function wrap(text, indent = '') {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && indent.length + line.length + 1 + word.length > WIDTH) {
        out.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(indent + line);
  }
  return out;
}

const linesOf = (block, short) => block.lines
  .map((line) => (typeof line === 'string' ? line : (short && line.short) || line.text))
  .flatMap((line) => line.split('\n'));

/** The lines: the title, then each block after a blank line. */
function layout(title, blocks) {
  return [...title.split('\n'), ...blocks.flatMap((lines) => (lines.length ? ['', ...lines] : []))];
}

/** The blank line and the link come after the summary. */
const fitsWithLink = (summary, limit) => summary.length + 2 <= limit;

/**
 * Cuttable blocks lose lines from their end, the last block first, until the
 * whole fits. A block that lost lines ends with CUT. Null when even cutting
 * every cuttable block to CUT alone does not fit.
 */
function cutToFit(title, blocks, rendered, limit) {
  const kept = rendered.map((lines) => [...lines]);
  const fits = () => fitsWithLink(layout(title, kept), limit);
  if (fits()) return kept;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!blocks[i].cut) continue;
    const full = rendered[i];
    for (let n = full.length - 1; n >= 0; n--) {
      kept[i] = [...full.slice(0, n), CUT];
      if (fits()) return kept;
    }
  }
  return null;
}

/**
 * The report's text, with no trailing newline.
 *
 * @param {{ title: string,
 *   blocks: Array<{ lines: Array<string | { text: string, short?: string }>, cut?: boolean }>,
 *   link: string | null, label?: string, limit?: number }} report
 *   `link` is the event's path from the repository root, or null when no event
 *   was recorded. `limit` is the ceiling in lines, LINES unless given;
 *   Infinity keeps every line, for a report whose every line is owed to the
 *   operator, such as one line per configured check.
 */
export function compactReport({ title, blocks, link, label = 'Details', limit = LINES }) {
  const kept = cutToFit(title, blocks, blocks.map((block) => linesOf(block, false)), limit)
    ?? cutToFit(title, blocks, blocks.map((block) => linesOf(block, true)), limit);
  let summary = layout(title, kept ?? blocks.map((block) => linesOf(block, true)));
  // A report whose kept blocks alone overflow still stops at its limit.
  if (!fitsWithLink(summary, limit)) summary = [...summary.slice(0, limit - 3), CUT];
  return [...summary, '', link === null ? NO_EVENT : `${label}: ${link}`].join('\n');
}
