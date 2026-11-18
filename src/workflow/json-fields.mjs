/**
 * The shape check for the referee's own JSON: logbook events and the
 * snapshots they name.
 *
 * Strict on write, lenient on read. A writer that adds a field no format
 * lists is a typo, so by default an unknown field is refused. Data already
 * stored is read inside `leniently`, where unknown fields are ignored: events
 * are committed and never rewritten, so a field dropped from a format would
 * otherwise break every logbook that still holds it. Ignoring them is safe
 * because the hash chain covers every byte of an event, and a field no code
 * reads cannot grant anything. Required fields stay required and checked in
 * both modes.
 *
 * Adapter input is not checked here: the rulebook's sections refuse unknown
 * keys in `rulebook-keys.mjs`, always.
 */

import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';

const fail = (at, why) => { throw new Error(`${at} ${why}`); };

export function schemaVersion(value, at) {
  if (value !== HARNESS_SCHEMA_VERSION) {
    fail(at, `has unsupported schema version ${JSON.stringify(value) ?? 'missing'} (expected ${HARNESS_SCHEMA_VERSION})`);
  }
}

// How many `leniently` calls are running. The validators are synchronous, so
// the mode cannot leak to another caller, and `finally` restores it on a throw.
let lenient = 0;

/** Runs `read` with unknown fields ignored, and returns its result. */
export function leniently(read) {
  lenient++;
  try { return read(); } finally { lenient--; }
}

/** Whether unknown fields are ignored right now. */
export const ignoringUnknown = () => lenient > 0;

/** A check for an object holding every `required` field and any `optional`
 * one, each checked by its own function. */
export function fields(required, optional = {}) {
  return (value, at) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'must be an object');
    if (!ignoringUnknown()) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(`${at}.${key}`, 'is an unknown field');
      }
    }
    for (const [key, check] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) fail(`${at}.${key}`, 'is missing');
      check(value[key], `${at}.${key}`);
    }
    for (const [key, check] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) check(value[key], `${at}.${key}`);
    }
  };
}

/** Select a document reader before interpreting any of its fields. Map keys
 * are numeric, so a string from JSON cannot select a numeric format. */
export function versionedReader(current, olderReaders = []) {
  const readers = new Map(olderReaders);
  readers.set(HARNESS_SCHEMA_VERSION, current);
  return (value, at, ...context) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'must be an object');
    if (!Object.hasOwn(value, 'version')) fail(`${at}.version`, 'is missing');
    const read = readers.get(value.version);
    if (!read) fail(`${at}.version`, `has unsupported schema version ${JSON.stringify(value.version)} (expected ${[...readers.keys()].join(' or ')})`);
    return read(value, at, ...context);
  };
}
