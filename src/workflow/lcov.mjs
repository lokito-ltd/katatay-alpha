/**
 * An lcov coverage report, read into what the coverage check and the quality
 * report need: for each file, the lines and branches covered and counted, and
 * which lines some test ran and which none did.
 *
 * lcov is a file format, not a tool. Most coverage tools write it, so reading
 * it here, once, saves a translator in every language. The referee still names
 * no tool: `checks.testQuality.coverage.command` supplies LCOV on stdout. The
 * command owns finding the source report. Later steps use saved analysis.
 *
 * The records read, one per line, inside a block that `SF:` opens and
 * `end_of_record` closes:
 *
 * - `SF:<path>` names the file.
 * - `DA:<line>,<count>[,<checksum>]` is a line that can run, and how many
 *   times it ran. It is covered when the count is above 0.
 * - `BRDA:<line>,<block>,<branch>,<taken>` is one way a branch can go. It is
 *   covered when `taken` is a number above 0; `-` means the code holding it
 *   never ran.
 * - `LF`, `LH`, `BRF` and `BRH` are the block's own totals: lines found and
 *   hit, branches found and hit.
 *
 * Every other record, such as `TN`, `FN`, `FNDA`, `FNF`, `FNH` and `VER`, is
 * left alone. Nothing reads function coverage.
 *
 * The line rule is the one Istanbul's summary uses: a line counts once, at the
 * most any record gave it. Checked on 2026-10-31 against Istanbul's own JSON
 * report for 49 files of the project the harness was built in: the same lines
 * and the same branch counts.
 *
 * Anything the reader cannot be sure of is a refusal, never a guess: a line
 * that is not a record, and a report that names no file at all. A report that
 * read as "nothing measured" would pass every file it left out.
 */
import { isAbsolute } from 'node:path';
import { AdapterError, repositoryPath } from './adapter.mjs';

const refuse = (where, problem) => new AdapterError(`${where}: ${problem}`);

/** A whole number from 0 up, as lcov writes counts and line numbers. */
const isCount = (text) => /^\d+$/.test(text);

/**
 * The report's text as one entry per file, sorted by path, so the same report
 * always gives the same answer.
 *
 * A file named in two blocks is merged: the highest count per line and per
 * branch. That is what joining two runs' reports gives, such as
 * `cat unit.info e2e.info`, where each block is about the same file.
 *
 * Each block's totals, when it gives them, must agree with its own records.
 * Numbers that disagree mean the writer is wrong in one of them, and the
 * referee cannot tell which.
 *
 * @param {string} text the report
 * @param {string} root the directory relative paths in the report are from
 * @param {string} [name] what to call the report in a refusal
 * @returns {{ files: { file: string, lines: { covered: number, total: number }, branches: { covered: number, total: number }, uncoveredLines: number[], coveredLines: number[] }[] }}
 */
export function parseLcov(text, root, name = 'the coverage report') {
  /** By file: the count of each line, and of each branch by its `line,block,branch`. */
  const byFile = new Map();
  let block = null;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const where = `${name}, line ${index + 1}`;
    if (line === '') return;
    if (line === 'end_of_record') {
      if (!block) throw refuse(where, 'end_of_record with no SF: before it');
      checkTotals(block, where);
      block = null;
      return;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) throw refuse(where, `"${line.slice(0, 80)}" is not an lcov record, which is a tag, a colon and a value`);
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (tag === 'SF') {
      if (block) throw refuse(where, `SF: for a new file before the end_of_record of ${block.file}`);
      if (value.trim() === '') throw refuse(where, 'SF: with no path');
      const file = fromRoot(value, root, where);
      if (!byFile.has(file)) byFile.set(file, { lines: new Map(), branches: new Map() });
      block = { file, entry: byFile.get(file), lines: new Map(), branches: new Map(), totals: {} };
      return;
    }
    if (!['DA', 'BRDA', 'LF', 'LH', 'BRF', 'BRH'].includes(tag)) return;
    if (!block) throw refuse(where, `${tag}: before any SF:`);

    if (tag === 'DA') {
      const [number, count] = value.split(',');
      if (!isCount(number ?? '') || Number(number) === 0 || !isCount(count ?? '')) {
        throw refuse(where, `DA: must be a line number from 1 and a count from 0, and is "${value}"`);
      }
      keepHighest(block.lines, Number(number), Number(count));
    } else if (tag === 'BRDA') {
      const parts = value.split(',');
      const taken = parts[3];
      if (parts.length !== 4 || !isCount(parts[0]) || Number(parts[0]) === 0 || parts[1] === '' || parts[2] === ''
        || (taken !== '-' && !isCount(taken))) {
        throw refuse(where, `BRDA: must be a line number, a block, a branch and a count or "-", and is "${value}"`);
      }
      keepHighest(block.branches, parts.slice(0, 3).join(','), taken === '-' ? 0 : Number(taken));
    } else {
      if (!isCount(value)) throw refuse(where, `${tag}: must be a whole number, and is "${value}"`);
      block.totals[tag] = Number(value);
    }
  });
  if (block) throw refuse(name, `the block for ${block.file} has no end_of_record`);
  // A report that names no file measured nothing, which is the same as no
  // report: read as an empty figure, it would pass every touched line.
  if (byFile.size === 0) throw refuse(name, 'it names no file (no SF: record), so it measured nothing');

  const files = [...byFile].map(([file, entry]) => {
    const covered = [...entry.lines].filter(([, count]) => count > 0).map(([n]) => n).sort((a, b) => a - b);
    const uncovered = [...entry.lines].filter(([, count]) => count === 0).map(([n]) => n).sort((a, b) => a - b);
    const ways = [...entry.branches.values()];
    return {
      file,
      lines: { covered: covered.length, total: entry.lines.size },
      branches: { covered: ways.filter((count) => count > 0).length, total: ways.length },
      uncoveredLines: uncovered,
      coveredLines: covered,
    };
  });
  return { files: files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)) };
}

/** Keeps the higher of two counts for one key. */
function keepHighest(map, key, count) {
  map.set(key, Math.max(map.get(key) ?? 0, count));
}

/**
 * Checks a block's totals against its records, then adds the records to the
 * file's entry. A total the block does not give is not checked.
 */
function checkTotals(block, where) {
  const counts = {
    LF: block.lines.size,
    LH: [...block.lines.values()].filter((count) => count > 0).length,
    BRF: block.branches.size,
    BRH: [...block.branches.values()].filter((count) => count > 0).length,
  };
  for (const [tag, counted] of Object.entries(counts)) {
    const given = block.totals[tag];
    if (given !== undefined && given !== counted) {
      throw refuse(where, `${block.file} says ${tag}:${given}, and its records count ${counted}`);
    }
  }
  for (const [line, count] of block.lines) keepHighest(block.entry.lines, line, count);
  for (const [key, count] of block.branches) keepHighest(block.entry.branches, key, count);
}

/**
 * A report path as a path from `root` with `/`. Absolute paths under the root,
 * or under its real path, are made relative. A path outside the root cannot be
 * named the way the coverage check names files, so it is a refusal and not a
 * guess.
 */
function fromRoot(path, root, where) {
  const file = repositoryPath(path, root);
  if (file === '.' || file === '..' || file.startsWith('../') || isAbsolute(file)) {
    throw refuse(where, `the report names ${path.trim()}, which is not under ${root}`);
  }
  return file;
}
