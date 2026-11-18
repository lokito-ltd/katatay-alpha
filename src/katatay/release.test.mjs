import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { releaseVersion } from './release.mjs';

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'katatay-manifest-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

it('reads the release from the packaging manifest in a source checkout', () => {
  const root = temporaryRoot();
  writeFileSync(join(root, 'package.json'), '{"name":"katatay-dev"}');
  mkdirSync(join(root, 'packaging/katatay'), { recursive: true });
  writeFileSync(join(root, 'packaging/katatay/package.json'), '{"version":"2.3.4"}');
  expect(releaseVersion(root, false)).toBe('2.3.4');
});

it('reads the release from the root manifest in a packaged installation', () => {
  const root = temporaryRoot();
  writeFileSync(join(root, 'package.json'), '{"version":"5.6.7"}');
  expect(releaseVersion(root, true)).toBe('5.6.7');
});
