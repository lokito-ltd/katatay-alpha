import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  givenAWorkingBranch,
  givenFileContents,
  messages,
  whenAWriteIsProposed,
  whenEventsAreRead,
  whenFileIsRead,
  whenFileIsRemoved,
  whenJsonIsRead,
  whenPlanIsApproved,
  whenStateIsShown,
} from '../support/project.mjs';
import {
  thenContains,
  thenFileContains,
  thenHookAnswers,
  thenObjectIncludes,
  thenValuesEqual,
} from '../support/assertions.mjs';
import { givenAConvergingChange } from '../support/checks.mjs';
import {
  approvalFile,
  givenAVerification,
  givenAnApproval,
  givenCorruptApproval,
  historyDir,
  whenCommitted,
  whenHistoryIsRead,
  whenPromptRuns,
  whenStateIsChecked,
} from '../support/history.mjs';

it("An event rewritten without updating the event after it makes the phase broken. [AC0053.1]", () => {
  const folder = givenAWorkingBranch();
  givenAConvergingChange(folder);
  const original = whenFileIsRead(folder, approvalFile);
  givenFileContents(folder, approvalFile, original + '\n');

  const shown = whenStateIsShown(folder);
  thenItExits(shown, 1);
  thenContains(shown.stdout, 'phase      broken');
  thenContains(shown.stdout, '0002__triaged.json: does not link to the event before it');
  const write = whenAWriteIsProposed(folder, ['src/add.sh']);
  thenHookAnswers(write, { allow: false });
});

it("An event removed from the middle of the logbook makes the phase broken. [AC0053.2]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  whenFileIsRemoved(folder, historyDir + '/0002__triaged.json');

  const shown = whenStateIsShown(folder);
  thenItExits(shown, 1);
  thenContains(shown.stdout, 'phase      broken');
  thenContains(shown.stdout, '0003__verified.json: claims seq 3, but it is entry 2');
});

it("A committed last event edited in the working tree makes the phase broken, even though the chain still links. [AC0053.3]", () => {
  const folder = givenAWorkingBranch();
  givenAnApproval(folder);
  whenCommitted(folder, 'Witness the event');
  const original = whenFileIsRead(folder, approvalFile);
  givenFileContents(folder, approvalFile, original + '\n');

  const shown = whenStateIsShown(folder);
  thenItExits(shown, 1);
  thenContains(shown.stdout, 'phase      broken');
  thenContains(shown.stdout, approvalFile + ': committed as history, but the working tree disagrees with it');
  const checked = whenStateIsChecked(folder);
  thenItExits(checked, 1);
  thenContains(checked.stderr, approvalFile);
  const write = whenAWriteIsProposed(folder, ['src/add.sh']);
  thenHookAnswers(write, { allow: false });
});

it("An event file with the wrong sequence, truncated JSON, a missing required field or a name that does not match its type makes both state commands exit 1 and name the file. [AC0053.4]", () => {
  for (const [file, alter, cause] of [
    [approvalFile, event => JSON.stringify({ ...event, seq: 2 }), 'claims seq 2, but it is entry 1'],
    [approvalFile, () => '{"seq":', 'is not readable as JSON'],
    [approvalFile, event => JSON.stringify({ ...event, payload: { ...event.payload, baseline: undefined } }), 'baseline is missing'],
    [historyDir + '/0001__reset.json', JSON.stringify, 'does not match its contents'],
  ]) {
    const folder = givenAWorkingBranch();
    givenAnApproval(folder);
    const [event] = whenEventsAreRead(folder);
    whenFileIsRemoved(folder, approvalFile);
    givenFileContents(folder, file, alter(event));

    const shown = whenStateIsShown(folder);
    thenItExits(shown, 1);
    thenContains(shown.stdout, 'phase      broken');
    thenContains(shown.stdout, file.split('/').at(-1) + ':');
    thenContains(shown.stdout, cause);
    const checked = whenStateIsChecked(folder);
    thenItExits(checked, 1);
    thenContains(checked.stderr, file.split('/').at(-1) + ':');
    thenContains(checked.stderr, cause);
    const write = whenAWriteIsProposed(folder, ['src/add.sh']);
    thenHookAnswers(write, { allow: false });
  }
});

it("An event with a missing or unsupported version breaks the logbook, and its bytes are left as they were. [AC0053.5]", () => {
  for (const [version, cause] of [[undefined, 'is missing'], [2, 'has unsupported schema version 2']]) {
    const folder = givenAWorkingBranch();
    givenAConvergingChange(folder);
    const path = historyDir + '/0002__triaged.json';
    const entry = whenJsonIsRead(folder, path);
    const bytes = JSON.stringify({ ...entry, version }) + '\n';
    givenFileContents(folder, path, bytes);

    const shown = whenStateIsShown(folder);
    thenItExits(shown, 1);
    thenContains(shown.stdout, 'phase      broken');
    thenContains(shown.stdout, '0002__triaged.json: event.version ' + cause);
    const checked = whenStateIsChecked(folder);
    thenItExits(checked, 1);
    thenFileContains(folder, path, bytes);
  }
});

it("No approval, record or reset is recorded into a broken logbook. [AC0053.6]", () => {
  const folder = givenAWorkingBranch();
  givenCorruptApproval(folder);
  const before = whenHistoryIsRead(folder);

  const approval = whenPlanIsApproved(folder);
  thenHookAnswers(approval, { recorded: false });
  for (const word of ['record', 'reset']) {
    const prompt = whenPromptRuns(folder, word);
    const answer = thenHookReplies(prompt, 0);
    thenObjectIncludes(answer.messages[0], { code: 'stop', for: 'operator' });
    thenContains(messages(answer), 'chain is broken');
    const after = whenHistoryIsRead(folder);
    thenValuesEqual(after, before);
  }
});
