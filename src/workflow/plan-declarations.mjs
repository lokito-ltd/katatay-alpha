import { LIFECYCLE } from './plan-format.mjs';

/**
 * One `predicted-failures` entry, read. Three forms, each a single string:
 *
 * - a scenario id, such as `AC0004.1`: every acceptance test tagged with it;
 * - a test file's path from the repository root: every test in it, which is
 *   what a file that fails to load does;
 * - the path, `::` and a test's name, as pytest writes a test's id: that one
 *   test. Split at the first `::`, which no path holds, so a name may hold
 *   more, as Rust's `module::test` does.
 *
 * `text` is the entry as the logbook keeps it: trimmed, with a leading `./`
 * dropped from the path, so two spellings of one file are one entry.
 *
 * The problems are said in the words of the mistake most likely to cause them.
 * `- [AC0004.1]` is a YAML list, not a tag. `- a.test.ts:: name`, with a space
 * after the colons, is a YAML key and value. A requirement id with no scenario
 * would otherwise read as a file path that matches nothing.
 *
 * @param {unknown} entry
 * @returns {{ kind: 'scenario', id: string, text: string }
 *   | { kind: 'file', file: string, text: string }
 *   | { kind: 'test', file: string, name: string, text: string }
 *   | { problem: string }}
 */
export function parsePrediction(entry) {
  if (Array.isArray(entry)) return { problem: 'is a list, which is how YAML reads `[AC0004.1]`: write the scenario id without brackets, such as AC0004.1' };
  if (typeof entry === 'object' && entry !== null) {
    return { problem: 'is a key and a value, which is how YAML reads `file:: name` with a space after the colons: write `::` with no space after it, or quote the entry' };
  }
  if (typeof entry !== 'string') return { problem: `must be a string, and is ${JSON.stringify(entry)}` };
  const text = entry.trim();
  if (text === '') return { problem: 'is empty' };
  if (/^(AC|INV)\d{4}\.\d+$/.test(text)) return { kind: 'scenario', id: text, text };
  if (/^(AC|INV)\d{4}$/.test(text)) return { problem: `names the requirement ${text} and no scenario: name each scenario, such as ${text}.1` };
  const split = text.indexOf('::');
  const path = (split === -1 ? text : text.slice(0, split)).trim().replace(/^(\.\/)+/, '');
  const name = split === -1 ? null : text.slice(split + 2).trim();
  if (path === '') return { problem: `names no test file before \`::\`: write the path from the repository root, then \`::\` and the test's name` };
  if (/^([a-zA-Z]:)?[\\/]/.test(path)) return { problem: `is an absolute path, ${JSON.stringify(path)}: write it from the repository root` };
  if (path.split(/[\\/]/).includes('..')) return { problem: `leaves the repository, ${JSON.stringify(path)}: write the path from the repository root` };
  if (name === null) return { kind: 'file', file: path, text: path };
  if (name === '') return { problem: `names no test after \`::\` in ${JSON.stringify(text)}: leave out \`::\` to predict the whole file` };
  return { kind: 'test', file: path, name, text: `${path}::${name}` };
}

/**
 * What is wrong with one `requirement-changes` entry, as phrases. Empty means
 * nothing is.
 */
export function entryProblems(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ['is not a list of keys and values'];
  const { id, renumberedFrom, status, statement, scenarios = [] } = entry;
  const problems = [];
  const idOk = typeof id === 'string' && /^(AC|INV)\d{4}$/.test(id);
  if (!idOk) problems.push(`\`id\` must be AC or INV and four digits, and is ${JSON.stringify(id) ?? 'missing'}`);
  if (renumberedFrom !== undefined && idOk && !sameKind(renumberedFrom, id)) {
    problems.push(`\`renumberedFrom\` must be a different id of the same kind as ${id}, and is ${JSON.stringify(renumberedFrom)}`);
  }
  if (!LIFECYCLE.includes(status)) problems.push(`\`status\` must be one of ${LIFECYCLE.join(', ')}, and is ${JSON.stringify(status) ?? 'missing'}`);
  if (typeof statement !== 'string' || statement.trim() === '') problems.push('`statement` must be some text');
  if (!Array.isArray(scenarios) || !scenarios.every((s) => typeof s === 'string')) problems.push('`scenarios` must be a list of strings');
  return problems;
}

/**
 * Whether `from` is a well-formed id of the same type as `to`, and a different
 * one. Repeated as `sameKind` in `src/requirements/guard.ts`, for the reason
 * `LIFECYCLE` is.
 */
function sameKind(from, to) {
  if (typeof from !== 'string' || !/^(AC|INV)\d{4}$/.test(from) || from === to) return false;
  return from.replace(/\d+$/, '') === to.replace(/\d+$/, '');
}
