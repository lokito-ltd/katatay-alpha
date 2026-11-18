import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsLines } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  givenRulebookChanges,
  whenEventsAreRead,
  whenFileIsRead,
  whenGitRuns,
  whenPathIsRemoved,
  whenStateIsShown,
} from '../support/project.mjs';
import {
  thenContains,
  thenFileContains,
  thenLengthIs,
  thenOmits,
  thenStateShowsPhase,
  thenTextDoesNotMatch,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import {
  approvalFile,
  givenARecording,
  givenAnApproval,
  givenCorruptApproval,
  historyDir,
  whenCommitted,
  whenPromptRuns,
  whenStateIsChecked,
} from '../support/history.mjs';
import { whenTargetHistoryIsReplaced } from '../support/remote.mjs';

it("It exits 0 for a sound committed logbook. [AC0054.1]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  const checked = whenStateIsChecked(folder);
  thenItPrintsLines(checked, ['state: .katatay/state/work ok (1 events)']);
  thenItExits(checked, 0);
});

it("It exits 1 for a broken logbook, names the folder and the cause, and prints no stack trace. [AC0054.2]", () => {
  const folder = givenAWorkingBranch();
  givenCorruptApproval(folder);
  const checked = whenStateIsChecked(folder);
  thenItExits(checked, 1);
  thenContains(checked.stderr, historyDir + ': 0001__plan_approved.json: is not readable as JSON');
  thenTextDoesNotMatch(checked.stderr, /^\s*at /m);
});

it("It exits 1 when a committed logbook folder was deleted whole. [AC0054.3]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  whenPathIsRemoved(folder, historyDir);

  const checked = whenStateIsChecked(folder);
  thenItExits(checked, 1);
  thenContains(checked.stderr, approvalFile + ': committed as history, but the working tree disagrees with it');
});

it("It exits 1 for a baseline that is not on the target, unless a later recorded event vouches for it. [AC0054.4]", () => {
  for (const recorded of [false, true]) {
    const folder = givenAWorkingBranch();
    if (recorded) givenARecording(folder);
    else givenAnApproval(folder);
    const pinned = whenEventsAreRead(folder)[0].payload.baseline;
    whenTargetHistoryIsReplaced(folder);

    const checked = whenStateIsChecked(folder);
    if (recorded) {
      thenItExits(checked, 0);
      thenValueIs(checked.stderr, '');
    } else {
      thenItExits(checked, 1);
      thenContains(checked.stderr, 'baseline ' + pinned + ' is not on origin/main');
    }
  }
});

it("It prints a warning for each missing workflow hook and still exits 0. [AC0054.5]", () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => {
    book.agent.adapters = { claude: { checkCommand: 'ktty agent claude check' } };
  });
  givenFileContents(folder, '.claude/rules/workflow.md', 'Workflow instructions');

  const checked = whenStateIsChecked(folder);
  thenItExits(checked, 0);
  thenContains(checked.stderr, 'no .claude/settings.json');
  for (const hook of ['pre-tool.mjs', 'user-prompt.mjs', 'post-tool.mjs', 'turn-end.mjs']) {
    const warnings = checked.stderr.split('\n').filter(line => line.includes(hook));
    thenLengthIs(warnings, 1, hook);
    thenContains(warnings[0], 'WARNING');
  }
});

it("It prints the phase as broken and the offending file, and exits 1, for a broken logbook. [AC0055.1]", () => {
  const folder = givenAWorkingBranch();
  givenCorruptApproval(folder);

  const shown = whenStateIsShown(folder);
  thenItExits(shown, 1);
  thenContains(shown.stdout, 'phase      broken');
  thenContains(shown.stdout, '0001__plan_approved.json: is not readable as JSON');
  thenValueIs(shown.stderr, '');
});

it("It reports an uncommitted logbook as unprotected, not as empty. [AC0055.2]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'implementing');
  thenContains(shown.stdout, 'logbook    .katatay/state/work (1 event)');
  thenContains(shown.stdout, 'saved      not committed yet');
  thenContains(shown.stdout, 'none are committed yet — deleting them now would leave no trace');
});

it("It reports a committed logbook as held against git. [AC0055.3]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  const short = whenGitRuns(folder, 'rev-parse', '--short', 'HEAD');

  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'implementing');
  thenContains(shown.stdout, 'saved      committed at ' + short + ' — git would notice if any were changed or deleted');
  thenOmits(shown.stdout, 'WARNING');
});

it("It tells a deleted logbook apart from one that never started. [AC0055.4]", () => {
  const folder = givenAWorkingBranch();
  const fresh = whenStateIsShown(folder);
  thenStateShowsPhase(fresh, 'open');
  thenContains(fresh.stdout, '(0 events)');
  thenOmits(fresh.stdout, 'WARNING');

  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  whenPathIsRemoved(folder, historyDir);
  const deleted = whenStateIsShown(folder);
  thenItExits(deleted, 1);
  thenContains(deleted.stdout, 'phase      broken');
  thenContains(deleted.stdout, '1 event(s) are committed but missing from the logbook');
});

it("It says how many of its events the target already holds, and only when some are. [AC0055.5]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Save event');
  const before = whenStateIsShown(folder);
  thenTextDoesNotMatch(before.stdout, /^merged /m);

  whenGitRuns(folder, 'push', 'origin', 'HEAD:main');
  const merged = whenStateIsShown(folder);
  thenContains(merged.stdout, 'merged     1 of them already in origin/main — a finished change.');
  givenAnApproval(folder);
  const partial = whenStateIsShown(folder);
  thenContains(partial.stdout, 'merged     1 of them already in origin/main — a finished change, so they grant nothing. The rest are this one.');
});

it("It shows no approved plan after a reset, even while the old snapshot can still be read. [AC0055.6]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  const [approval] = whenEventsAreRead(folder);
  const path = approval.payload.planSnapshot;
  const original = whenFileIsRead(folder, path);
  const before = whenStateIsShown(folder);
  thenContains(before.stdout, path);

  const reset = whenPromptRuns(folder, 'reset');
  thenHookReplies(reset, 0);
  const after = whenStateIsShown(folder);
  thenStateShowsPhase(after, 'open');
  thenOmits(after.stdout, path);
  thenTextDoesNotMatch(after.stdout, /^permitted /m);
  thenFileContains(folder, path, original);
});

it("It names each agent whose extra-hook check is switched off. [AC0055.7]", () => {
  const folder = givenAWorkingBranch();
  givenRulebookChanges(folder, book => {
    const { checkCommand } = book.agent.adapters.fixture;
    book.agent.adapters = {
      first: { checkCommand, extraHooks: { check: false } },
      second: { checkCommand },
      third: { checkCommand, extraHooks: { check: false } },
    };
  });

  const shown = whenStateIsShown(folder);
  thenItExits(shown, 0);
  const notes = shown.stdout.split('\n').filter(line => line.startsWith('NOTE'));
  thenValuesEqual(notes.map(line => line.split(':')[0].trim()), ['NOTE       first', 'NOTE       third']);
  thenContains(notes[0], 'agent.adapters.first.extraHooks.check');
  thenContains(notes[1], 'agent.adapters.third.extraHooks.check');
});
