import { it } from 'vitest';
import { thenHookReplies, thenItExits, thenItPrintsError, whenKttyRuns } from '../support/ktty.mjs';
import {
  completePlan, givenAWorkingBranch, whenFileIsRead, givenFileContents, givenRulebookChanges, planFile, whenEventsAreRead,
  whenAWriteIsProposed, whenACommandIsProposed, whenHookRuns, whenPlanIsApproved,
} from '../support/project.mjs';
import {
  thenContains, thenEventNamesEqual, thenObjectIncludes, thenTextMatches, thenValueIs, thenValuesEqual,
} from '../support/assertions.mjs';
import { whenPromptRuns } from '../support/history.mjs';

const whenMomentReads = (folder, moment, input) =>
  whenKttyRuns(['on', moment], { in: folder, input: typeof input === 'string' ? input : JSON.stringify(input) });
const codes = answer => answer.messages.map(message => message.code + '/' + message.for);

it('A request missing a required field exits 2 with one sentence naming the field. [AC0066.1]', () => {
  const folder = givenAWorkingBranch();

  const turnEnd = whenMomentReads(folder, 'turn-end', { version: 1, stopRefusedBefore: false });
  thenItExits(turnEnd, 2);
  thenItPrintsError(turnEnd, ['on turn-end: refused, `secondsLeft` must be number, and is missing.']);

  const write = whenMomentReads(folder, 'write', { version: 1, command: null });
  thenItExits(write, 2);
  thenItPrintsError(write, ['on write: refused, `writes` must be list of { path, delete }, and is missing.']);
});

it('A request with a missing version, or another version, exits 2 on every moment. [AC0066.2]', () => {
  const folder = givenAWorkingBranch();
  const requests = {
    write: { writes: [], command: 'ls' },
    prompt: { prompt: 'hello' },
    'plan-presented': { planFile },
    'plan-approved': { planFile },
    'turn-end': { stopRefusedBefore: false, secondsLeft: 900 },
  };

  for (const [moment, request] of Object.entries(requests)) {
    const none = whenMomentReads(folder, moment, request);
    thenItExits(none, 2);
    thenItPrintsError(none, [`on ${moment}: refused, \`version\` must be 1, and is missing.`]);
    const two = whenMomentReads(folder, moment, { version: 2, ...request });
    thenItExits(two, 2);
    thenItPrintsError(two, [`on ${moment}: refused, \`version\` must be 1, and is 2.`]);
  }
});

it('A refused request records nothing. [AC0066.3]', () => {
  const folder = givenAWorkingBranch();

  const wrongType = whenMomentReads(folder, 'plan-approved', { version: 1, planFile: 7 });
  thenItExits(wrongType, 2);
  const wrongVersion = whenMomentReads(folder, 'plan-approved', { version: 2, planFile });
  thenItExits(wrongVersion, 2);
  const notJson = whenMomentReads(folder, 'prompt', 'record');
  thenItExits(notJson, 2);

  thenValuesEqual(whenEventsAreRead(folder), []);
});

it('The last message of every prompt answer is the state. [AC0066.4]', () => {
  const folder = givenAWorkingBranch();

  for (const prompt of ['hello', 'record', 'reset']) {
    const run = whenPromptRuns(folder, prompt);
    const answer = thenHookReplies(run, 0);
    thenValuesEqual(Object.keys(answer), ['version', 'messages'], prompt);
    thenObjectIncludes(answer.messages.at(-1), { code: 'state', for: 'agent' });
    thenTextMatches(answer.messages.at(-1).text, /^workflow: open on work/, prompt);
  }
  const approved = whenPlanIsApproved(folder);
  thenHookReplies(approved, 0);
  const run = whenPromptRuns(folder, 'hello');
  const answer = thenHookReplies(run, 0);
  thenObjectIncludes(answer.messages.at(-1), { code: 'state', for: 'agent' });
  thenContains(answer.messages.at(-1).text, 'implementing');
});

it('ktty on write before approval refuses as needing a plan, but allows a file outside the repository and a shell command. [AC0066.5]', () => {
  const folder = givenAWorkingBranch();

  const inside = whenAWriteIsProposed(folder, ['src/add.sh']);
  const refused = thenHookReplies(inside, 0);
  thenObjectIncludes(refused, { version: 1, allow: false });
  thenValuesEqual(codes(refused), ['needs_plan/agent']);
  thenTextMatches(refused.messages[0].text, /^No plan has been approved on this branch/);

  const outside = whenAWriteIsProposed(folder, [folder.env.HOME + '/notes.md']);
  thenValuesEqual(thenHookReplies(outside, 0), { version: 1, allow: true, messages: [] });
  const command = whenACommandIsProposed(folder, 'echo hi > src/add.sh');
  thenValuesEqual(thenHookReplies(command, 0), { version: 1, allow: true, messages: [] });
});

it('ktty on plan-approved reads the plan from the file, not the request, and stops without recording when the file is missing. [AC0066.6]', () => {
  const folder = givenAWorkingBranch();

  const missing = whenHookRuns(folder, 'plan-approved', { planFile: 'plans/absent.md', plan: completePlan });
  const stopped = thenHookReplies(missing, 0);
  thenValueIs(stopped.recorded, false);
  thenValuesEqual(codes(stopped), ['stop/operator']);
  thenContains(stopped.messages[0].text, 'cannot be read (ENOENT). No plan file means no approval');
  thenValuesEqual(whenEventsAreRead(folder), []);

  const present = whenHookRuns(folder, 'plan-approved', { planFile, plan: 'Something else entirely.' });
  thenValueIs(thenHookReplies(present, 0).recorded, true);
  thenEventNamesEqual(folder, ['plan_approved']);
  const [approval] = whenEventsAreRead(folder);
  thenValueIs(whenFileIsRead(folder, approval.payload.planSnapshot), completePlan);
});

it('An answer larger than a pipe buffer reaches the caller whole. [AC0066.7]', () => {
  const folder = givenAWorkingBranch();
  const warning = 'w'.repeat(200 * 1024);
  givenRulebookChanges(folder, book => {
    book.agent.adapters.fixture.checkCommand = `node -e 'process.stdout.write(JSON.stringify({version:1,warnings:["${warning.slice(0, 10)}".repeat(${warning.length / 10})]}))'`;
  });

  const run = whenPromptRuns(folder, 'hello');

  const answer = thenHookReplies(run, 0);
  thenContains(JSON.stringify(answer), warning);
});
