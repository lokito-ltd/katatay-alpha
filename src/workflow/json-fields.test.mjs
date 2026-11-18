import { expect, it, vi } from 'vitest';
import { fields, ignoringUnknown, leniently, versionedReader } from './json-fields.mjs';
import { validateStoredEvent } from './event-format.mjs';

it('selects the registered reader by numeric version before interpreting the body', () => {
  const current = vi.fn(doc => doc.name);
  const earlier = vi.fn(doc => doc.parts.join(' '));
  const read = versionedReader(current, [[0, earlier]]);
  expect(read({ version: 0, parts: ['one', 'two'] }, 'fixture')).toBe('one two');
  expect(current).not.toHaveBeenCalled();
  expect(read({ version: 1, name: 'current' }, 'fixture')).toBe('current');
  expect(earlier).toHaveBeenCalledTimes(1);
  expect(() => read({ version: '0' }, 'fixture')).toThrow(new Error('fixture.version has unsupported schema version "0" (expected 0 or 1)'));
  expect(() => read(Object.create({ version: 1 }), 'fixture')).toThrow('fixture.version is missing');
  for (const value of [null, [], '1']) expect(() => read(value, 'fixture')).toThrow('fixture must be an object');
  expect(() => validateStoredEvent({ version: 0 }, 1)).toThrow(new Error('event.version has unsupported schema version 0 (expected 1)'));
});

const text = (value, at) => { if (typeof value !== 'string') throw new Error(`${at} must be a string`); };
const shape = fields({ name: text, inner: fields({ id: text }) }, { note: text });
const valid = { name: 'a', inner: { id: 'b' } };

it('refuses an unknown field by default, at any depth', () => {
  expect(ignoringUnknown()).toBe(false);
  expect(() => shape(valid, 'value')).not.toThrow();
  expect(() => shape({ ...valid, extra: 1 }, 'value')).toThrow(new Error('value.extra is an unknown field'));
  expect(() => shape({ ...valid, inner: { id: 'b', extra: 1 } }, 'value')).toThrow(new Error('value.inner.extra is an unknown field'));
});

it('ignores unknown fields at any depth while reading leniently, and returns what the read returns', () => {
  const older = { ...valid, extra: 1, inner: { id: 'b', extra: 2 } };
  expect(leniently(() => { shape(older, 'value'); return ignoringUnknown(); })).toBe(true);
});

it('still requires and checks every known field while reading leniently', () => {
  expect(() => leniently(() => shape({ inner: { id: 'b' }, extra: 1 }, 'value'))).toThrow(new Error('value.name is missing'));
  expect(() => leniently(() => shape({ ...valid, inner: { id: 3 } }, 'value'))).toThrow(new Error('value.inner.id must be a string'));
  expect(() => leniently(() => shape({ ...valid, note: 4 }, 'value'))).toThrow(new Error('value.note must be a string'));
  expect(() => leniently(() => shape([], 'value'))).toThrow(new Error('value must be an object'));
  expect(() => leniently(() => shape(null, 'value'))).toThrow(new Error('value must be an object'));
});

// `ignoringUnknown` is built when the module loads. Loading a new instance
// inside the test exercises that construction while the test is active, so a
// change to it shows here; a top-level import only tests the stored function.
it('reads leniently through a newly loaded module, and strictly outside it', async () => {
  vi.resetModules();
  const fresh = await import('./json-fields.mjs');
  const check = fresh.fields({ name: text });
  expect(fresh.ignoringUnknown()).toBe(false);
  expect(fresh.leniently(() => fresh.ignoringUnknown())).toBe(true);
  expect(() => fresh.leniently(() => check({ name: 'a', extra: 1 }, 'value'))).not.toThrow();
  expect(() => check({ name: 'a', extra: 1 }, 'value')).toThrow(new Error('value.extra is an unknown field'));
});

it('is strict again after a lenient read returns, after one throws, and after nested reads', () => {
  leniently(() => leniently(() => shape(valid, 'value')));
  expect(ignoringUnknown()).toBe(false);
  expect(() => leniently(() => { throw new Error('unreadable'); })).toThrow('unreadable');
  expect(ignoringUnknown()).toBe(false);
  expect(() => shape({ ...valid, extra: 1 }, 'value')).toThrow('value.extra is an unknown field');
});
