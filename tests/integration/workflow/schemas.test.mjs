import { expect, it } from 'vitest';
import { thenHookReplies, whenKttyRuns, thenItExits } from '../../acceptance/support/ktty.mjs';
import {
  rulebookPath,
  planFile,
  completePlan,
  givenAWorkingBranch,
  givenAChangeFile,
  givenAProject,
  givenFileContents,
  givenRulebookChanges,
  whenInitRuns,
  whenJsonIsRead,
  whenHookRuns,
  whenEventsAreRead,
  whenGitRuns,
  whenPlanIsApproved,
  whenTriageRuns,
  whenTurnEnds,
  whenFileIsRead,
} from '../../acceptance/support/project.mjs';
import {
  coverageOutput,
  givenAConvergingChange,
  givenCoverage,
  givenMutation,
  givenTheCoverageReport,
  givenTheMutationAnswer,
  lcov,
  mutationReport,
  whenChecksAnalysisIsSubmitted,
} from '../../acceptance/support/checks.mjs';
import { thenValueIs } from '../../acceptance/support/assertions.mjs';
import {
  changeFile, givenAnApproval, givenUncoveredLine, givenAVerification, whenPromptRuns,
} from '../../acceptance/support/history.mjs';
import { givenAPublisher, whenTargetAdvances } from '../../acceptance/support/remote.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import matter from 'gray-matter';
import {
  givenAChangeFileRecording, givenARequirement, givenTheTargetCatalogue, whenReqRuns,
} from '../../acceptance/support/requirements.mjs';

// Resolve every reference against the installation selected by KTTY_BIN.
// No schemas or decision functions are imported from the checkout.
function givenSchemas(installation) {
  const dir = join(installation, 'src');
  const ajv = new Ajv2020({ strict: false });
  for (const file of [
    'agents/contract.json',
    'schemas/rulebook.schema.json',
    'schemas/plan-approved.schema.json',
    'schemas/triaged.schema.json',
    'schemas/triage-refused.schema.json',
    'schemas/verified.schema.json',
    'schemas/verify-failed.schema.json',
    'schemas/checks-analysis.schema.json',
    'schemas/check-result.schema.json',
    'schemas/change-report.schema.json',
    'schemas/record-held.schema.json',
    'schemas/declared.schema.json',
    'schemas/recorded.schema.json',
    'schemas/baseline-moved.schema.json',
    'schemas/reset.schema.json',
    'schemas/hooks.schema.json',
    'schemas/requirement.schema.json',
    'schemas/change-file.schema.json',
  ]) {
    const uri = pathToFileURL(join(dir, file)).href;
    const schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    ajv.addSchema({ ...schema, $id: uri }, uri);
  }
  return (name, definition) =>
    ajv.getSchema(
      pathToFileURL(join(dir, 'schemas', name + '.schema.json')).href +
        (definition ? '#/$defs/' + definition : ''),
    );
}

function thenSchemaAccepts(validate, document, expected) {
  const valid = validate(document);
  expect(valid, JSON.stringify(validate.errors)).toBe(expected);
}

it('validates the rulebook written by init against its shipped schema', () => {
  const folder = givenAProject();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  const book = whenJsonIsRead(folder, rulebookPath);
  const valid = schema('rulebook');
  thenSchemaAccepts(valid, book, true);
  for (const changed of [
    { ...book, version: '1' },
    { ...book, targetBranch: 'main' },
    { ...book, tests: { ...book.tests, extra: 1 } },
    { ...book, plans: { validateFormat: 'yes' } },
  ])
    thenSchemaAccepts(valid, changed, false);
});

it('validates first and revised approval events and rejects a working-file path or broken envelope', () => {
  const folder = givenAWorkingBranch();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());

  const approvalRun = whenPlanIsApproved(folder);
  const approval = thenHookReplies(approvalRun, 0);
  thenValueIs(approval.recorded, true);
  givenFileContents(folder, planFile, completePlan + 'Revision.\n');

  const revisedApprovalRun = whenPlanIsApproved(folder);
  const revisedApproval = thenHookReplies(revisedApprovalRun, 0);
  thenValueIs(revisedApproval.recorded, true);
  const [first, revision] = whenEventsAreRead(folder);
  const valid = schema('plan-approved');
  for (const event of [first, revision]) thenSchemaAccepts(valid, event, true);
  for (const changed of [
    { ...first, payload: { ...first.payload, planFile } },
    { ...first, payload: { ...first.payload, proposal: 'abc' } },
    { ...revision, branch: 'work' },
    { ...revision, prev: null },
    { ...first, event: 'triaged' },
  ])
    thenSchemaAccepts(valid, changed, false);
});

