import { thenHookReplies, whenKttyRuns } from './ktty.mjs';
import { thenValueIs } from './assertions.mjs';
import {
  block, completePlan, givenFileContents, givenTheTargetHolds, planFile, whenFileIsRead, whenPlanIsApproved,
} from './project.mjs';

// A requirement file as the catalogue writes one: frontmatter, the statement
// as the first line of the body, the scenarios, and a Why.
export function requirementText({ status = 'active', statement, scenarios = [], supersededBy }) {
  return [
    '---', 'status: ' + status, ...(supersededBy ? ['supersededBy: ' + supersededBy] : []), '---', '',
    statement, '',
    ...(scenarios.length ? ['## Scenarios', '', ...scenarios.map(line => '- ' + line), ''] : []),
    '## Why', '', 'Because.', '',
  ].join('\n');
}

export function givenARequirement(folder, path, fields, dir = 'requirements') {
  givenFileContents(folder, dir + '/' + path, requirementText(fields));
}

// The catalogue the target holds: written, committed and pushed as the baseline.
export function givenTheTargetCatalogue(folder, files, dir = 'requirements') {
  for (const [path, fields] of Object.entries(files)) givenARequirement(folder, path, fields, dir);
  givenTheTargetHolds(folder, 'Catalogue');
}

// Each entry states a requirement in full, as a change file or a plan's
// requirement-changes block writes it.
const entryLines = (entries, quote) => entries.flatMap(entry => [
  '  - id: ' + entry.id,
  ...(entry.renumberedFrom ? ['    renumberedFrom: ' + entry.renumberedFrom] : []),
  '    status: ' + entry.status,
  '    statement: ' + quote(entry.statement),
  ...(entry.scenarios?.length ? ['    scenarios:', ...entry.scenarios.map(line => '      - ' + quote(line))] : []),
]);

// A change file whose frontmatter records the given requirements.
export function givenAChangeFileRecording(folder, name, entries, prose = 'Nothing else.', dir = 'requirements') {
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  const yaml = entries.length === 0 ? [] : ['requirements:', ...entryLines(entries, quote)];
  givenFileContents(folder, dir + '/changes/' + name, [
    '---', ...yaml, '---', '', '# Change', '', '## Report', '', '```text', 'summary', '```', '',
    prose, '', '## Departures', '', 'None.', '',
  ].join('\n'));
}

// The plan the operator approves, its closing block listing the requirements
// as they will read. An empty list approves a plan with no requirement changes.
export function givenAnApprovedPlanStating(folder, entries) {
  const changes = entries.length === 0 ? 'No requirement changes.\n'
    : block(['requirement-changes:', ...entryLines(entries, JSON.stringify)].join('\n'));
  givenFileContents(folder, planFile, completePlan + changes);
  const run = whenPlanIsApproved(folder);
  thenValueIs(thenHookReplies(run, 0).recorded, true);
}

export const whenReqRuns = (folder, args, env = {}) => whenKttyRuns(['req', ...args], { in: folder, env });
export const whenRequirementIsRead = (folder, path, dir = 'requirements') => whenFileIsRead(folder, dir + '/' + path);
