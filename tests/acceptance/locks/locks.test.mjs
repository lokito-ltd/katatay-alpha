import { it } from 'vitest';
import { dirname, join } from 'node:path';
import { thenHookReplies } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenAFolder,
  givenASymbolicLink,
  givenFileContents,
  givenRulebookChanges,
  rulebookPath,
  whenACommandIsProposed,
  whenAWriteIsProposed,
  whenPlanIsApproved,
  whenStateIsShown,
} from '../support/project.mjs';
import { thenContains, thenHookAnswers, thenStateShowsPhase, thenStderrContains, thenValueIs } from '../support/assertions.mjs';

const locked = { allow: false, messages: [{ code: 'locked', for: 'agent' }] };
const allowed = { allow: true, messages: [] };
const shellDenial = '(This shell command appears to modify a locked path.)';

function givenAnApprovedPlan(folder) {
  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, true);
}

it('Editing a logbook event, the rulebook, or .git/config is denied as locked. [AC0019.1]', () => {
  const folder = givenAWorkingBranch();
  const paths = ['.katatay/state/work/0001__plan_approved.json', rulebookPath, '.git/config'];

  for (const path of paths) thenHookAnswers(whenAWriteIsProposed(folder, [path]), locked);

  givenAnApprovedPlan(folder);

  for (const path of paths) thenHookAnswers(whenAWriteIsProposed(folder, [path]), locked);
});

it('Neighbouring paths such as .gitignore, .githooks/ and .katatayx/ are not locked. [AC0019.2]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  for (const path of ['.gitignore', '.githooks/pre-commit', '.katatayx/notes.md', '.git-blame-ignore-revs']) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, allowed);
  }
});

it('A shell redirect into .katatay/state/ and rm -rf .git are denied. [AC0019.3]', () => {
  const folder = givenAWorkingBranch();

  for (const command of ['echo {} > .katatay/state/work/0002__triaged.json', 'rm -rf .git']) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, locked);
  }
});

it('These locks still apply when the rulebook cannot be read. [AC0019.4]', () => {
  const folder = givenAWorkingBranch();
  givenFileContents(folder, rulebookPath, 'not a rulebook');

  thenHookAnswers(whenAWriteIsProposed(folder, ['.katatay/state/work/0001__plan_approved.json']), locked);
  thenHookAnswers(whenAWriteIsProposed(folder, ['.git/config']), locked);
  thenHookAnswers(whenACommandIsProposed(folder, 'rm -rf .git'), locked);
});

it('Entries relative to the repository, under ~/, or absolute are each locked. [AC0020.1]', () => {
  const folder = givenAWorkingBranch();
  const shared = join(dirname(folder.cwd), 'shared');
  givenRulebookChanges(folder, book => { book.agent.lockedPaths = ['private/**', '~/agent/settings.json', shared + '/**']; });

  for (const path of ['private/key.json', join(folder.env.HOME, 'agent/settings.json'), join(shared, 'config.json')]) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, locked);
  }
});

it('With a plan approved, editing a locked agent settings file is still denied, inside the repository and out. [AC0020.2]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { book.agent.lockedPaths = ['.agent/settings.json', '~/.agent/settings.json']; });
  givenAnApprovedPlan(folder);

  thenHookAnswers(whenAWriteIsProposed(folder, ['.agent/settings.json']), locked);
  thenHookAnswers(whenAWriteIsProposed(folder, [join(folder.env.HOME, '.agent/settings.json')]), locked);
});

it('A file a relative entry does not name, or one outside its base, is not locked. [AC0020.3]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  for (const path of ['privateer/key.json', 'src/private/key.json', join(folder.env.HOME, 'private/key.json')]) {
    const run = whenAWriteIsProposed(folder, [path]);

    thenHookAnswers(run, allowed);
  }
});

it('A call that writes several files is denied whole when any one of them is locked. [AC0020.4]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  const writeRun = whenAWriteIsProposed(folder, ['src/add.sh', 'private/key.json']);
  thenHookAnswers(writeRun, locked);

  const deleteRun = whenAWriteIsProposed(folder, ['src/add.sh'], ['private/old.json']);
  thenHookAnswers(deleteRun, locked);
});

it('A symlink into a locked folder is judged by the folder it leads to. [AC0020.5]', () => {
  const folder = givenAWorkingBranch();
  givenAFolder(folder, 'private');
  givenASymbolicLink(folder, 'shortcut', 'private');
  givenAnApprovedPlan(folder);

  const run = whenAWriteIsProposed(folder, ['shortcut/key.json']);

  thenHookAnswers(run, locked);
});

it('agent.lockedPaths is required whenever there is an agent section, and an empty list is valid. [AC0020.6]', () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => { delete book.agent.lockedPaths; });

  const refused = whenStateIsShown(folder);
  thenValueIs(refused.status, 1);
  thenStderrContains(refused, '"agent.lockedPaths" must be a list');

  givenRulebookChanges(folder, book => { book.agent.lockedPaths = []; });

  const accepted = whenStateIsShown(folder);
  thenStateShowsPhase(accepted, 'open');
});

it('A redirect that lands on a locked path is denied. [AC0021.1]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  for (const command of ['echo x > private/key.json', 'echo x >> private/key.json', 'sh src/add.sh 2> private/log']) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, locked);
  }
});

it('A write verb such as rm, mv, cp, tee or truncate in the same segment as a locked path is denied. [AC0021.2]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  for (const command of [
    'rm private/key.json',
    'mv src/add.sh private/key.json',
    'cp src/add.sh private/key.json',
    'echo x | tee private/key.json',
    'truncate -s 0 private/key.json',
  ]) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, locked);
  }
});

it('A command that only reads a locked path is allowed. [AC0021.3]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  for (const command of ['cat private/key.json', 'grep secret private/key.json', 'ls .katatay/state', 'git -C .git log']) {
    const run = whenACommandIsProposed(folder, command);

    thenHookAnswers(run, allowed);
  }
});

it('A heredoc body is read as content, not as a command. [AC0021.4]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  const run = whenACommandIsProposed(folder, "cat > notes.md <<'EOF'\nrm -rf .git\necho x > private/key.json\nEOF");

  thenHookAnswers(run, allowed);
});

it('Each segment of a compound command is judged on its own. [AC0021.5]', () => {
  const folder = givenAWorkingBranch();
  givenAnApprovedPlan(folder);

  thenHookAnswers(whenACommandIsProposed(folder, 'cat private/key.json; echo done > out.txt'), allowed);
  thenHookAnswers(whenACommandIsProposed(folder, 'cat private/key.json && echo done > out.txt'), allowed);
  thenHookAnswers(whenACommandIsProposed(folder, 'echo done > out.txt; rm private/key.json'), locked);
  thenHookAnswers(whenACommandIsProposed(folder, 'ls private || echo x > private/key.json'), locked);
});

it('A shell denial says the command appears to modify a locked path. [AC0021.6]', () => {
  const folder = givenAWorkingBranch();

  const run = whenACommandIsProposed(folder, 'rm private/key.json');

  const answer = thenHookAnswers(run, locked);
  thenContains(answer.messages[0].text, shellDenial);
});

it('A shell command that touches no lock runs before any plan is approved. [AC0021.7]', () => {
  const folder = givenAWorkingBranch();

  const run = whenACommandIsProposed(folder, 'echo 5 > src/add.sh');

  thenHookAnswers(run, allowed);
});
