import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { givenFileContents, whenGitRuns } from './project.mjs';
import { whenCommitted } from './history.mjs';

// This clone publishes to the bare remote without updating the working branch's refs or objects.
export function givenAPublisher(folder) {
  const cwd = join(dirname(folder.cwd), 'publisher');
  whenGitRuns(folder, 'clone', '--quiet', '-b', 'main', whenGitRuns(folder, 'remote', 'get-url', 'origin'), cwd);
  return { ...folder, cwd };
}
export function whenTargetAdvances(publisher, path, contents) {
  givenFileContents(publisher, path, contents);
  const commit = whenCommitted(publisher, 'Advance target');
  whenGitRuns(publisher, 'push', '--quiet', 'origin', 'HEAD:main');
  return commit;
}
export function whenRemoteGoesOffline(folder) {
  const url = whenGitRuns(folder, 'remote', 'get-url', 'origin');
  whenGitRuns(folder, 'remote', 'set-url', 'origin', url + '.offline');
  return url;
}
export const whenRemoteReturns = (folder, url) => whenGitRuns(folder, 'remote', 'set-url', 'origin', url);
export const whenCommitIsKnown = (folder, sha) =>
  spawnSync('git', ['cat-file', '-e', sha + '^{commit}'], folder).status === 0;
export function whenTargetHistoryIsReplaced(folder) {
  const unrelated = whenGitRuns(folder, 'commit-tree', 'HEAD^{tree}', '-m', 'Independent target');
  whenGitRuns(folder, 'push', '--quiet', '--force', 'origin', unrelated + ':refs/heads/main');
  return unrelated;
}
