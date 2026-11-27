import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { describedRelease, releaseFromDescription, releaseVersion } from './release.mjs';

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-manifest-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repositoryWithCommit() {
  const root = temporaryRoot();
  git(root, 'init', '--quiet');
  writeFileSync(join(root, 'file.txt'), 'one\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '--quiet', '-m', 'one');
  return root;
}

it('reads the release from the root manifest in a packaged installation', () => {
  const root = temporaryRoot();
  writeFileSync(join(root, 'package.json'), '{"version":"5.6.7"}');
  expect(releaseVersion(root, true)).toBe('5.6.7');
});

it('names the tag of a clean source checkout on a release tag', () => {
  const root = repositoryWithCommit();
  git(root, 'tag', '-a', 'v2.3.4', '-m', 'release');
  writeFileSync(join(root, 'package.json'), '{"version":"0.0.0"}');
  expect(releaseVersion(root, false)).toBe('2.3.4');
});

it('names the commits since the tag, the commit and uncommitted edits in a source checkout', () => {
  const root = repositoryWithCommit();
  git(root, 'tag', 'v2.3.4');
  writeFileSync(join(root, 'file.txt'), 'two\n');
  git(root, 'commit', '--quiet', '-am', 'two');
  const commit = git(root, 'rev-parse', '--short', 'HEAD');
  expect(describedRelease(root)).toBe(`2.3.4+1.g${commit}`);
  writeFileSync(join(root, 'file.txt'), 'three\n');
  expect(describedRelease(root)).toBe(`2.3.4+1.g${commit}.dirty`);
});

it('ignores tags that do not start with v', () => {
  const root = repositoryWithCommit();
  git(root, 'tag', 'v1.0.0');
  writeFileSync(join(root, 'file.txt'), 'two\n');
  git(root, 'commit', '--quiet', '-am', 'two');
  git(root, 'tag', 'nightly');
  const commit = git(root, 'rev-parse', '--short', 'HEAD');
  expect(describedRelease(root)).toBe(`1.0.0+1.g${commit}`);
});

it('refuses a source checkout with no release tag, naming the fetch that brings the tags', () => {
  const root = repositoryWithCommit();
  expect(() => describedRelease(root)).toThrow(
    `Katatay cannot tell its release: git found no v* tag in ${root}. Fetch the tags with 'git fetch --tags'.`,
  );
});

it('refuses a folder that is not a git checkout', () => {
  const root = temporaryRoot();
  expect(() => releaseVersion(root, false)).toThrow("Fetch the tags with 'git fetch --tags'.");
});

it.each([
  ['v0.2.0-0-gabc1234', '0.2.0'],
  ['v0.2.0-3-gabc1234', '0.2.0+3.gabc1234'],
  ['v0.2.0-3-gabc1234-dirty', '0.2.0+3.gabc1234.dirty'],
  ['v0.2.0-0-gabc1234-dirty', '0.2.0+0.gabc1234.dirty'],
  ['v0.3.0-rc.1-0-g0123abc', '0.3.0-rc.1'],
  ['v0.3.0-rc.1-2-g0123abc', '0.3.0-rc.1+2.g0123abc'],
  ['v10.20.30-alpha-beta.0.x-7-gdeadbeef', '10.20.30-alpha-beta.0.x+7.gdeadbeef'],
  ['v0.2.0-12-gabc1234', '0.2.0+12.gabc1234'],
  ['v1.0.0-1-0-gabc1234', '1.0.0-1'],
  ['v1.0.0-10-0-gabc1234', '1.0.0-10'],
  ['v1.0.0-1a-0-gabc1234', '1.0.0-1a'],
  ['v1.0.0-rc.10-0-gabc1234', '1.0.0-rc.10'],
  ['v1.0.0-rc.2b-0-gabc1234', '1.0.0-rc.2b'],
  ['v1.0.0-rc.beta-0-gabc1234', '1.0.0-rc.beta'],
])('converts the description %s to the release %s', (description, release) => {
  expect(releaseFromDescription(description)).toBe(release);
});

it.each(['vnext', 'v1.2', 'v1.2.3.4', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-01', 'v1.2.3-', 'v1.2.3+build', 'v1.2.3-rc..1'])(
  'refuses the tag %s, which is not v and a SemVer version',
  tag => {
    expect(() => releaseFromDescription(`${tag}-4-gabc1234`)).toThrow(
      `The tag '${tag}' is not a release tag: it must be v followed by a SemVer version, such as v0.2.0.`,
    );
  },
);

it.each(['', 'undefined', 'abc1234', '0.2.0-3-gabc1234', 'v0.2.0-3-abc1234', 'v0.2.0-x-gabc1234', 'v0.2.0-3-gABC1234', 'v0.2.0-3-gabc1234-dirty-extra', 'xv0.2.0-3-gabc1234'])(
  "refuses git's description %j, which is not a tag, a count and a commit",
  description => {
    expect(() => releaseFromDescription(description)).toThrow(
      `Katatay cannot tell its release from git's description '${description}'.`,
    );
  },
);
