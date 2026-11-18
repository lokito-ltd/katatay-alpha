import { STATE_FOLDER } from './folder.mjs';

/** Values shared by the rulebook and its test and code settings. */
export const CONFIG = `${STATE_FOLDER}/rulebook.json`;

/** Thrown for every way the rulebook can be missing or wrong. Callers tell it
 *  apart from other failures, so they can refuse with this message as it is.
 *  The adapter's errors are this too, so one catch covers both. */
export class TargetError extends Error {}

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * An exit-code map, checked and spelt out: every code from 0 to 255 the map
 * names, to what it means. A key is one code, such as `"1"`, or a range, such
 * as `"1-255"`, for a tool such as dependency-cruiser that exits with its
 * number of findings. A code named twice is refused, because one of the two
 * meanings would be ignored.
 *
 * @returns {Record<string, string>}
 */
export function parseExitCodes(map, at, meanings, required, error) {
  if (!isObject(map)) throw error(`"${at}" must map each exit code, or a range such as "1-255", to what it means: ${meanings.join(', ')}`);
  const codes = {};
  for (const [key, meaning] of Object.entries(map)) {
    const match = /^(0|[1-9]\d{0,2})(?:-(0|[1-9]\d{0,2}))?$/.exec(key);
    const from = match ? Number(match[1]) : NaN;
    const to = match ? Number(match[2] ?? match[1]) : NaN;
    if (!match || from > 255 || to > 255 || from > to) {
      throw error(`"${at}" names ${JSON.stringify(key)}, which is not an exit code from 0 to 255 or a range of them such as "1-255"`);
    }
    if (!meanings.includes(meaning)) {
      throw error(`"${at}" says ${JSON.stringify(key)} means ${JSON.stringify(meaning)}, which is not one of ${meanings.join(', ')}`);
    }
    for (let code = from; code <= to; code++) {
      if (codes[code] !== undefined) throw error(`"${at}" names exit ${code} twice`);
      codes[code] = meaning;
    }
  }
  for (const needed of required) {
    if (!Object.values(codes).includes(needed)) {
      throw error(`"${at}" has no code that means "${needed}". Without one, a clean run and a run that found something look the same`);
    }
  }
  return codes;
}
