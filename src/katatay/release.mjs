import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function releaseVersion(root, packaged) {
  const manifest = packaged ? 'package.json' : 'packaging/katatay/package.json';
  return JSON.parse(readFileSync(join(root, manifest), 'utf8')).version;
}
