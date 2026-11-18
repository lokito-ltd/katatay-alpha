import { it } from 'vitest';
import { givenAnEmptyFolder, whenKttyRuns, thenItExits, thenItPrintsError } from '../support/ktty.mjs';

it('ktty path with an argument exits 2 and prints the correct invocation and help hint on stderr. [AC0002.2]', () => {
  const folder = givenAnEmptyFolder();
  const run = whenKttyRuns(['path', 'extra'], { in: folder });
  thenItExits(run, 2);
  thenItPrintsError(run, ["The 'path' command takes no arguments. Run 'ktty path'.", "Run 'ktty help' for usage."]);
});

it('An unknown command exits 2 and prints its name and the help hint on stderr. [AC0003.1]', () => {
  const folder = givenAnEmptyFolder();
  for (const name of ['versoin', 'req missing', 'state missing', 'on missing']) {
    const run = whenKttyRuns(name.split(' '), { in: folder });
    thenItExits(run, 2);
    thenItPrintsError(run, [`Unknown command '${name}'.`, "Run 'ktty help' for usage."]);
  }
});

it('ktty agent with an unknown adapter or action exits 2 and prints the expected invocation and help hint on stderr. [AC0003.2]', () => {
  const folder = givenAnEmptyFolder();
  for (const args of [['unknown', 'check'], ['codex', 'post-tool'], ['claude']]) {
    const run = whenKttyRuns(['agent', ...args], { in: folder });
    thenItExits(run, 2);
    thenItPrintsError(run, ['Usage: ktty agent <adapter> <action>.', "Run 'ktty help' for usage."]);
  }
});

it('ktty agent with an argument after the action runs nothing, exits 2, and prints the expected invocation and help hint on stderr. [AC0003.3]', () => {
  const folder = givenAnEmptyFolder();
  const run = whenKttyRuns(['agent', 'claude', 'defaults', 'extra'], { in: folder });
  thenItExits(run, 2);
  thenItPrintsError(run, ['Usage: ktty agent <adapter> <action>.', "Run 'ktty help' for usage."]);
});

it('ktty without a command exits 2 and prints a missing-command message and the help hint on stderr. [AC0003.4]', () => {
  const folder = givenAnEmptyFolder();
  const run = whenKttyRuns([], { in: folder });
  thenItExits(run, 2);
  thenItPrintsError(run, ['No command supplied.', "Run 'ktty help' for usage."]);
});
