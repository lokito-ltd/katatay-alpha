import { it } from 'vitest';
import { thenHookReplies, thenItExits } from '../support/ktty.mjs';
import {
  block,
  completePlan,
  givenAChangeFile,
  givenAWorkingBranch,
  givenFileContents,
  givenTheTargetHolds,
  givenAPublishedSuite,
  messages,
  planFile,
  whenEventsAreRead,
  whenFileIsRead,
  whenGitRuns,
  whenJsonIsRead,
  whenStateIsShown,
  whenTriageRuns,
  whenTurnEnds,
} from '../support/project.mjs';
import {
  thenContains,
  thenEventNamesEqual,
  thenGitPrints,
  thenHookAnswers,
  thenObjectIncludes,
  thenOmits,
  thenStateShowsPhase,
  thenValueIs,
  thenValuesEqual,
} from '../support/assertions.mjs';
import {
  changeFile,
  givenADeclaration,
  givenARecording,
  givenAVerification,
  givenAnApproval,
  historyDir,
  whenHistoryIsRead,
  whenPromptRuns,
} from '../support/history.mjs';

it("The operator is shown the summary and a Details link to the declared event. [AC0047.1]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const expected = [
    'prediction: exact · protected files: 0 · risk: LOW',
    'AC scenarios: 0 added, 0 reworded, 0 retired',
    'tests: 0 added, 0 modified, 0 removed',
    'follow-ups +0 −0 · code +1 −1 lines',
    'not checked: coverage, mutation',
  ];
  const link = '.katatay/state/work/0004__declared.json';

  const record = whenPromptRuns(folder, 'record');
  const answer = thenHookReplies(record, 0);
  thenObjectIncludes(answer.messages[0], { code: 'declared', for: 'operator' });
  thenContains(answer.messages[0].text, expected.join('\n') + '\n\nDetails: ' + link);
  const event = whenJsonIsRead(folder, link);
  thenValuesEqual(event.payload.summary, expected);
  const saved = whenJsonIsRead(folder, event.payload.changeReportSnapshot);
  thenObjectIncludes(saved, { decision: 'declared', treeFingerprint: event.payload.treeFingerprint, summary: expected });
  const reportSection = ['## Report', '', '```text', ...expected, '```'].join('\n');
  thenContains(answer.messages[0].text, reportSection);
  givenAChangeFile(folder, changeFile, 'Extra', expected);
  const file = whenFileIsRead(folder, changeFile);
  thenContains(file, reportSection);
});

it("A change file whose Report differs from the declared summary is refused, and the change stays declared. [AC0047.2]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', ['Changed headline', ...declaration.payload.summary.slice(1)]);
  const before = whenHistoryIsRead(folder);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: true });
  thenContains(messages(answer), 'differs from the summary the operator declared on');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'declared');

  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const retry = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(retry, 0).messages[0].code, 'recorded');
});

it("A change file with no Report section, a Report section that is not first, or one with no text block is refused. [AC0047.3]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  const summary = declaration.payload.summary.join('\n');
  for (const [section, reason] of [
    ['', 'does not open with a `## Report` section'],
    ['## Why\n\nWhy.\n\n## Report\n\n```text\n' + summary + '\n```', 'does not open with a `## Report` section'],
    ['## Report\n\n' + summary, 'has no text block in its `## Report` section'],
  ]) {
    givenFileContents(folder, changeFile, '---\n---\n\n# Extra\n\n' + section + '\n\n## Departures\n\nNone.\n');

    const turn = whenTurnEnds(folder);
    const answer = thenHookAnswers(turn, { keepWorking: true });
    thenContains(messages(answer), reason);
    thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);
  }
});

it("Only the newest change file is checked against the summary. [AC0047.4]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const older = 'requirements/changes/20261112T000000.000Z__older.md';
  givenAChangeFile(folder, older, 'Older', ['Summary of a different change']);

  const turn = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(turn, 0).messages[0].code, 'recorded');
  const recorded = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(recorded.payload.files, [older, changeFile]);
});

it("A change file written by the agent before record declares nothing. [AC0047.5]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  givenAChangeFile(folder, changeFile, 'Early', ['Premature report']);
  const before = whenHistoryIsRead(folder);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: false });
  thenContains(messages(answer), 'record');
  const after = whenHistoryIsRead(folder);
  thenValuesEqual(after, before);
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'verified');
});

it("A change file without a Departures section is refused, nothing is recorded, and the change stays declared. [AC0048.1]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const valid = whenFileIsRead(folder, changeFile);
  givenFileContents(folder, changeFile, valid.split('## Departures')[0]);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: true });
  thenContains(messages(answer), 'has no `## Departures` section');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);
  thenGitPrints(folder, ['diff', '--cached', '--name-only'], '');
  const shown = whenStateIsShown(folder);
  thenStateShowsPhase(shown, 'declared');
});

