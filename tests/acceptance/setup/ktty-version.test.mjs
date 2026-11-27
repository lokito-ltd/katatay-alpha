import { it } from 'vitest';
import {
  givenAnEmptyFolder,
  givenAGitRepository,
  whenKttyRuns,
  thenItExits,
  thenItPrintsError,
  thenItPrintsLines,
} from '../support/ktty.mjs';
import { thenValueIs, thenTextMatches } from '../support/assertions.mjs';

it('ktty version prints the release and the schema version on two lines, and exits 0. [AC0001.1]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['version'], { in: folder });

  thenItExits(run, 0);
  thenItPrintsLines(run, [/^Katatay \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, /^Schema \d+$/]);
});

it('ktty version answers in a folder that is not a project. [AC0001.2]', () => {
  const folder = givenAGitRepository();

  const run = whenKttyRuns(['version'], { in: folder });

  thenItExits(run, 0);
  thenItPrintsLines(run, [/^Katatay \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, /^Schema \d+$/]);
});

it('ktty version with an argument exits 2 and prints the correct invocation and help hint on stderr. [AC0001.3]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['version', 'blabla'], { in: folder });

  thenItExits(run, 2);
  thenItPrintsError(run, [
    "The 'version' command takes no arguments. Run 'ktty version'.",
    "Run 'ktty help' for usage.",
  ]);

  // Follow both commands exactly as the diagnostic spells them.
  const suggested = [...run.stderr.matchAll(/Run 'ktty ([^']+)'/g)].map((match) => match[1].split(' '));

  const retry = whenKttyRuns(suggested[0], { in: folder });
  thenItExits(retry, 0);
  thenItPrintsLines(retry, [/^Katatay \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, /^Schema \d+$/]);

  const help = whenKttyRuns(suggested[1], { in: folder });
  thenItExits(help, 0);
  thenValueIs(help.stderr, '');
  thenTextMatches(help.stdout, /^\s*version\s+\S/m);
});