it('validates the actual hook exchanges by their named request and answer schemas', () => {
  const folder = givenAWorkingBranch();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());
  const pairs = [
    ['Write', 'write', { writes: [{ path: 'src/add.sh', delete: false }], command: null }],
    ['Prompt', 'prompt', { prompt: 'status' }],
    ['PlanPresented', 'plan-presented', { planFile }],
    ['PlanApproved', 'plan-approved', { planFile }],
    ['TurnEnd', 'turn-end', { stopRefusedBefore: false, secondsLeft: 60 }],
  ];
  for (const [name, hook, fields] of pairs) {
    const request = { version: 1, ...fields };

    const answerRun = whenHookRuns(folder, hook, fields);
    const answer = thenHookReplies(answerRun, 0);
    for (const [kind, doc] of [
      ['Request', request],
      ['Answer', answer],
    ]) {
      const valid = schema('hooks', name + kind);
      thenSchemaAccepts(valid, doc, true);
      thenSchemaAccepts(valid, { ...doc, version: 2 }, false);
      thenSchemaAccepts(valid, { ...doc, extra: true }, false);
    }
  }
  for (const adapter of ['claude', 'codex']) {
    for (const [action, fields] of [
      ['defaults', {}],
      ['install', { instructions: 'Project instructions.', skills: [], plansFolder: 'plans' }],
      ['check', { root: folder.cwd, extraHooks: { acknowledged: [] } }],
    ]) {
      const request = { version: 1, ...fields };

      const run = whenKttyRuns(['agent', adapter, action], { in: folder, input: JSON.stringify(request) });
      thenItExits(run, 0);
      const name = action[0].toUpperCase() + action.slice(1);
      for (const [kind, doc] of [
        ['Request', request],
        ['Answer', JSON.parse(run.stdout)],
      ]) {
        const valid = schema('hooks', name + kind);
        thenSchemaAccepts(valid, doc, true);
        thenSchemaAccepts(valid, { ...doc, version: 2 }, false);
      }
    }
  }
});

it('validates recorded and refused triage events and rejects a wrong reason, a missing field or an extra one', () => {
  const folder = givenAWorkingBranch();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());

  const approval = thenHookReplies(whenPlanIsApproved(folder), 0);
  thenValueIs(approval.recorded, true);
  givenFileContents(folder, 'tests/add.sh', 'true\n');
  thenItExits(whenTriageRuns(folder), 1);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4\n');
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');
  thenItExits(whenTriageRuns(folder), 0);
  givenFileContents(folder, 'src/add.sh', 'echo 6\n');
  thenItExits(whenTriageRuns(folder), 1);
  const [, modified, triaged, changed] = whenEventsAreRead(folder);

  const refusal = schema('triage-refused');
  for (const event of [modified, changed]) thenSchemaAccepts(refusal, event, true);
  for (const wrong of [
    { ...modified, payload: { reason: 'tests_modified' } },
    { ...modified, payload: { ...modified.payload, reason: 'something_else' } },
    { ...changed, payload: { ...changed.payload, files: ['src/add.sh'] } },
    { ...changed, event: 'triaged' },
  ])
    thenSchemaAccepts(refusal, wrong, false);

  const report = schema('triaged');
  thenSchemaAccepts(report, triaged, true);
  for (const wrong of [
    { ...triaged, payload: { ...triaged.payload, level: 'LOW' } },
    { ...triaged, payload: { ...triaged.payload, evidence: [] } },
    { ...triaged, payload: { ...triaged.payload, extra: true } },
    { ...triaged, payload: { ...triaged.payload, implemented: undefined } },
  ])
    thenSchemaAccepts(report, wrong, false);
});

