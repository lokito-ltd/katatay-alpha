import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// An installed package carries the version it was built with. A source
// checkout has no version of its own: the release is named by its git tags,
// so a release needs only a pushed tag and no pull request to bump a number.
export function releaseVersion(root, packaged) {
  if (packaged) return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  return describedRelease(root);
}

// SemVer 2.0.0's version core with an optional pre-release, and no build
// metadata, which the description below adds itself.
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
const DESCRIPTION = /^v(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/;

// The release `git describe` names for the checkout at root, in SemVer form.
// On a release tag with a clean tree it is the tag's version, such as 0.2.0.
// Otherwise build metadata says how far the tree is from that tag:
// 0.2.0+3.gabc1234 three commits on, with .dirty added for uncommitted edits.
// A dirty tree gets the metadata even on the tag, so a build of edits never
// claims to be the release. The `g` stays in front of the commit because a
// short SHA such as 0123abc would be an invalid SemVer number on its own.
//
// Without a tag in reach, such as in a shallow clone or a folder with no .git,
// it throws rather than make a version up.
export function describedRelease(root) {
  let output;
  try {
    output = execFileSync('git', ['describe', '--tags', '--match', 'v*', '--long', '--dirty'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Katatay cannot tell its release: git found no v* tag in ${root}. Fetch the tags with 'git fetch --tags'.`);
  }
  return releaseFromDescription(String(output).trim());
}

export function releaseFromDescription(description) {
  const parts = DESCRIPTION.exec(description);
  if (!parts) throw new Error(`Katatay cannot tell its release from git's description '${description}'.`);
  const [, release, count, commit, dirty] = parts;
  if (!RELEASE.test(release)) throw new Error(`The tag 'v${release}' is not a release tag: it must be v followed by a SemVer version, such as v0.2.0.`);
  if (count === '0' && !dirty) return release;
  return `${release}+${count}.g${commit}${dirty ? '.dirty' : ''}`;
}
