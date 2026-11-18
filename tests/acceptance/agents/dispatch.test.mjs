import { it } from 'vitest';
import { givenAGitRepository, thenItExits, thenItPrintsError, whenKttyRuns } from '../support/ktty.mjs';
import { thenContains, thenOmits, thenValueIs, thenValuesEqual } from '../support/assertions.mjs';
import { whenDirectoryIsListed } from '../support/project.mjs';

const usage = ['Usage: ktty agent <adapter> <action>.', "Run 'ktty help' for usage."];

it('Claude accepts defaults, install, check, pre-tool, user-prompt, post-tool and turn-end, and Codex accepts all but post-tool. [AC0067.1]', () => {
  const folder = givenAGitRepository();
  const accepted = [
    ...['defaults', 'install', 'check', 'pre-tool', 'user-prompt', 'post-tool', 'turn-end'].map(action => ['claude', action]),
    ...['defaults', 'install', 'check', 'pre-tool', 'user-prompt', 'turn-end'].map(action => ['codex', action]),
  ];

  for (const [adapter, action] of accepted) {
    const run = whenKttyRuns(['agent', adapter, action], { in: folder, input: 'not json' });
    thenOmits(run.stderr, usage[0], adapter + ' ' + action);
  }
  const refused = whenKttyRuns(['agent', 'codex', 'post-tool'], { in: folder, input: '{}' });
  thenItExits(refused, 2);
  thenItPrintsError(refused, usage);
});

it('An unknown adapter, an unknown action, a path-like action or a missing action exits 2 without starting anything. [AC0067.2]', () => {
  const folder = givenAGitRepository();
  const before = whenDirectoryIsListed(folder.cwd);

  for (const args of [['cursor', 'check'], ['claude', 'deploy'], ['claude', 'hooks/pre-tool'], ['claude', '../codex/check'], ['claude']]) {
    const run = whenKttyRuns(['agent', ...args], { in: folder, input: '{}' });
    thenItExits(run, 2);
    thenItPrintsError(run, usage);
  }
  thenValuesEqual(whenDirectoryIsListed(folder.cwd), before);
});

it("The action runs with the caller's stdin and stdout, and its exit status is returned. [AC0067.3]", () => {
  const folder = givenAGitRepository();

  const answered = whenKttyRuns(['agent', 'claude', 'check'], { in: folder, input: JSON.stringify({ version: 1, root: folder.cwd, extraHooks: null }) });
  thenItExits(answered, 0);
  thenValueIs(JSON.parse(answered.stdout).version, 1);

  const refused = whenKttyRuns(['agent', 'claude', 'check'], { in: folder, input: JSON.stringify({ version: 1, extraHooks: null }) });
  thenItExits(refused, 2);
  thenItPrintsError(refused, ['check: refused, `root` must be the repository root.']);
});

it('check prints a versioned list of warnings and exits 0. [AC0067.4]', () => {
  const folder = givenAGitRepository();

  for (const adapter of ['claude', 'codex']) {
    const run = whenKttyRuns(['agent', adapter, 'check'], {
      in: folder, input: JSON.stringify({ version: 1, root: folder.cwd, extraHooks: null }), env: { CI: 'true' },
    });
    thenItExits(run, 0);
    const answer = JSON.parse(run.stdout);
    thenValuesEqual(Object.keys(answer), ['version', 'warnings']);
    thenValueIs(answer.version, 1);
    thenValueIs(Array.isArray(answer.warnings) && answer.warnings.every(warning => typeof warning === 'string'), true, adapter);
  }
});

it('check exits 2 for a request that does not match. [AC0067.5]', () => {
  const folder = givenAGitRepository();
  const root = folder.cwd;
  const requests = [
    ['', 'check: refused, the request is not JSON'],
    ['not json', 'check: refused, the request is not JSON'],
    ['[]', 'check: refused, the request is not a JSON object.'],
    [{ root, extraHooks: null }, 'check: refused, `version` must be 1, and is missing.'],
    [{ version: null, root, extraHooks: null }, 'check: refused, `version` must be 1, and is null.'],
    [{ version: '1', root, extraHooks: null }, 'check: refused, `version` must be 1, and is "1".'],
    [{ version: 2, root, extraHooks: null }, 'check: refused, `version` must be 1, and is 2.'],
    [{ version: 1, root: '', extraHooks: null }, 'check: refused, `root` must be the repository root.'],
    [{ version: 1, root }, 'check: refused, `extraHooks` must be null or { acknowledged: [{ event, matcher, command }] }.'],
    [{ version: 1, root, extraHooks: { acknowledged: 'all' } }, 'check: refused, `extraHooks` must be null or { acknowledged: [{ event, matcher, command }] }.'],
    [{ version: 1, root, extraHooks: { acknowledged: [{ event: 'Stop' }] } }, 'check: refused, `extraHooks` must be null or { acknowledged: [{ event, matcher, command }] }.'],
  ];

  for (const adapter of ['claude', 'codex']) {
    for (const [request, refusal] of requests) {
      const input = typeof request === 'string' ? request : JSON.stringify(request);
      const run = whenKttyRuns(['agent', adapter, 'check'], { in: folder, input });
      thenItExits(run, 2);
      thenValueIs(run.stdout, '');
      thenContains(run.stderr, refusal, adapter + ' ' + input);
    }
  }
});