it('validates failed and passing verifications, the checks analysis and the coverage document, and rejects a failed result on a pass', () => {
  const folder = givenAWorkingBranch();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());

  givenRulebookChanges(folder, book => { book.checks.requireAnalysis = true; });
  givenCoverage(folder);
  givenMutation(folder);
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 0, 2: 1 } }]));
  givenTheMutationAnswer(folder, { text: '1 mutant: 0 caught, 1 survived.', exit: 1, report: mutationReport(['Survived']) });
  givenAConvergingChange(folder, 'echo 5\n');
  thenHookReplies(whenTurnEnds(folder), 0);
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 5\n');
  const request = thenHookReplies(whenTurnEnds(folder), 0).messages.find(message => message.code === 'info').text;
  // Each heading the request lists, followed by the fields its kind asks for.
  const fieldsFor = { Coverage: ['Scenario: run add.', 'Assert: it prints 5.'], Variant: ['Scenario: run add.', 'Assert: it prints 5.'],
    Check: ['Finding: none.', 'Action: none.'], Limit: ['Impact: not measured.'], Mutants: [] };
  const headings = request.split('each on its own line:\n')[1].split('\n\n')[0].split('\n');
  const analysis = ['Summary: Add the missing test.', ...headings.flatMap(heading => [heading, ...fieldsFor[heading.split(' ')[0]]]), ''].join('\n');
  thenItExits(whenChecksAnalysisIsSubmitted(folder, ['4'], analysis), 0);
  const [, , failed, verified, checksAnalysis] = whenEventsAreRead(folder);

  const failure = schema('verify-failed');
  thenSchemaAccepts(failure, failed, true);
  for (const wrong of [
    { ...failed, payload: { ...failed.payload, tail: undefined } },
    { ...failed, payload: { ...failed.payload, results: [] } },
    { ...failed, event: 'verified' },
  ])
    thenSchemaAccepts(failure, wrong, false);

  const pass = schema('verified');
  thenSchemaAccepts(pass, verified, true);
  const withFailure = verified.payload.results.map(result => result.name === 'tests' ? { ...result, status: 'failed', reason: 'A test failed.' } : result);
  for (const wrong of [
    { ...verified, payload: { ...verified.payload, results: withFailure } },
    { ...verified, payload: { ...verified.payload, testFingerprint: undefined } },
    { ...verified, payload: { ...verified.payload, trigger: 'hook' } },
  ])
    thenSchemaAccepts(pass, wrong, false);

  const submitted = schema('checks-analysis');
  thenSchemaAccepts(submitted, checksAnalysis, true);
  for (const wrong of [
    { ...checksAnalysis, payload: { ...checksAnalysis.payload, summary: '' } },
    { ...checksAnalysis, payload: { ...checksAnalysis.payload, analysisSnapshot: 'analysis.txt' } },
  ])
    thenSchemaAccepts(submitted, wrong, false);

  const document = schema('check-result');
  const coverage = whenJsonIsRead(folder, coverageOutput);
  thenSchemaAccepts(document, coverage, true);
  for (const wrong of [
    { ...coverage, measurement: undefined },
    { ...coverage, result: { ...coverage.result, outcome: 'fine' } },
  ])
    thenSchemaAccepts(document, wrong, false);
});

it('validates the saved report and the events on a held, declared, recorded and reset change', () => {
  const folder = givenAWorkingBranch();
  const installation = whenKttyRuns(['path'], { in: folder });
  thenItExits(installation, 0);
  const schema = givenSchemas(installation.stdout.trimEnd());
  givenUncoveredLine(folder);
  givenAVerification(folder);

  for (const [name, eventName] of [['record-held', 'record_held'], ['declared', 'declared']]) {
    const record = whenPromptRuns(folder, 'record');
    thenHookReplies(record, 0);
    const event = whenEventsAreRead(folder).at(-1);
    thenValueIs(event.event, eventName);
    const valid = schema(name);
    thenSchemaAccepts(valid, event, true);
    for (const payload of [
      { ...event.payload, gaps: undefined },
      { ...event.payload, gaps: { uncoveredLines: -1 } },
      { ...event.payload, gaps: { uncaughtMutants: 0.5 } },
      { ...event.payload, changeReportSnapshot: 'reports/local.json' },
    ]) thenSchemaAccepts(valid, { ...event, payload }, false);
    thenSchemaAccepts(valid, { ...event, event: 'recorded' }, false);
    const saved = whenJsonIsRead(folder, event.payload.changeReportSnapshot);
    const validReport = schema('change-report');
    thenSchemaAccepts(validReport, saved, true);
    for (const report of [
      { ...saved, decision: 'recorded' }, { ...saved, summary: ['one\ntwo'] },
      { ...saved, lines: ['', '  '] }, { ...saved, summary: [] }, { ...saved, gaps: null },
    ]) thenSchemaAccepts(validReport, report, false);
    if (eventName === 'declared') {
      thenSchemaAccepts(valid, { ...event, payload: { ...event.payload, summary: ['a\nb'] } }, false);
      givenAChangeFile(folder, changeFile, 'Extra', event.payload.summary);
    }
  }

  const turn = whenTurnEnds(folder);
  thenHookReplies(turn, 0);
  const recorded = whenEventsAreRead(folder).at(-1);
  thenSchemaAccepts(schema('recorded'), recorded, true);
  thenSchemaAccepts(schema('recorded'), { ...recorded, payload: { ...recorded.payload, files: [] } }, false);
  thenSchemaAccepts(schema('recorded'), { ...recorded, payload: { ...recorded.payload, changes: 'wrong' } }, false);

  const reset = whenPromptRuns(folder, 'reset');
  thenHookReplies(reset, 0);
  const abandoned = whenEventsAreRead(folder).at(-1);
  thenSchemaAccepts(schema('reset'), abandoned, true);
  thenSchemaAccepts(schema('reset'), { ...abandoned, payload: { note: null, changeFiles: [] } }, false);
});

