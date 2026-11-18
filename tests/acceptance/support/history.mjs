import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { thenHookReplies, whenKttyRuns } from './ktty.mjs';
import { thenContains, thenValueIs } from './assertions.mjs';
import { givenAConvergingChange, givenCoverage, givenTheCoverageReport, lcov } from './checks.mjs';
import {
  exists, givenAChangeFile, givenFileContents, whenEventsAreRead, whenFileIsRead, whenGitRuns,
  whenHookRuns, whenPlanIsApproved, whenTurnEnds,
} from './project.mjs';

export const historyDir = '.katatay/state/work';
export const approvalFile = historyDir + '/0001__plan_approved.json';
export const changeFile = 'requirements/changes/20261113T000000.000Z__extra.md';
export const whenPromptRuns = (folder, prompt) => whenHookRuns(folder, 'prompt', { prompt });
export const whenStateIsChecked = (folder, env = {}) => whenKttyRuns(['state', 'verify'], { in: folder, env });
export const whenReportRuns = folder => whenKttyRuns(['report'], { in: folder });
export const whenHistoryIsRead = folder => exists(folder, historyDir)
  ? Object.fromEntries(readdirSync(join(folder.cwd, historyDir)).sort().map(file =>
    [file, whenFileIsRead(folder, historyDir + '/' + file, null)]))
  : {};
export const whenCommitted = (folder, message) => {
  whenGitRuns(folder, 'add', '-A');
  whenGitRuns(folder, 'commit', '-qm', message);
  return whenGitRuns(folder, 'rev-parse', 'HEAD');
};
export function givenAnApproval(folder) {
  const run = whenPlanIsApproved(folder);
  thenValueIs(thenHookReplies(run, 0).recorded, true);
}
export function givenAVerification(folder) {
  givenAConvergingChange(folder);
  const run = whenTurnEnds(folder);
  const reply = thenHookReplies(run, 0);
  thenContains(reply.messages.map(message => message.code), 'verified');
}
export function givenADeclaration(folder) {
  givenAVerification(folder);
  const run = whenPromptRuns(folder, 'record');
  thenValueIs(thenHookReplies(run, 0).messages[0].code, 'declared');
  return whenEventsAreRead(folder).at(-1);
}
export function givenARecording(folder) {
  const declaration = givenADeclaration(folder);
  givenAChangeFile(folder, changeFile, 'Extra', declaration.payload.summary);
  const run = whenTurnEnds(folder);
  thenValueIs(thenHookReplies(run, 0).messages[0].code, 'recorded');
  return declaration;
}
export function givenUncoveredLine(folder) {
  givenCoverage(folder, { 'src/': { lines: 0, branches: 0 } });
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0 } }]));
}
export function givenCorruptApproval(folder) {
  givenAnApproval(folder);
  givenFileContents(folder, approvalFile, '{"seq":');
}
