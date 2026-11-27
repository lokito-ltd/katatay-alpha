import { it } from 'vitest';
import { whenKttyRuns, thenItExits, thenItPrintsError } from '../support/ktty.mjs';
import { planFile, givenAWorkingBranch, whenGitRuns } from '../support/project.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenEventsEqual,
  thenGitPrints,
  thenStderrContains,
} from '../support/assertions.mjs';

it('A recognized command with invalid arguments runs nothing, exits 2, leaves stdout empty, and prints the correct invocation and help hint on stderr. [AC0003.5]', () => {
  const folder = givenAWorkingBranch();
  const before = whenGitRuns(folder, 'status', '--porcelain', '--untracked-files=all');
  const noArgs = [
    'version',
    'help',
    'path',
    'verify --rerun',
    'triage',
    'state show',
    'state verify',
    'coverage',
    'req trace',
    'req risk',
    'on write',
    'on prompt',
    'on plan-approved',
    'on plan-presented',
    'on turn-end',
  ];
  const cases = noArgs.map((name) => [
    name,
    ['extra'],
    "The '" + name + "' command takes no arguments. Run 'ktty " + name + "'.",
  ]);
  for (const [name, args, syntax] of [
    ['verify', ['--deadline', 'later'], '[--results <file>] [--deadline <milliseconds>]'],
    ['replan', ['--resume', 'extra'], '[--resume]'],
    [
      'init',
      ['--project'],
      '[--agent <label>=<defaults command>] [--project <dir>] [--answers <file>] [--questions] [--scratch-module <file>] [--probe [--expect <state>]]',
    ],
    ['areas', ['--stage'], '[--staged]'],
    ['report', ['--js'], '[--json]'],
    ['req guard', ['wrong'], '[--record]'],
    ['mutate', ['--base'], '[--base <ref>] [--budget <seconds>] [--verbose] [--json]'],
    ['req lint', ['a', 'b'], '[<directory>]'],
    ['req renumber', ['AC0001'], '<fromId> <toId>'],
    ['checks-analysis', ['0'], '<verification-seq>'],
    ['defaults', [], '<adapter command> [arguments]'],
  ])
    cases.push([name, args, 'Usage: ktty ' + name + ' ' + syntax + '.']);
  for (const adapter of ['claude', 'codex', 'cursor']) {
    const actions = ['defaults', 'install', 'check', 'pre-tool', 'user-prompt', 'turn-end'];
    if (adapter === 'claude') actions.push('post-tool');
    for (const action of actions)
      cases.push(['agent ' + adapter + ' ' + action, ['extra'], 'Usage: ktty agent <adapter> <action>.']);
  }

  const help = whenKttyRuns(['help'], { in: folder });
  const listed = help.stdout
    .split('\n')
    .filter((s) => s.startsWith('  '))
    .map((s) => s.trim().split(/\s{2,}/)[0]);
  thenValuesEqual(cases.map(([name]) => name).sort(), listed.sort());
  for (const [name, args, diagnostic] of cases) {
    const run = whenKttyRuns([...name.split(' '), ...args], {
      in: folder,
      input: JSON.stringify({ version: 1, planFile }),
    });
    thenItExits(run, 2);
    thenItPrintsError(run, [diagnostic, "Run 'ktty help' for usage."]);
  }
  thenEventsEqual(folder, []);
  thenGitPrints(folder, ['status', '--porcelain', '--untracked-files=all'], before);
});

it('A missing, zero or non-numeric sequence, or an extra argument, exits 2, prints the correct invocation and help hint on stderr, and records nothing. [AC0037.1]', () => {
  const folder = givenAWorkingBranch();
  for (const args of [[], ['0'], ['abc'], ['12', 'extra']]) {
    const run = whenKttyRuns(['checks-analysis', ...args], { in: folder, input: 'analysis' });
    thenItExits(run, 2);
    thenItPrintsError(run, ['Usage: ktty checks-analysis <verification-seq>.', "Run 'ktty help' for usage."]);
    thenEventsEqual(folder, []);
  }

  const valid = whenKttyRuns(['checks-analysis', '12'], { in: folder, input: 'analysis' });
  thenItExits(valid, 1);
  thenValueIs(valid.stdout, '');
  thenStderrContains(valid, 'checks.requireAnalysis is off');
  thenEventsEqual(folder, []);
});