it("An empty or whitespace-only Departures section is refused. [AC0048.2]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const valid = whenFileIsRead(folder, changeFile);
  for (const blank of ['', '  \n\t']) {
    givenFileContents(folder, changeFile, valid.replace('None.', blank));

    const turn = whenTurnEnds(folder);
    const answer = thenHookAnswers(turn, { keepWorking: true });
    thenContains(messages(answer), 'has an empty `## Departures` section');
    thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);
  }
});

it("A Departures section that says None. is accepted. [AC0048.3]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const file = whenFileIsRead(folder, changeFile);
  thenContains(file, '## Departures\n\nNone.\n');

  const turn = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(turn, 0).messages[0].code, 'recorded');
  const event = whenEventsAreRead(folder).at(-1);
  thenValuesEqual(event.payload.files, [changeFile]);
});

it("The change walks verified, declared, recorded once the operator types record and the change file passes. [AC0048.4]", () => {
  const folder = givenAWorkingBranch();
  givenAVerification(folder);
  const verified = whenStateIsShown(folder);
  thenStateShowsPhase(verified, 'verified');

  const record = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(record, 0).messages[0].code, 'declared');
  const declared = whenStateIsShown(folder);
  thenStateShowsPhase(declared, 'declared');
  const event = whenEventsAreRead(folder).at(-1);
  givenAChangeFile(folder, changeFile, 'Extra', event.payload.summary);

  const turn = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(turn, 0).messages[0].code, 'recorded');
  const recorded = whenStateIsShown(folder);
  thenStateShowsPhase(recorded, 'recorded');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared', 'recorded']);
});

it("Once recorded, every file is staged, the recorded event included, and the commit message is asked for once. [AC0048.5]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);

  const turn = whenTurnEnds(folder);
  const answer = thenHookAnswers(turn, { keepWorking: true });
  thenObjectIncludes(answer.messages[0], { code: 'recorded', for: 'agent' });
  thenContains(messages(answer), 'Write the commit message now');
  const staged = whenGitRuns(folder, 'diff', '--cached', '--name-only').split('\n');
  thenValuesEqual(staged, [
    historyDir + '/0001__plan_approved.json', historyDir + '/0002__triaged.json',
    historyDir + '/0003__verified.json', historyDir + '/0004__declared.json',
    historyDir + '/0005__recorded.json', changeFile, 'src/add.sh',
  ]);
  thenGitPrints(folder, ['diff', '--name-only'], '');
  thenGitPrints(folder, ['ls-files', '--others', '--exclude-standard'], '');
  for (const stopRefusedBefore of [true, false]) {
    const later = whenTurnEnds(folder, { stopRefusedBefore });
    const reply = thenHookAnswers(later, { keepWorking: false });
    thenOmits(messages(reply), 'Write the commit message');
  }
});

it("Editing a change file after recorded sends the change back to declared. [AC0048.6]", () => {
  const folder = givenAWorkingBranch();
  const declaration = givenARecording(folder);
  givenAChangeFile(folder, changeFile, 'Reworded', declaration.payload.summary);

  const edited = whenStateIsShown(folder);
  thenStateShowsPhase(edited, 'declared');
  const turn = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(turn, 0).messages[0].code, 'recorded');
  const after = whenStateIsShown(folder);
  thenStateShowsPhase(after, 'recorded');
});

it("At record the guard runs in record mode, where only a change file accounts for a requirement change. [AC0048.7]", () => {
  const folder = givenAWorkingBranch();
  const path = 'requirements/invariants/INV0001__valid.md';
  const statement = 'Inputs are valid.';
  const entry = '{id: INV0001, status: active, statement: Inputs are valid.}';
  givenAPublishedSuite(folder, [{ file: 'acceptance/inputs.sh', name: 'Inputs are valid. [INV0001]' }]);
  givenFileContents(folder, path, '---\nstatus: accepted\n---\n\n' + statement + '\n');
  givenTheTargetHolds(folder);
  givenFileContents(folder, planFile, completePlan + block('requirement-changes:\n  - ' + entry));
  givenAnApproval(folder);
  givenFileContents(folder, path, '---\nstatus: active\n---\n\n' + statement + '\n');
  givenFileContents(folder, 'src/extra.sh', 'echo extra\n');
  const triage = whenTriageRuns(folder);
  thenItExits(triage, 0);
  const pass = whenTurnEnds(folder);
  const verification = thenHookReplies(pass, 0);
  thenContains(verification.messages.map(message => message.code), 'verified');
  const record = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(record, 0).messages[0].code, 'declared');
  const declaration = whenEventsAreRead(folder).at(-1);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);

  const refused = whenTurnEnds(folder);
  const reply = thenHookAnswers(refused, { keepWorking: true });
  thenValueIs(reply.messages[0].code, 'change_file');
  thenContains(messages(reply), 'INV0001');
  thenEventNamesEqual(folder, ['plan_approved', 'triaged', 'verified', 'declared']);

  const file = whenFileIsRead(folder, changeFile);
  givenFileContents(folder, changeFile, file.replace('---\n---', '---\nrequirements:\n  - ' + entry + '\n---'));
  const accepted = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(accepted, 0).messages[0].code, 'recorded');
});
