/**
 * The mutation testing report schema, read without a language tool.
 * Versions 1 and 2 share the fields used here. Extra metadata, including test
 * associations, belongs to the report's writer and is left alone.
 */
import { readFileSync } from 'node:fs';

export const STATUSES = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending'];

/** @typedef {{ line: number, column: number }} Position */
/** @typedef {{ file: string, id: string, location: { start: Position, end: Position }, mutator: string, replacement?: string, sourceLine?: string }} Survivor */
/** @typedef {{ partial?: boolean, counts: { total: number, caught: number, survived: number, unproven: number, statuses: Record<string, number> }, survivors: Survivor[] }} Findings */

/** Mutants without a completed test result: no test finished, none reached
 * the mutant, or the run left it pending. @param {Findings['counts']} counts */
export const unprovedCount = counts => counts.unproven + counts.statuses.NoCoverage + counts.statuses.Pending;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const position = (value) => object(value) && whole(value.line) && value.line > 0 && whole(value.column) && value.column > 0;
const pathInside = (file) => file !== '' && !file.includes('\\') && !/^[A-Za-z]:/.test(file)
  && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** A final newline terminates the last line, without adding an empty one. */
export function sourceLines(source) {
  const lines = source.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A report's required fields and the fields the referee reads are checked.
 * Unknown statuses or versions cannot silently turn into zero survivors.
 * @param {unknown} report
 * @returns {Findings}
 */
export function findingsOf(report) {
  if (!object(report) || !/^([12])(\.(0|[1-9]\d*)){0,2}$/.test(report.schemaVersion ?? '')
    || typeof report.schemaVersion !== 'string' || !object(report.files)) {
    throw new Error('expected a mutation report with schemaVersion 1 or 2 and a files object');
  }
  const thresholds = report.thresholds;
  if (!object(thresholds) || !whole(thresholds.high) || thresholds.high > 100 || !whole(thresholds.low) || thresholds.low > 100) {
    throw new Error('report thresholds must contain high and low percentages');
  }
  const counts = { total: 0, caught: 0, survived: 0, unproven: 0, statuses: Object.fromEntries(STATUSES.map((status) => [status, 0])) };
  /** @type {Survivor[]} */
  const survivors = [];
  for (const [file, result] of Object.entries(report.files)) {
    if (!pathInside(file) || !object(result) || typeof result.language !== 'string'
      || typeof result.source !== 'string' || !Array.isArray(result.mutants)) {
      throw new Error(`invalid file result for ${JSON.stringify(file)}`);
    }
    const ids = new Set();
    let lines;
    for (const mutant of result.mutants) {
      if (!object(mutant) || typeof mutant.id !== 'string' || ids.has(mutant.id)
        || typeof mutant.mutatorName !== 'string' || !STATUSES.includes(mutant.status)
        || (mutant.replacement !== undefined && typeof mutant.replacement !== 'string')
        || (mutant.testsCompleted !== undefined && !whole(mutant.testsCompleted))) {
        throw new Error(`invalid or duplicate mutant in ${file}`);
      }
      const location = mutant.location;
      if (!object(location) || !position(location.start) || !position(location.end)
        || location.end.line < location.start.line
        || (location.end.line === location.start.line && location.end.column < location.start.column)) {
        throw new Error(`invalid location for ${file} mutant ${mutant.id}`);
      }
      ids.add(mutant.id);
      counts.total++;
      counts.statuses[mutant.status]++;
      if (mutant.status === 'Killed' || mutant.status === 'Timeout') counts.caught++;
      if (mutant.status !== 'Survived') continue;
      if (mutant.testsCompleted === 0) {
        counts.unproven++;
        continue;
      }
      counts.survived++;
      const { start, end } = location;
      lines ??= sourceLines(result.source);
      const sourceLine = lines[start.line - 1];
      survivors.push({ file, id: mutant.id, location: { start: { line: start.line, column: start.column },
        end: { line: end.line, column: end.column } }, mutator: mutant.mutatorName,
        ...(sourceLine === undefined ? {} : { sourceLine }),
        ...(mutant.replacement === undefined ? {} : { replacement: mutant.replacement }) });
    }
  }
  survivors.sort((a, b) => a.file.localeCompare(b.file)
    || a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column
    || a.id.localeCompare(b.id));
  return { counts, survivors, ...(report.partial === true ? { partial: true } : {}) };
}

/** Parse a fresh report and check its agreement with the command's exit.
 * An inconclusive run may contain some survivors as well as unproven work.
 * @returns {Findings}
 */
export function parseMutationReport(text, outcome) {
  const findings = findingsOf(JSON.parse(text));
  if ((outcome === 'clean' && (findings.counts.survived > 0 || findings.counts.unproven > 0))
    || (outcome === 'survived' && findings.counts.survived === 0)) {
    throw new Error(`report contradicts the command's ${outcome} outcome`);
  }
  return findings;
}

/** Read and parse a standard report, with the same outcome checks. */
export function readMutationReport(path, outcome) {
  return parseMutationReport(readFileSync(path, 'utf8'), outcome);
}
