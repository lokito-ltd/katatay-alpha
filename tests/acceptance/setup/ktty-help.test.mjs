import { it } from 'vitest';
import { givenAnEmptyFolder, whenKttyRuns, thenItExits, thenItPrintsError } from '../support/ktty.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenTextMatches,
  thenLengthIs,
  thenStdoutContains,
} from '../support/assertions.mjs';

it('ktty help outside a project prints help on stdout, leaves stderr empty, and exits 0. [AC0073.1]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['help'], { in: folder });
  thenItExits(run, 0);
  thenValueIs(run.stderr, '');
  thenStdoutContains(run, 'Usage: ktty <command> [arguments]');
});

it("Help starts with 'Usage: ktty <command> [arguments]' and lists every available command with a short description under 'Commands:'. [AC0073.2]", () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['help'], { in: folder });
  thenItExits(run, 0);
  const lines = run.stdout.trimEnd().split('\n');
  thenValuesEqual(lines.slice(0, 3), ['Usage: ktty <command> [arguments]', '', 'Commands:']);
  const entries = lines.slice(3).map((line) => {
    const fields = line.trim().split(/\s{2,}/);
    thenLengthIs(fields, 2, line);
    thenTextMatches(fields[1], /\S+\s+\S+/, line);
    return fields[0];
  });
  const expected = [
    'help',
    'version',
    'path',
    'verify',
    'verify --rerun',
    'triage',
    'replan',
    'state show',
    'state verify',
    'areas',
    'coverage',
    'mutate',
    'defaults',
    'init',
    'checks-analysis',
    'report',
    'req lint',
    'req guard',
    'req trace',
    'req risk',
    'req renumber',
    'on write',
    'on prompt',
    'on plan-approved',
    'on plan-presented',
    'on turn-end',
    'agent claude post-tool',
  ];
  for (const adapter of ['claude', 'codex', 'cursor']) {
    for (const action of ['defaults', 'install', 'check', 'pre-tool', 'user-prompt', 'turn-end']) {
      expected.push(`agent ${adapter} ${action}`);
    }
  }
  thenValuesEqual(entries.sort(), expected.sort());
});

it('ktty help with an argument exits 2 and prints the correct invocation and help hint on stderr. [AC0073.3]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['help', 'extra'], { in: folder });
  thenItExits(run, 2);
  thenItPrintsError(run, [
    "The 'help' command takes no arguments. Run 'ktty help'.",
    "Run 'ktty help' for usage.",
  ]);
});