it('validates a baseline move and a reset as the first event of a logbook', () => {
  const folder = givenAWorkingBranch();
  const installation = whenKttyRuns(['path'], { in: folder });
  thenItExits(installation, 0);
  const schema = givenSchemas(installation.stdout.trimEnd());
  const reset = whenPromptRuns(folder, 'reset');
  thenHookReplies(reset, 0);
  const [first] = whenEventsAreRead(folder);
  thenSchemaAccepts(schema('reset'), first, true);
  thenSchemaAccepts(schema('reset'), { ...first, branch: undefined }, false);

  givenAnApproval(folder);
  const publisher = givenAPublisher(folder);
  const tip = whenTargetAdvances(publisher, 'upstream.txt', 'work');
  whenGitRuns(folder, 'fetch', 'origin');
  whenGitRuns(folder, 'merge', '--ff-only', tip);
  const prompt = whenPromptRuns(folder, 'status');
  thenHookReplies(prompt, 0);
  const moved = whenEventsAreRead(folder).at(-1);
  thenSchemaAccepts(schema('baseline-moved'), moved, true);
  thenSchemaAccepts(schema('baseline-moved'), { ...moved, payload: { to: tip } }, false);
  thenSchemaAccepts(schema('baseline-moved'), { ...moved, payload: { ...moved.payload, from: 'HEAD' } }, false);
  thenSchemaAccepts(schema('baseline-moved'), { ...moved, prev: null }, false);
});

it('validates the frontmatter of a catalogue and a change file the guard accepts, and rejects malformed counterparts', () => {
  const folder = givenAWorkingBranch();

  const path = whenKttyRuns(['path'], { in: folder });
  thenItExits(path, 0);
  const schema = givenSchemas(path.stdout.trimEnd());

  givenTheTargetCatalogue(folder, {
    'acceptance/AC0001__cancel.md': { status: 'accepted', statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] },
    'invariants/INV0001__total.md': { statement: 'A paid total never changes.' },
    'invariants/INV0002__old.md': { status: 'superseded', supersededBy: 'INV0001', statement: 'Totals are fixed.' },
  });
  const promoted = { id: 'AC0001', status: 'active', statement: 'Orders can be cancelled.', scenarios: ['[AC0001.1] Cancelled.'] };
  givenARequirement(folder, 'acceptance/AC0001__cancel.md', promoted);
  givenAChangeFileRecording(folder, '20261113T000000.000Z__promote.md', [promoted]);
  thenItExits(whenReqRuns(folder, ['lint']), 0);
  thenItExits(whenReqRuns(folder, ['guard']), 0);

  const requirement = schema('requirement');
  const frontmatter = file => matter(whenFileIsRead(folder, file)).data;
  for (const file of ['acceptance/AC0001__cancel.md', 'invariants/INV0001__total.md', 'invariants/INV0002__old.md']) {
    thenSchemaAccepts(requirement, frontmatter('requirements/' + file), true);
  }
  for (const changed of [{ status: 'done' }, {}, { status: 'active', supersededBy: 'INV0001' }, { status: 'superseded' }]) {
    thenSchemaAccepts(requirement, changed, false);
  }
  const changeFile = schema('change-file');
  thenSchemaAccepts(changeFile, frontmatter('requirements/changes/20261113T000000.000Z__promote.md'), true);
  const { statement, ...withoutStatement } = promoted;
  for (const entry of [withoutStatement, { ...promoted, status: 'done' }, { ...promoted, id: 'AC1' }, { ...promoted, scenarios: ['Cancelled.'] }]) {
    thenSchemaAccepts(changeFile, { requirements: [entry] }, false);
  }
  thenValueIs(statement, 'Orders can be cancelled.');
});
