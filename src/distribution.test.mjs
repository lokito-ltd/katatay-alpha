import { afterEach, expect, it, vi } from 'vitest';
import sourceManifest from '../package.json' with { type: 'json' };
import releaseManifest from '../packaging/katatay/package.json' with { type: 'json' };

afterEach(() => {
  vi.doUnmock('../package.json');
  vi.resetModules();
});

it.each([
  [releaseManifest, true, 'ktty verify'],
  [sourceManifest, false, 'workflow verify'],
  [{ name: '' }, false, 'workflow verify'],
])('selects the command shown to operators from the installed manifest "$name"', async (manifest, packaged, message) => {
  vi.resetModules();
  vi.doMock('../package.json', () => ({ default: manifest }));
  expect((await import('./distribution.mjs')).packaged).toBe(packaged);
  const { command } = await import('./workflow/commands.mjs');
  expect(command('verify')).toBe(message);
});
