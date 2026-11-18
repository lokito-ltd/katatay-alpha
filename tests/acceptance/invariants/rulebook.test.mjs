import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsError } from '../support/ktty.mjs';
import {
  exists, givenAProject, givenAWorkingBranch, givenFileContents, givenRulebookChanges, rulebookPath,
  whenACommandIsProposed, whenAWriteIsProposed, whenInitRuns, whenPlanIsApproved, whenTriageRuns, whenTurnEnds,
} from '../support/project.mjs';
import { thenContains, thenHookAnswers, thenValueIs } from '../support/assertions.mjs';
import { codesOf } from '../support/checks.mjs';

const locked = { allow: false, messages: [{ code: 'locked', for: 'agent' }] };
const allowed = { allow: true, messages: [] };

it('An edit to .katatay/rulebook.json is denied as locked in every phase, whatever the rulebook says. [INV0002.1]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.agent.lockedPaths = []; book.highRisk = []; });

  const open = whenAWriteIsProposed(folder, [rulebookPath]);
  thenHookAnswers(open, locked);

  thenHookReplies(whenPlanIsApproved(folder), 0);
  const implementing = whenAWriteIsProposed(folder, [rulebookPath]);
  thenHookAnswers(implementing, locked);

  givenFileContents(folder, 'src/add.sh', 'echo $((2 + 2))\n');
  thenItExits(whenTriageRuns(folder), 0);
  const converging = whenAWriteIsProposed(folder, [rulebookPath]);
  thenHookAnswers(converging, locked);

  thenContains(codesOf(thenHookReplies(whenTurnEnds(folder), 0)), 'verified');
  const verified = whenAWriteIsProposed(folder, [rulebookPath]);
  thenHookAnswers(verified, locked);
});

it('A shell redirect or write verb aimed at the rulebook is denied. [INV0002.2]', () => {
  const folder = givenAWorkingBranch();
  thenHookReplies(whenPlanIsApproved(folder), 0);

  for (const command of [
    'echo {} > .katatay/rulebook.json',
    'echo {} >> .katatay/rulebook.json',
    'cp other.json .katatay/rulebook.json',
    'mv other.json .katatay/rulebook.json',
    'rm .katatay/rulebook.json',
    'echo {} | tee .katatay/rulebook.json',
    'truncate -s 0 .katatay/rulebook.json',
  ]) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, locked);
  }
});

it('Reading the rulebook through the shell is allowed. [INV0002.3]', () => {
  const folder = givenAWorkingBranch();

  for (const command of ['cat .katatay/rulebook.json', 'grep targetBranch .katatay/rulebook.json', 'git diff -- .katatay/rulebook.json']) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, allowed);
  }
});

// A stand-in agent adapter in the project: its defaults lock `.fake/**`, and
// its install answer names the files given here.
function givenAnAdapterInstalling(folder, files) {
  givenFileContents(folder, 'adapter/defaults.mjs', 'process.stdout.write(JSON.stringify(' + JSON.stringify({
    version: 1, locked: ['.fake/**'], plansFolder: 'plans', instructions: 'FAKE.md',
    commands: { check: 'node adapter/check.mjs', install: 'node adapter/install.mjs' },
    registration: { file: '.fake/hooks.json', text: '{}\n', steps: [] },
  }) + '));\n');
  givenFileContents(folder, 'adapter/install.mjs', 'process.stdout.write(JSON.stringify(' + JSON.stringify({
    version: 1, files, registration: { path: '.fake/hooks.json', text: '{}\n' },
  }) + '));\n');
}

it('An adapter install answer naming a locked path is refused. [INV0002.4]', () => {
  const folder = givenAProject();
  givenAnAdapterInstalling(folder, [{ path: 'FAKE.md', text: '# The workflow\n' }, { path: '.katatay/rulebook.json', text: '{}\n' }]);

  const referees = whenInitRuns(folder, ['--agent', 'fake=node adapter/defaults.mjs']);

  thenItExits(referees, 1);
  thenItPrintsError(referees, [
    'init wrote nothing:',
    "- fake: the agent's install command (`node adapter/install.mjs`) gave no answer: its path \".katatay/rulebook.json\" is locked (.katatay/**).",
  ]);
  thenValueIs(exists(folder, rulebookPath), false);
  thenValueIs(exists(folder, 'FAKE.md'), false);
  thenValueIs(exists(folder, '.fake/hooks.json'), false);

  givenAnAdapterInstalling(folder, [{ path: 'FAKE.md', text: '# The workflow\n' }, { path: '.fake/settings.json', text: '{}\n' }]);

  const agents = whenInitRuns(folder, ['--agent', 'fake=node adapter/defaults.mjs']);

  thenItExits(agents, 1);
  thenItPrintsError(agents, [
    'init wrote nothing:',
    "- fake: the agent's install command (`node adapter/install.mjs`) gave no answer: its path \".fake/settings.json\" is locked (.fake/**).",
  ]);
  thenValueIs(exists(folder, rulebookPath), false);
  thenValueIs(exists(folder, 'FAKE.md'), false);
  thenValueIs(exists(folder, '.fake/settings.json'), false);
});
