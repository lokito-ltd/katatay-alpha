// Pins what .github/workflows/build.yml must keep for its signatures and
// releases to mean anything. A one-line edit there could sign pull requests
// from forks, hand every job the signing identity, or publish a release from
// a tag that is not on main, and nothing else would fail.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { expect, it } from 'vitest';

const file = resolve(import.meta.dirname, '../../.github/workflows/build.yml');
// gray-matter is the YAML reader the referee already ships.
const workflow = matter(`---\n${readFileSync(file, 'utf8')}\n---\n`).data;
const steps = job => workflow.jobs[job].steps;
const stepUsing = (job, action) => steps(job).findIndex(step => step.uses?.startsWith(`${action}@`));
const stepNamed = (job, name) => steps(job).findIndex(step => step.name === name);

it('builds every pull request, every push to main and every v* tag', () => {
  expect(workflow.on).toEqual({ pull_request: null, push: { branches: ['main'], tags: ['v*'] } });
});

it('pins every action by a full commit SHA', () => {
  const actions = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses).map(step => step.uses);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
});

it('gives the signing identity to the build job alone, and write access to the release job alone', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['build', 'release']);
  expect(workflow.jobs.build.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' });
  expect(workflow.jobs.release.permissions).toEqual({ contents: 'write' });
});

it('checks out the full history, which brings the tags that name the version', () => {
  const checkout = steps('build')[stepUsing('build', 'actions/checkout')];
  expect(checkout.with['fetch-depth']).toBe(0);
});

it('signs the tarball on pushes only, never on a pull request', () => {
  const sign = steps('build')[stepUsing('build', 'actions/attest-build-provenance')];
  expect(sign.if).toBe("github.event_name == 'push'");
  expect(sign.with).toEqual({ 'subject-path': 'dist/katatay-*.tgz' });
});

it('checks that a release tag is on main and names the tarball\'s version before signing', () => {
  const check = stepNamed('build', 'Check the release tag');
  expect(check).toBeGreaterThan(stepNamed('build', 'Read the built version'));
  expect(check).toBeLessThan(stepUsing('build', 'actions/attest-build-provenance'));
  expect(check).toBeLessThan(stepUsing('build', 'actions/upload-artifact'));
  const step = steps('build')[check];
  expect(step.if).toBe("startsWith(github.ref, 'refs/tags/v')");
  expect(step.run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  expect(step.run).toContain('[ "$VERSION" != "${GITHUB_REF_NAME#v}" ]');
});

it('publishes a release only for a v* tag, after the build', () => {
  expect(workflow.jobs.release.if).toBe("startsWith(github.ref, 'refs/tags/v')");
  expect(workflow.jobs.release.needs).toBe('build');
  const publish = steps('release')[stepNamed('release', 'Publish the GitHub Release')];
  expect(publish.run).toContain('gh release create "$GITHUB_REF_NAME" --verify-tag');
});

it('cancels superseded runs of a pull request only', () => {
  expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  expect(workflow.concurrency.group).toContain('github.run_id');
});
